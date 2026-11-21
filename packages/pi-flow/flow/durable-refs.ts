import {
  type FlowRunEvent,
  type FlowRunState,
  type LoopRunStatus,
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
//
// SINGLE-CANDIDATE-ONLY CONSUMPTION RULE: this scan is a *derivation*, not a
// consumption. Callers may only act on the result when exactly one ref
// survives the filters (zero or multiple → notify/refuse, never guess across
// refs — plan PMR-DRKH gotcha 5). This function therefore returns a plain
// sorted list and owns no activation/consumption side effects; only
// consumePending (server/pending.ts) may consume a record.

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
 * Scan <pendingDir> for pending records and return refs that are still
 * live for the given repo: latest journaled input.gitRoot matches and the
 * loop state is non-terminal (running/paused). Parked runs
 * (awaitingOutcome) sort before paused/running. Any candidate whose journal
 * is missing or unreadable is silently skipped; readdir failure yields an
 * empty list — this function never throws.
 */
export async function deriveFlowRefs(deps: DurableRefDeps): Promise<string[]> {
  let names: string[]
  try {
    names = await deps.io.readdir(deps.pendingDir)
  } catch {
    return []
  }

  const parked: string[] = []
  const active: string[] = []
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
    if (isParkedLoop(state.loop)) {
      parked.push(ref)
    } else {
      active.push(ref)
    }
  }
  return [...parked, ...active]
}
