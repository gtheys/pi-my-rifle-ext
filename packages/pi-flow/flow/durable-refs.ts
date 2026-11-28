import {
  type FlowPhase,
  type FlowRunEvent,
  type FlowRunState,
  type LoopRunStatus,
  type OwnerRecord,
  projectRunState,
  runFileName,
} from '../run-state.ts'
import {
  isParkedLoop,
  type PendingIo,
  pendingPaths,
} from '../server/pending.ts'

// AIDEV-NOTE: PMR-DRKH — leaf module for deriving candidate flow refs from
// durable pending-run records (used by binding self-heal / worktree bind).
// All paths and IO are injected; this module must never call getAgentDir()
// itself so tests can run against fakes and consumers control resolution.
// AIDEV-NOTE: PMR-T9ZQ — the scan body is shared (scanRunStates) between
// deriveFlowRefs (plain refs, binding self-heal) and deriveParkedCandidates
// (rich records for the parked-run resume picker). Both mappers keep the
// same base filters (gitRoot match, non-terminal loop) and the same
// parked-first order — the picker and the self-heal have to agree on what
// is live; test/durable-refs-candidates.test.ts pins that equality.
// AIDEV-NOTE: PMR-RRW9 — the two mappers no longer share the FULL filter
// set: deriveFlowRefs additionally drops records owned by a LIVE foreign
// session (owner-scoped adoption, isForeignLiveOwner below), because a
// worktree bind must never adopt another running session's flow. The
// picker deliberately keeps the wider scan — it puts every candidate in
// front of the human with an owner-liveness hint (flow/resume-picker.ts),
// so the human, not the scan, arbitrates there.
//
// DERIVATION-ONLY RULES (PMR-DRKH gotcha 5, consent gate added by PMR-T9ZQ):
// this scan is a *derivation*, never a consumption — only consumePending
// (server/pending.ts) may consume a record. Two consumers, two rules:
// - deriveFlowRefs (worktree bind self-heal) keeps the SINGLE-CANDIDATE
//   rule: zero or multiple → refuse, never guess across refs.
// - deriveParkedCandidates (the resume picker) may NOT act on its own at
//   all: index.ts's askResumeThenArm gate puts every candidate in front of
//   the human and adopts exactly the picked ref. The gate runs strictly
//   BEFORE consumePending, so a declined/headless session never renames a
//   pending record (the old automatic single-candidate takeover is gone).

const NON_TERMINAL: readonly LoopRunStatus[] = ['running', 'paused']

export interface DurableRefDeps {
  pendingDir: string
  io: Pick<PendingIo, 'readdir' | 'readFile'>
  readRunEvents: (
    agentDir: string,
    ref: string,
    io?: { readFile: (p: string) => Promise<string> },
  ) => Promise<FlowRunEvent[] | null>
  agentDir: string
  gitRoot: string
  /**
   * AIDEV-NOTE: PMR-RRW9 — bind-adoption owner filter inputs, consumed by
   * deriveFlowRefs ONLY (deriveParkedCandidates keeps the wide scan).
   * `callerSessionFile` is the calling session's main session file (null
   * when the caller has none); `pidAlive` is the owner-pid liveness probe
   * (production injects ownerPidAlive from flow/resume-picker.ts). Both
   * optional: when `pidAlive` is absent the scan keeps the legacy
   * owner-agnostic behavior (tests and pre-PMR-RRW9 callers).
   * AIDEV-NOTE: PMR-3N9N — `callerPid` is the calling process's own pid,
   * injected at the production seam (this module never reads process.pid
   * itself) so a live owner with a null sessionFile can still be proven
   * to be the caller (headless flows journal no session file). Absent =>
   * fail closed, exactly as before.
   */
  callerSessionFile?: string | null
  callerPid?: number
  pidAlive?: (pid: number) => boolean
}

function isCandidateName(name: string): boolean {
  return name.endsWith('.json') && !name.endsWith('.consumed.json')
}

function keepRef(state: FlowRunState, gitRoot: string): boolean {
  if (state.input === undefined) return false
  if (state.input.gitRoot !== gitRoot) return false
  if (state.loop === undefined) return false
  return NON_TERMINAL.includes(state.loop.status)
}

/**
 * AIDEV-NOTE: PMR-RRW9 — true when the record's journaled owner is a LIVE
 * session that is not provably the caller, so bind adoption must skip it
 * (the PMR-B033 incident: bind adopted a different session's live flow in
 * the same repo). Kept adoptable: records without an owner (pre-owner
 * journals), records whose owner pid is dead (the cross-session restart
 * resume PMR-DRKH/PMR-T9ZQ were built for), and records whose owner
 * sessionFile matches the caller. FAIL-CLOSED: a live owner with no
 * sessionFile (or a caller with none to compare) cannot be proven to be
 * the caller, so it is treated as foreign — with ONE exemption
 * (PMR-3N9N): a live owner whose pid exactly matches the injected
 * `callerPid` IS the caller (headless flows journal no session file, so
 * after a reload in the same process the pid is the only identity left).
 * When no liveness probe is injected the legacy owner-agnostic behavior
 * is preserved.
 */
function isForeignLiveOwner(
  state: FlowRunState,
  deps: DurableRefDeps,
): boolean {
  if (deps.pidAlive === undefined) return false
  const owner = state.owner
  if (owner === undefined) return false
  if (!deps.pidAlive(owner.pid)) return false
  if (owner.sessionFile === null) {
    // AIDEV-NOTE: PMR-3N9N — self-owned headless run: only an EXACT
    // live self-PID match exempts; absent callerPid or any other pid
    // stays fail-closed foreign.
    if (deps.callerPid !== undefined && owner.pid === deps.callerPid) {
      return false
    }
    return true
  }
  return owner.sessionFile !== deps.callerSessionFile
}

/**
 * AIDEV-NOTE: PMR-T9ZQ — one rich record per live candidate run, derived
 * from the same scan as deriveFlowRefs. `phase` is the journaled current
 * phase, `status` the loop status, `updatedAt` the last run-activity stamp
 * (owner refreshes never move it), `owner` is absent for runs journaled
 * before the owner-session event (the picker then renders no liveness
 * hint), and `hasWorktree` reports whether a worktree-create effect was
 * ever declared for the run.
 */
export interface ParkedCandidate {
  ref: string
  phase: FlowPhase | null
  status: LoopRunStatus
  updatedAt: string
  owner?: OwnerRecord
  hasWorktree: boolean
}

// AIDEV-NOTE: PMR-T9ZQ — one scanned live record; `parked` is the
// awaitingOutcome flag the resume picker (flow/resume-picker.ts) labels with,
// and it also decides the parked-first ordering below.
interface ScannedRun {
  ref: string
  state: FlowRunState
  parked: boolean
}

function hasWorktreeDeclared(state: FlowRunState): boolean {
  const declarations = state.effectDeclarations
  if (declarations === undefined) return false
  return declarations.some((d) => d.effect === 'worktree-create')
}

/**
 * Shared scan: pending records that are still live for the given repo
 * (latest journaled input.gitRoot matches, loop status non-terminal).
 * Parked runs (awaitingOutcome) come before paused/running. Missing or
 * unreadable journals are silently skipped; readdir failure yields an empty
 * list — this never throws.
 */
async function scanRunStates(deps: DurableRefDeps): Promise<ScannedRun[]> {
  let names: string[]
  try {
    names = await deps.io.readdir(deps.pendingDir)
  } catch {
    return []
  }

  const parked: ScannedRun[] = []
  const active: ScannedRun[] = []
  for (const name of names) {
    if (!isCandidateName(name)) continue
    const ref = name.slice(0, -'.json'.length)
    // Charset guard via runFileName + pendingPaths: a derived ref must map
    // back to exactly this filename, else it can never be a pending record.
    const paths = pendingPaths(deps.pendingDir, ref)
    if (paths.pendingPath === null) continue
    if (runFileName(ref) !== name) continue

    const events = await deps.readRunEvents(deps.agentDir, ref, {
      readFile: deps.io.readFile,
    })
    if (events === null) continue
    const state = projectRunState(events)
    if (state === null) continue
    if (!keepRef(state, deps.gitRoot)) continue

    // isParkedLoop is typed over LoopStateRecord; project here for the check.
    const entry: ScannedRun = {
      ref,
      state,
      parked: isParkedLoop(state.loop),
    }
    if (entry.parked) {
      parked.push(entry)
    } else {
      active.push(entry)
    }
  }
  return [...parked, ...active]
}

/**
 * Scan <pendingDir> for pending records and return refs that are still
 * live for the given repo: latest journaled input.gitRoot matches and the
 * loop state is non-terminal (running/paused). Parked runs
 * (awaitingOutcome) sort before paused/running. Records owned by a LIVE
 * foreign session are dropped (owner-scoped adoption, PMR-RRW9 — see
 * isForeignLiveOwner; deriveParkedCandidates deliberately does NOT apply
 * this filter). Any candidate whose journal is missing or unreadable is
 * silently skipped; readdir failure yields an empty list — this function
 * never throws.
 */
export async function deriveFlowRefs(deps: DurableRefDeps): Promise<string[]> {
  const entries = await scanRunStates(deps)
  const refs: string[] = []
  for (const entry of entries) {
    if (isForeignLiveOwner(entry.state, deps)) continue
    refs.push(entry.ref)
  }
  return refs
}

/**
 * AIDEV-NOTE: PMR-T9ZQ — rich variant of deriveFlowRefs for the parked-run
 * resume picker: same scan, same base filters and parked-first order, but one
 * ParkedCandidate per ref carrying what the menu label and the owner hint
 * need. Pure derivation (no consumption, no side effects).
 */
export async function deriveParkedCandidates(
  deps: DurableRefDeps,
): Promise<ParkedCandidate[]> {
  const entries = await scanRunStates(deps)
  const candidates: ParkedCandidate[] = []
  for (const entry of entries) {
    const state = entry.state
    // keepRef guarantees a non-terminal loop; the guard keeps that fact in
    // the type system instead of a non-null assertion.
    const loop = state.loop
    if (loop === undefined) continue
    const candidate: ParkedCandidate = {
      ref: entry.ref,
      phase: state.currentPhase,
      status: loop.status,
      updatedAt: state.updatedAt,
      hasWorktree: hasWorktreeDeclared(state),
    }
    if (state.owner !== undefined) candidate.owner = state.owner
    candidates.push(candidate)
  }
  return candidates
}
