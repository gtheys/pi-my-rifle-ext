// AIDEV-NOTE: Flow run-state journal (PMR follow-up, ported from
// pi-workflows' "durable run state" idea). Aven labels stay the gate source
// of truth; this journal is the *evidence record* — append-only JSONL events
// plus a current-state projection, written under
// getAgentDir()/pi-flow/runs/<ref>.json (+ .journal.jsonl).
// The Herdr flow viewer renders the projection WITHOUT touching aven.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AnswerChoice } from './aven/client.ts'
import { isFullSha, sha256Hex } from './validate/gate-target.ts'

// AIDEV-NOTE: PMR-Z2K7 — 'research' left the flow lifecycle (PIV); old
// journals containing research phases fail isFlowRunState and are rebuilt
// from the journal, whose unknown events are simply ignored by projection.
export type FlowPhase = 'plan' | 'implement' | 'validate' | 'feedback'

// AIDEV-NOTE: PMR-6EEW gate integrity — journal event kinds for pinned gate
// targets and the decisions that cite them. gate-target is recorded when a
// gate spawns (pin at spawn); gate-decision when its verdict is accepted,
// rejected or invalidated (echo missing / target mismatch / stale).
export type GateJournalKind =
  | 'review'
  | 'deviation'
  | 'code-review'
  | 'spec-review'

export type GateDecisionStatus =
  | 'pass'
  | 'fail'
  | 'echo-missing'
  | 'target-mismatch'
  | 'stale'

// AIDEV-NOTE: PMR-4S6V — command receipts: one per COMMITTED gate
// transition; duplicates adopt the stored receipt instead of repeating the
// transition. BEST-EFFORT by design: missing/corrupt/torn receipts degrade
// to label checks + suite re-run; aven labels stay the gate of record.
// AIDEV-NOTE: PMR-2HFC/PMR-XTQQ — the flow_run_attempt budget WAS
// non-durable (PMR-2HFC); it is durable as of PMR-XTQQ 4.2: the loop-level
// blockerRetries budget is durable since phase 2 (loop-state snapshots +
// resume seeding) and the attempt ledger is durable since 4.2 —
// tools/run-attempt.ts reads/journals attempt-record events (the projection
// half landed in phase 4) through the writer seam.
// AIDEV-NOTE: PMR-XTQQ 5.1 — 'code_review' joins the receipt commands: the
// code_review tool records a headSha-pinned receipt after a HUMAN pass, the
// durable twin of LandingState.humanReviewPassed (flow_land adoption is 5.2).
// AIDEV-NOTE: PMR-CD46 — 'spec_approve' joins the receipt commands: the
// spec_approve tool records a target='plan' receipt after a successful
// approval and adopts it on duplicate calls (single-use dedup).
export type ReceiptCommand =
  | 'flow_land'
  | 'flow_phase_complete'
  | 'code_review'
  | 'spec_approve'

const RECEIPT_COMMANDS: readonly ReceiptCommand[] = [
  'flow_land',
  'flow_phase_complete',
  'code_review',
  'spec_approve',
]

// AIDEV-NOTE: PMR-VDVJ — kinds of side-effecting actions that must declare
// themselves in the run journal BEFORE they may run (see effect-declaration).
export type EffectKind =
  | 'merge-main'
  | 'git-push'
  | 'gh-pr-create'
  | 'worktree-create'
  | 'worktree-remove'
  | 'workspace-close'

// Exported for flow/effect-gate.ts (PMR-VDVJ phase 2) to mirror the union.
export const EFFECT_KINDS: readonly EffectKind[] = [
  'merge-main',
  'git-push',
  'gh-pr-create',
  'worktree-create',
  'worktree-remove',
  'workspace-close',
]

export interface CommandReceiptRecord {
  command: ReceiptCommand
  target: string
  headSha?: string
  status: 'ok'
  at: string
}

// AIDEV-NOTE: PMR-VDVJ — one per declared side-effecting action, idempotent
// by effectId (deterministic hash of ref|effect|command|headSha).
export interface EffectDeclarationRecord {
  effect: EffectKind
  effectId: string
  command: string
  recipe: string[]
  headSha?: string
  at: string
}

export type FlowRunEvent =
  | {
      kind: 'run-start'
      at: string
      ref: string
      mode: 'work' | 'personal'
      /** Ref the run is tracked by (Jira key in work mode); absent = `ref`. */
      trackRef?: string
    }
  | {
      kind: 'phase-start'
      at: string
      ref: string
      phase: FlowPhase
    }
  | {
      kind: 'phase-complete'
      at: string
      ref: string
      phase: FlowPhase
      label: string
    }
  | {
      kind: 'gate-target'
      at: string
      ref: string
      gate: GateJournalKind
      targetId: string
      baseSha: string
      headSha: string
      diffSha256: string
    }
  | {
      kind: 'gate-decision'
      at: string
      ref: string
      gate: GateJournalKind
      targetId: string
      status: GateDecisionStatus
    }
  | {
      /**
       * AIDEV-NOTE: PMR-4S6V — command receipt: one per COMMITTED gate
       * transition. The flow_run_attempt ledger projection landed in phase 4
       * (attempt-record kind + `attempts` projection); the tool-side durable
       * ledger (tools/run-attempt.ts) landed in PMR-XTQQ 4.2.
       */
      kind: 'command-receipt'
      at: string
      ref: string
      command: ReceiptCommand
      /** Phase name for flow_phase_complete; route ('pr' | 'merge-main') for flow_land. */
      target: string
      /** Worktree HEAD when the transition committed; flow_land adopts only on an exact match. */
      headSha?: string
      status: 'ok'
    }
  | {
      /** AIDEV-NOTE: PMR-6EEW per-subtask ranges — subtask → commits map */
      kind: 'subtask-ranges'
      at: string
      ref: string
      gate: GateJournalKind
      baseSha: string
      headSha: string
      bySubtask: Array<{ subtask: string; commits: string[] }>
      unattributed: string[]
    }
  | {
      /**
       * AIDEV-NOTE: PMR-R5VB — a human's raw gate answer (approve/reject/
       * pass/fail) recorded journal-only by index.ts's journalOnly helper.
       * The projection keeps the LATEST answer per gate. Journal kinds the
       * reader doesn't know are ignored by design (PMR-Z2K7): old readers
       * skip 'gate-answer' and new readers replay old journals fine.
       */
      kind: 'gate-answer'
      at: string
      ref: string
      gate: Extract<GateJournalKind, 'spec-review' | 'code-review'>
      choice: AnswerChoice
    }
  | {
      /**
       * AIDEV-NOTE: main-session cost attribution — the main pi session file
       * active when a phase started. /flow-cost splits this file's usage
       * across phases by journal timestamps (workers are attributed via
       * their spawn notes; the main session was never counted before).
       */
      kind: 'main-session'
      at: string
      ref: string
      sessionFile: string
    }
  | {
      /**
       * AIDEV-NOTE: PMR-C998 — journal-only spawn evidence. Carries the
       * SpawnRecord fields needed by /flow-cost and the flow viewer to
       * attribute child-worker cost. The field is named `spawnKind` (not
       * `kind`) so it does not clash with the event-kind discriminant.
       * Deliberately NO `phase` field: phase annotation stays read-time
       * (derived from journal timestamps by the single derivation path shared
       * by both sources), never write-time. Journal-only like 'main-session'
       * — see isJournalOnlyEvent.
       */
      kind: 'spawn-record'
      at: string
      ref: string
      childId: string
      name: string
      spawnKind: 'spawn' | 'resume' | 'reattach'
      subtask?: string
      sessionFile?: string
    }
  | {
      /**
       * AIDEV-NOTE: PMR-C998 — journal-only append-only step evidence
       * (submissions), flattened StepOutputEventPayload fields. Never
       * deduped (each submission is evidence) and never projected
       * (advisory-only; old readers ignore unknown kinds — PMR-Z2K7).
       * `headShaVerified` is journaled verification state: surfaced to
       * consumers, never silently accepted as truth.
       */
      kind: 'step-output'
      at: string
      ref: string
      phase: FlowPhase
      step: string
      ok?: boolean
      detail?: string
      planPath?: string
      subtaskRefs?: string[]
      command?: string
      passed?: boolean
      headSha?: string
      headShaVerified?: boolean
      prNumber?: number
      prUrl?: string
      gateTargetIds?: string[]
      prMerged?: boolean
    }
  | {
      kind: 'note'
      at: string
      ref: string
      text: string
    }
  | {
      /**
       * AIDEV-NOTE: PMR-YG2N durable sweep marker — one per worktree removed
       * or skipped by the sweep. `source` records who wrote it ('flow-done'
       * from the flow-done path, 'sweep' from the manual sweep command).
       * Terminal outcomes ('removed'/'noop') let a later sweep skip the ref;
       * 'kept-all'/'deferred' are retried later. Fail-closed: sweep runs only
       * when the journal says every merged worktree was already handled.
       */
      kind: 'worktree-sweep'
      at: string
      ref: string
      source: 'flow-done' | 'sweep'
      outcome: 'removed' | 'noop' | 'kept-all' | 'deferred'
      detail?: string
    }
  | {
      /**
       * AIDEV-NOTE: durable run server — serializable prompt-input subset
       * ({ mode, gitRoot, workRoots }); labels are re-derived live and
       * findTicketRef/epicHasOpenChildren are rebuilt closures, never
       * serialized. Last-wins in the projection.
       */
      kind: 'run-input'
      at: string
      ref: string
      input: RunInputRecord
    }
  | {
      /** AIDEV-NOTE: durable run server — loop snapshot; last-wins. */
      kind: 'loop-state'
      at: string
      ref: string
      loop: LoopStateRecord
    }
  | {
      /**
       * AIDEV-NOTE: PMR-XTQQ durable attempt ledger — post-transition
       * snapshot of the flow_run_attempt budget; last-wins per ref.
       * `outcome: 'passed'` resets the projection `attempts` to 0;
       * 'retry'/'escalate' carry the post-transition count. Journal-only
       * consumers (e.g. the flow viewer) skip unknown kinds, so this stays
       * forward-compatible.
       */
      kind: 'attempt-record'
      at: string
      ref: string
      tool: 'flow_run_attempt'
      outcome: 'passed' | 'retry' | 'escalate'
      attempts: number
    }
  | {
      /**
       * AIDEV-NOTE: PMR-VDVJ — effect declaration: journaled BEFORE a
       * side-effecting action may run (push / pr create / merge-main /
       * worktree create / remove). Carries the recovery recipe so undo
       * steps are journal-readable. Journal-only + STRICT: unlike receipts,
       * a failed declaration write refuses the effect (fail-closed by
       * design — this gate never degrades to prompt).
       */
      kind: 'effect-declaration'
      at: string
      ref: string
      effect: EffectKind
      effectId: string
      command: string
      recipe: string[]
      headSha?: string
    }

/**
 * AIDEV-NOTE: PMR-C998 — event kinds that are journaled but never projected.
 * recordRunEvent appends these without a read-modify-write of the projection
 * (see the shipped 'main-session' drop bug noted there). Extend this union
 * only; isJournalOnlyEvent is the single membership check. 'step-output'
 * joined via PMR-C998 phase 2 (step submissions are append-only evidence).
 */
type JournalOnlyKind = 'main-session' | 'spawn-record' | 'step-output'

export function isJournalOnlyEvent(event: FlowRunEvent): boolean {
  const kinds: JournalOnlyKind[] = [
    'main-session',
    'spawn-record',
    'step-output',
  ]
  return kinds.some((k) => k === event.kind)
}
export interface RunInputRecord {
  mode: 'work' | 'personal'
  gitRoot: string
  workRoots: string[]
}

export type LoopRunStatus = 'running' | 'paused' | 'halted' | 'done'

export interface LoopStateRecord {
  phase: FlowPhase
  awaitingOutcome: boolean
  blockerRetries: number
  validateStartedAt: string
  status: LoopRunStatus
}

export interface GateTargetRecord {
  targetId: string
  gate: GateJournalKind
  baseSha: string
  headSha: string
  diffSha256: string
  at: string
}

export interface GateDecisionRecord {
  targetId: string
  gate: GateJournalKind
  status: GateDecisionStatus
  at: string
}

export type FlowRunState = {
  schema: 'gtheys.pi-flow.run.v1'
  ref: string
  mode: 'work' | 'personal'
  startedAt: string
  updatedAt: string
  completedPhases: FlowPhase[]
  currentPhase: FlowPhase | null
  notes: { at: string; text: string }[]
  // AIDEV-NOTE: PMR-6EEW — optional so pre-gate-integrity projections (and
  // journals rebuilt without gate events) stay valid.
  gateTargets?: GateTargetRecord[]
  gateDecisions?: GateDecisionRecord[]
  subtaskRanges?: SubtaskRangesRecord[]
  // AIDEV-NOTE: PMR-4S6V — optional so pre-receipt projections (and old
  // journals rebuilt without command-receipt events) stay valid.
  receipts?: CommandReceiptRecord[]
  // AIDEV-NOTE: PMR-VDVJ — optional so pre-effect-declaration projections
  // (and old journals rebuilt without effect-declaration events) stay valid.
  effectDeclarations?: EffectDeclarationRecord[]
  // AIDEV-NOTE: durable run server — optional so pre-input/loop projections
  // (and old journals rebuilt without these events) stay valid.
  input?: RunInputRecord
  loop?: LoopStateRecord
  // AIDEV-NOTE: PMR-XTQQ — optional so pre-attempt-ledger projections (and
  // old journals rebuilt without attempt-record events) stay valid.
  attempts?: number
  gateAnswers?: GateAnswerRecord[]
}

export interface GateAnswerRecord {
  gate: GateJournalKind
  choice: AnswerChoice
  at: string
}

export interface SubtaskRangesRecord {
  gate: GateJournalKind
  baseSha: string
  headSha: string
  bySubtask: Array<{ subtask: string; commits: string[] }>
  unattributed: string[]
  at: string
}

export function runFileName(ref: string): string | null {
  // Refs are ticket ids (PMR-ABC123 / DP-71). Restrict to a safe filename
  // charset so the ref can never escape the runs dir or add path segments.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ref)) return null
  return `${ref}.json`
}

export function runsDir(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', 'runs')
}

export function runStatePath(agentDir: string, ref: string): string | null {
  const name = runFileName(ref)
  if (name === null) return null
  return path.join(runsDir(agentDir), name)
}

/** Sibling journal path for a run-state file (PMR-WF74 env plumbing source of truth). */
export function journalPathFor(statePath: string): string {
  return `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
}

/** Project the current run state from an ordered event list. Pure. */
export function projectRunState(
  events: readonly FlowRunEvent[],
): FlowRunState | null {
  let state: FlowRunState | null = null
  for (const event of events) {
    state = applyEvent(state, event)
  }
  return state
}

export function applyEvent(
  state: FlowRunState | null,
  event: FlowRunEvent,
): FlowRunState {
  switch (event.kind) {
    case 'run-start': {
      return {
        schema: 'gtheys.pi-flow.run.v1',
        ref: event.ref,
        mode: event.mode,
        startedAt: event.at,
        updatedAt: event.at,
        completedPhases: [],
        currentPhase: null,
        notes: [],
      }
    }
    case 'phase-start': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      if (state.currentPhase === event.phase) return state
      return { ...state, currentPhase: event.phase, updatedAt: event.at }
    }
    case 'phase-complete': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const completed = state.completedPhases.includes(event.phase)
        ? state.completedPhases
        : [...state.completedPhases, event.phase]
      const current =
        state.currentPhase === event.phase ? null : state.currentPhase
      return {
        ...state,
        completedPhases: completed,
        currentPhase: current,
        updatedAt: event.at,
      }
    }
    case 'gate-target': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const targets = state.gateTargets ?? []
      // idempotent by targetId — the same pin re-recorded is a no-op
      if (targets.some((t) => t.targetId === event.targetId)) return state
      return {
        ...state,
        gateTargets: [
          ...targets,
          {
            targetId: event.targetId,
            gate: event.gate,
            baseSha: event.baseSha,
            headSha: event.headSha,
            diffSha256: event.diffSha256,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'gate-decision': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const decisions = state.gateDecisions ?? []
      return {
        ...state,
        gateDecisions: [
          ...decisions,
          {
            targetId: event.targetId,
            gate: event.gate,
            status: event.status,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'subtask-ranges': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        subtaskRanges: [
          ...(state.subtaskRanges ?? []),
          {
            gate: event.gate,
            baseSha: event.baseSha,
            headSha: event.headSha,
            bySubtask: event.bySubtask,
            unattributed: event.unattributed,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'command-receipt': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const receipts = state.receipts ?? []
      // AIDEV-NOTE: PMR-4S6V — idempotent by (command, target); re-recording
      // the same receipt returns the same state so recordRunEvent skips the
      // second journal append.
      if (
        receipts.some(
          (r) => r.command === event.command && r.target === event.target,
        )
      )
        return state
      return {
        ...state,
        receipts: [
          ...receipts,
          {
            command: event.command,
            target: event.target,
            headSha: event.headSha,
            status: event.status,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'effect-declaration': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const effectDeclarations = state.effectDeclarations ?? []
      // AIDEV-NOTE: PMR-VDVJ — idempotent by effectId: re-declaring the
      // same effect (same deterministic id) returns the same state.
      if (effectDeclarations.some((d) => d.effectId === event.effectId))
        return state
      return {
        ...state,
        effectDeclarations: [
          ...effectDeclarations,
          {
            effect: event.effect,
            effectId: event.effectId,
            command: event.command,
            recipe: event.recipe,
            headSha: event.headSha,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'main-session': {
      // evidence for /flow-cost only; the projection stays unchanged
      return state as FlowRunState
    }
    case 'run-input': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        input: event.input,
        updatedAt: event.at,
      }
    }
    case 'loop-state': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        loop: event.loop,
        updatedAt: event.at,
      }
    }
    case 'attempt-record': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      // AIDEV-NOTE: PMR-XTQQ — post-transition snapshot, last-wins. 'passed'
      // resets durably; 'retry'/'escalate' carry the post-transition count.
      let attempts = event.attempts
      if (event.outcome === 'passed') attempts = 0
      return {
        ...state,
        attempts,
        updatedAt: event.at,
      }
    }
    case 'note': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        notes: [...state.notes, { at: event.at, text: event.text }],
        updatedAt: event.at,
      }
    }
    case 'worktree-sweep': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      // AIDEV-NOTE: PMR-YG2N — sweep markers are evidence-only; the
      // projection only keeps updatedAt fresh so replays stay current.
      return {
        ...state,
        updatedAt: event.at,
      }
    }
    case 'gate-answer': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      // AIDEV-NOTE: PMR-R5VB — latest answer wins per gate: later answers for
      // the same gate replace earlier entries instead of appending.
      const answers = (state.gateAnswers ?? []).filter(
        (a) => a.gate !== event.gate,
      )
      return {
        ...state,
        gateAnswers: [
          ...answers,
          { gate: event.gate, choice: event.choice, at: event.at },
        ],
        updatedAt: event.at,
      }
    }
    // AIDEV-NOTE: PMR-Z2K7 — journal lines from a NEWER writer (kinds this
    // reader doesn't know) are ignored rather than crashing replay. Without
    // this default an unknown kind would make applyEvent return undefined and
    // poison every later event in the replay.
    default: {
      return state as FlowRunState
    }
  }
}

const SCHEMA = 'gtheys.pi-flow.run.v1'
const PHASES: readonly FlowPhase[] = [
  'plan',
  'implement',
  'validate',
  'feedback',
]

const GATE_KINDS: readonly GateJournalKind[] = [
  'review',
  'deviation',
  'code-review',
  'spec-review',
]

const LOOP_STATUSES: readonly LoopRunStatus[] = [
  'running',
  'paused',
  'halted',
  'done',
]

const GATE_STATUSES: readonly GateDecisionStatus[] = [
  'pass',
  'fail',
  'echo-missing',
  'target-mismatch',
  'stale',
]

// PMR-MGHQ — runtime mirror of AnswerChoice's members; the annotation is
// compile-checked against the type, so the validator cannot drift from it.
const ANSWER_CHOICES: readonly AnswerChoice[] = [
  'approve',
  'reject',
  'pass',
  'fail',
]

export function isFlowRunState(value: unknown): value is FlowRunState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.schema !== SCHEMA) return false
  if (typeof v.ref !== 'string') return false
  if (v.mode !== 'work' && v.mode !== 'personal') return false
  if (typeof v.startedAt !== 'string') return false
  if (typeof v.updatedAt !== 'string') return false
  if (!Array.isArray(v.completedPhases)) return false
  if (!v.completedPhases.every((p) => PHASES.includes(p as FlowPhase)))
    return false
  const current = v.currentPhase
  if (current !== null && !PHASES.includes(current as FlowPhase)) return false
  if (!Array.isArray(v.notes)) return false
  const notesOk = v.notes.every(
    (n) =>
      typeof n === 'object' &&
      n !== null &&
      typeof (n as Record<string, unknown>).at === 'string' &&
      typeof (n as Record<string, unknown>).text === 'string',
  )
  if (!notesOk) return false
  // AIDEV-NOTE: PMR-6EEW — optional arrays validated only when present.
  if (v.gateTargets !== undefined) {
    if (!Array.isArray(v.gateTargets)) return false
    const targetsOk = v.gateTargets.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Record<string, unknown>).targetId === 'string' &&
        GATE_KINDS.includes(
          (t as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        typeof (t as Record<string, unknown>).baseSha === 'string' &&
        typeof (t as Record<string, unknown>).headSha === 'string' &&
        typeof (t as Record<string, unknown>).diffSha256 === 'string' &&
        typeof (t as Record<string, unknown>).at === 'string',
    )
    if (!targetsOk) return false
  }
  if (v.gateDecisions !== undefined) {
    if (!Array.isArray(v.gateDecisions)) return false
    const decisionsOk = v.gateDecisions.every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as Record<string, unknown>).targetId === 'string' &&
        GATE_KINDS.includes(
          (d as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        GATE_STATUSES.includes(
          (d as Record<string, unknown>).status as GateDecisionStatus,
        ) &&
        typeof (d as Record<string, unknown>).at === 'string',
    )
    if (!decisionsOk) return false
  }
  // AIDEV-NOTE: PMR-6EEW per-subtask ranges — optional, validated when present.
  if (v.subtaskRanges !== undefined) {
    if (!Array.isArray(v.subtaskRanges)) return false
    const rangesOk = v.subtaskRanges.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        GATE_KINDS.includes(
          (r as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        typeof (r as Record<string, unknown>).baseSha === 'string' &&
        typeof (r as Record<string, unknown>).headSha === 'string' &&
        Array.isArray((r as Record<string, unknown>).bySubtask) &&
        Array.isArray((r as Record<string, unknown>).unattributed) &&
        typeof (r as Record<string, unknown>).at === 'string',
    )
    if (!rangesOk) return false
  }
  // AIDEV-NOTE: PMR-6EEW / PMR-MGHQ — gate answers optional, validated when present.
  if (v.gateAnswers !== undefined) {
    if (!Array.isArray(v.gateAnswers)) return false
    const answersOk = v.gateAnswers.every(
      (a) =>
        typeof a === 'object' &&
        a !== null &&
        GATE_KINDS.includes(
          (a as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        ANSWER_CHOICES.includes(
          (a as Record<string, unknown>).choice as AnswerChoice,
        ) &&
        typeof (a as Record<string, unknown>).at === 'string',
    )
    if (!answersOk) return false
  }
  // AIDEV-NOTE: PMR-4S6V — receipts validated only when present (old journals).
  if (v.receipts !== undefined) {
    if (!Array.isArray(v.receipts)) return false
    const receiptsOk = v.receipts.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        RECEIPT_COMMANDS.includes(
          (r as Record<string, unknown>).command as ReceiptCommand,
        ) &&
        typeof (r as Record<string, unknown>).target === 'string' &&
        (r as Record<string, unknown>).status === 'ok' &&
        typeof (r as Record<string, unknown>).at === 'string' &&
        ((r as Record<string, unknown>).headSha === undefined ||
          typeof (r as Record<string, unknown>).headSha === 'string'),
    )
    if (!receiptsOk) return false
  }
  // AIDEV-NOTE: PMR-VDVJ — effect declarations validated only when present
  // (old journals). STRICT consumers depend on this block keeping the same
  // discipline as the receipts block above.
  if (v.effectDeclarations !== undefined) {
    if (!Array.isArray(v.effectDeclarations)) return false
    const declarationsOk = v.effectDeclarations.every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        EFFECT_KINDS.includes(
          (d as Record<string, unknown>).effect as EffectKind,
        ) &&
        typeof (d as Record<string, unknown>).effectId === 'string' &&
        typeof (d as Record<string, unknown>).command === 'string' &&
        Array.isArray((d as Record<string, unknown>).recipe) &&
        ((d as Record<string, unknown>).recipe as unknown[]).length > 0 &&
        ((d as Record<string, unknown>).recipe as unknown[]).every(
          (step) => typeof step === 'string' && step.length > 0,
        ) &&
        typeof (d as Record<string, unknown>).at === 'string' &&
        ((d as Record<string, unknown>).headSha === undefined ||
          typeof (d as Record<string, unknown>).headSha === 'string'),
    )
    if (!declarationsOk) return false
  }
  // AIDEV-NOTE: durable run server — input/loop validated only when present
  // (old journals/projections lack them).
  if (v.input !== undefined) {
    const input = v.input as Record<string, unknown>
    const inputOk =
      typeof input === 'object' &&
      input !== null &&
      (input.mode === 'work' || input.mode === 'personal') &&
      typeof input.gitRoot === 'string' &&
      Array.isArray(input.workRoots) &&
      input.workRoots.every((r) => typeof r === 'string')
    if (!inputOk) return false
  }
  if (v.loop !== undefined) {
    const loop = v.loop as Record<string, unknown>
    const loopOk =
      typeof loop === 'object' &&
      loop !== null &&
      PHASES.includes(loop.phase as FlowPhase) &&
      typeof loop.awaitingOutcome === 'boolean' &&
      typeof loop.blockerRetries === 'number' &&
      typeof loop.validateStartedAt === 'string' &&
      LOOP_STATUSES.includes(loop.status as LoopRunStatus)
    if (!loopOk) return false
  }
  // AIDEV-NOTE: PMR-XTQQ — attempts validated only when present (old journals).
  if (v.attempts !== undefined) {
    if (typeof v.attempts !== 'number') return false
  }
  return true
}

/**
 * Append an event to the journal and rewrite the projection atomically.
 * Best-effort per repo convention: journal failures must never break a flow
 * phase — aven labels remain the gate source of truth.
 */
export async function recordRunEvent(
  agentDir: string,
  event: FlowRunEvent,
  io: {
    readFile: (p: string) => Promise<string>
    appendFile: (p: string, data: string) => Promise<void>
    writeFile: (p: string, data: string) => Promise<void>
    mkdir: (dir: string, recursive: true) => Promise<void>
  } = {
    readFile: (p) =>
      fs.readFile(p, 'utf8').then((text) => {
        if (text === undefined) throw new Error('unreachable')
        return text
      }),
    appendFile: async (p, data) => {
      await fs.appendFile(p, data, 'utf8')
    },
    writeFile: async (p, data) => {
      await fs.writeFile(p, data, 'utf8')
    },
    mkdir: async (dir, recursive) => {
      await fs.mkdir(dir, { recursive })
    },
  },
): Promise<void> {
  const statePath = runStatePath(agentDir, event.ref)
  if (statePath === null) return
  const journalPath = journalPathFor(statePath)
  const dir = path.dirname(statePath)
  await io.mkdir(dir, true)
  let state: FlowRunState | null = null
  try {
    const raw = await io.readFile(statePath)
    const parsed: unknown = JSON.parse(raw)
    if (isFlowRunState(parsed)) state = parsed
  } catch {
    // missing or corrupt projection — rebuild from the journal below
  }
  if (state === null) {
    // Rebuild from the journal so a deleted projection cannot lose history.
    const events: FlowRunEvent[] = []
    try {
      const journal = await io.readFile(journalPath)
      for (const line of journal.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          events.push(JSON.parse(trimmed) as FlowRunEvent)
        } catch {
          // torn tail line — skip
        }
      }
    } catch {
      // no journal yet — start fresh
    }
    state = projectRunState(events)
  }
  // AIDEV-NOTE: PMR-C998 — journal-only kinds append to the journal without
  // touching the projection. 'main-session' is journal-only evidence for
  // /flow-cost — it never changes the projection, so the "unchanged state =
  // nothing to write" shortcut below would silently DROP it (that bug shipped
  // once: no run had a main-session event, so no main-session cost was ever
  // rolled up). Append it to the journal and leave the projection file alone.
  // 'spawn-record' joined in PMR-C998 for the same reason (worker spawn
  // evidence; the projection never models child runs). Keep this as a
  // membership check over JournalOnlyKind — extend the union only.
  if (isJournalOnlyEvent(event)) {
    await io.appendFile(journalPath, `${JSON.stringify(event)}\n`)
    return
  }
  const next = applyEvent(state, event)
  if (next === state) return
  await io.appendFile(journalPath, `${JSON.stringify(event)}\n`)
  await io.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Append an event to the run JOURNAL only — no projection rewrite. For
 * writers that are not the flow's main process (a worker journaling its own
 * nested spawns): the projection is a read-modify-write file and two
 * processes rewriting it can clobber each other, while a one-line O_APPEND to
 * the journal is safe and is all /flow-cost reads. Best-effort like
 * recordRunEvent.
 */
export async function recordRunEventJournalOnly(
  agentDir: string,
  event: FlowRunEvent,
): Promise<void> {
  const statePath = runStatePath(agentDir, event.ref)
  if (statePath === null) return
  const journalPath = journalPathFor(statePath)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  await fs.appendFile(journalPath, `${JSON.stringify(event)}\n`, 'utf8')
}

/** Read a run projection for display. Returns null when no run exists. */
export async function readRunState(
  agentDir: string,
  ref: string,
): Promise<FlowRunState | null> {
  const statePath = runStatePath(agentDir, ref)
  if (statePath === null) return null
  try {
    const raw = await fs.readFile(statePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isFlowRunState(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read a run's journal events in order (PMR-EA8X). The journal is the
 * evidence record — /flow-cost rolls up from these events. Null when the
 * ref is invalid or no journal exists; torn tail lines are skipped.
 */
export async function readRunEvents(
  agentDir: string,
  ref: string,
  io: {
    readFile: (p: string) => Promise<string>
  } = { readFile: (p) => fs.readFile(p, 'utf8') },
): Promise<FlowRunEvent[] | null> {
  const statePath = runStatePath(agentDir, ref)
  if (statePath === null) return null
  const journalPath = journalPathFor(statePath)
  let raw: string
  try {
    raw = await io.readFile(journalPath)
  } catch {
    return null
  }
  const events: FlowRunEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as FlowRunEvent)
    } catch {
      // torn tail line — skip
    }
  }
  return events
}

export interface ReceiptQuery {
  ref: string
  command: ReceiptCommand
  target: string
  /** When set, adopt only if the receipt's headSha matches exactly. */
  headSha?: string
}

/**
 * AIDEV-NOTE: PMR-4S6V — best-effort boundary: find returns null and record
 * swallows errors, so journal failures never block a gate transition.
 */
export interface ReceiptJournal {
  find(query: ReceiptQuery): Promise<CommandReceiptRecord | null>
  record(query: ReceiptQuery): Promise<void>
}

/**
 * AIDEV-NOTE: PMR-4S6V — best-effort receipt access over the run journal.
 * `find` reads via readRunEvents and returns null on missing/corrupt
 * journals; `record` goes through recordRunEvent (projection mutation, not
 * the journal-only route) and swallows io errors.
 */
export function createReceiptJournal(
  agentDir: string,
  io?: {
    readFile: (p: string) => Promise<string>
    appendFile: (p: string, data: string) => Promise<void>
    writeFile: (p: string, data: string) => Promise<void>
    mkdir: (dir: string, recursive: true) => Promise<void>
  },
  // AIDEV-NOTE: PMR-XTQQ — optional mode-aware record fn (server/writer.ts)
  // threaded through registerLandTool/registerPhaseCompleteTool so receipt
  // writes route journal-only while the daemon owns the projection. Absent =
  // today's exact full-writer behavior. Outcome-agnostic: accepts the
  // EventWriter.record boolean (PMR-HRZE) as well as void writers.
  record?: (event: FlowRunEvent) => Promise<void> | Promise<boolean>,
): ReceiptJournal {
  const recordEvent = async (query: ReceiptQuery): Promise<void> => {
    const event: FlowRunEvent = {
      kind: 'command-receipt',
      at: new Date().toISOString(),
      ref: query.ref,
      command: query.command,
      target: query.target,
      status: 'ok',
    }
    if (query.headSha !== undefined) event.headSha = query.headSha
    if (record !== undefined) {
      try {
        await record(event)
      } catch {
        // best-effort — journal failures never block a gate transition
      }
      return
    }
    try {
      await recordRunEvent(agentDir, event, io)
    } catch {
      // best-effort — journal failures never block a gate transition
    }
  }
  const find = async (
    query: ReceiptQuery,
  ): Promise<CommandReceiptRecord | null> => {
    try {
      const events = await readRunEvents(agentDir, query.ref, io)
      if (events === null) return null
      for (const event of events) {
        if (event.kind !== 'command-receipt') continue
        if (event.ref !== query.ref) continue
        if (event.command !== query.command) continue
        if (event.target !== query.target) continue
        if (query.headSha !== undefined && event.headSha !== query.headSha)
          continue
        const receipt: CommandReceiptRecord = {
          command: event.command,
          target: event.target,
          status: event.status,
          at: event.at,
        }
        if (event.headSha !== undefined) receipt.headSha = event.headSha
        return receipt
      }
      return null
    } catch {
      return null
    }
  }
  return { find, record: recordEvent }
}

// AIDEV-NOTE: PMR-VDVJ — deterministic effect id: first 12 hex of sha256
// over 'ref|effect|command|headSha' (headSha absent = empty segment). Same
// input always maps to the same id, which is what makes declare() idempotent.
export function effectDeclarationId(input: {
  ref: string
  effect: EffectKind
  command: string
  headSha?: string
}): string {
  const headSha = input.headSha ?? ''
  return sha256Hex(
    `${input.ref}|${input.effect}|${input.command}|${headSha}`,
  ).slice(0, 12)
}

export interface EffectDeclareInput {
  ref: string
  effect: EffectKind
  command: string
  recipe: string[]
  headSha?: string
}

export type EffectDeclarationResult =
  | { ok: true; record: EffectDeclarationRecord }
  | { ok: false; reason: string }

// AIDEV-NOTE: PMR-VDVJ — THE single validation seam for effect declarations.
// PMR-5ME4: it now lives next to the journal and createEffectJournal().declare()
// runs it on the PRODUCTION write path (it used to be test-only in
// flow/effect-gate.ts, which merely re-exports it now). Validates the ref
// against the runFileName charset (it lands in the runs dir as a filename),
// the effect against the known kinds, command and recipe as non-empty, and
// headSha as a full 40-hex SHA (echo-compare requires exact commits). `now`
// is injected so tests can pin the timestamp.
export function buildEffectDeclaration(
  input: EffectDeclareInput,
  now: () => string = () => new Date().toISOString(),
): EffectDeclarationResult {
  if (runFileName(input.ref) === null) {
    return {
      ok: false,
      reason: `invalid ref "${input.ref}" — must be a safe ticket id (runFileName charset)`,
    }
  }
  if (!EFFECT_KINDS.includes(input.effect)) {
    return {
      ok: false,
      reason: `unknown effect "${String(input.effect)}" — must be one of ${EFFECT_KINDS.join(', ')}`,
    }
  }
  if (input.command.trim().length === 0) {
    return { ok: false, reason: 'command must be a non-empty string' }
  }
  if (!Array.isArray(input.recipe) || input.recipe.length === 0) {
    return { ok: false, reason: 'recipe must have at least 1 step' }
  }
  if (input.recipe.some((step) => step.trim().length === 0)) {
    return { ok: false, reason: 'recipe steps must all be non-empty' }
  }
  if (input.headSha !== undefined && !isFullSha(input.headSha)) {
    return {
      ok: false,
      reason: `headSha "${input.headSha}" must be a full 40-hex SHA`,
    }
  }
  const effectId = effectDeclarationId(input)
  return {
    ok: true,
    record: {
      effect: input.effect,
      effectId,
      command: input.command,
      recipe: input.recipe,
      headSha: input.headSha,
      at: now(),
    },
  }
}

/**
 * AIDEV-NOTE: PMR-VDVJ — STRICT effect journal access, the fail-closed twin
 * of the best-effort ReceiptJournal. declare() must succeed before a
 * side-effecting action may run: an invalid ref is rejected (recordRunEvent
 * JournalOnly would silently no-op, which is fail-open), an append failure is
 * converted to {ok:false} so the caller refuses the effect, and identical
 * re-declarations are idempotent (no second journal line). Journal-only on
 * purpose: O_APPEND is daemon-safe and the projection folds in on the next
 * full write — readers use the journal.
 */
export interface EffectJournal {
  declare(
    input: EffectDeclareInput,
  ): Promise<{ ok: true; effectId: string } | { ok: false; reason: string }>
  find(query: {
    ref: string
    effect: EffectKind
    headSha?: string
  }): Promise<EffectDeclarationRecord | null>
}

export function createEffectJournal(
  agentDir: string,
  io?: {
    readFile: (p: string) => Promise<string>
    appendFile: (p: string, data: string) => Promise<void>
    mkdir: (dir: string, recursive: true) => Promise<void>
  },
): EffectJournal {
  const readFile = io?.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))
  const appendFile =
    io?.appendFile ??
    (async (p: string, data: string) => {
      await fs.appendFile(p, data, 'utf8')
    })
  const mkdir =
    io?.mkdir ??
    (async (dir: string, recursive: true) => {
      await fs.mkdir(dir, { recursive })
    })

  const declare = async (
    input: EffectDeclareInput,
  ): Promise<
    { ok: true; effectId: string } | { ok: false; reason: string }
  > => {
    // AIDEV-NOTE: PMR-5ME4 — validate through buildEffectDeclaration (the
    // single seam) BEFORE any journal work: unknown effect, empty command or
    // recipe, and a non-40-hex headSha are refused here on the production
    // write path, with no journal line appended.
    const built = buildEffectDeclaration(input)
    if (!built.ok) return built
    const statePath = runStatePath(agentDir, input.ref)
    // AIDEV-NOTE: PMR-VDVJ — invalid ref must fail here: the journal-only
    // append would silently no-op and the effect would run undeclared.
    // buildEffectDeclaration normally rejects the same inputs first; this
    // check stays as defense-in-depth against a future runStatePath change
    // silently re-opening that fail-open hole.
    if (statePath === null) {
      return {
        ok: false,
        reason: `invalid run ref, effect declaration refused (fail-closed): ${input.ref}`,
      }
    }
    const journalPath = journalPathFor(statePath)
    // AIDEV-NOTE: PMR-VDVJ fix round — mkdir BEFORE the append, same as
    // recordRunEvent/recordRunEventJournalOnly. Without it a fresh agent dir
    // (no pi-flow/runs/ yet) fails with ENOENT, the fail-closed conversion
    // turns that into {ok:false}, and the gate permanently refuses declared
    // effects until some other writer happens to create the directory.
    try {
      await mkdir(path.dirname(journalPath), true)
    } catch (err) {
      return {
        ok: false,
        reason: `effect declaration could not be recorded in the run journal (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const effectId = built.record.effectId
    // Idempotent: an identical declaration already journaled — do not append.
    const existing = await find({
      ref: input.ref,
      effect: input.effect,
      headSha: input.headSha,
    })
    if (existing !== null && existing.effectId === effectId) {
      return { ok: true, effectId }
    }
    const event: FlowRunEvent = {
      kind: 'effect-declaration',
      at: built.record.at,
      ref: input.ref,
      effect: input.effect,
      effectId,
      command: input.command,
      recipe: input.recipe,
    }
    if (input.headSha !== undefined) event.headSha = input.headSha
    try {
      await appendFile(journalPath, `${JSON.stringify(event)}\n`)
    } catch (err) {
      return {
        ok: false,
        reason: `effect declaration could not be recorded in the run journal (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return { ok: true, effectId }
  }

  const find = async (query: {
    ref: string
    effect: EffectKind
    headSha?: string
  }): Promise<EffectDeclarationRecord | null> => {
    const events = await readRunEvents(agentDir, query.ref, { readFile })
    if (events === null) return null
    for (const event of events) {
      if (event.kind !== 'effect-declaration') continue
      if (event.ref !== query.ref) continue
      if (event.effect !== query.effect) continue
      if (query.headSha !== undefined && event.headSha !== query.headSha)
        continue
      const record: EffectDeclarationRecord = {
        effect: event.effect,
        effectId: event.effectId,
        command: event.command,
        recipe: event.recipe,
        at: event.at,
      }
      if (event.headSha !== undefined) record.headSha = event.headSha
      return record
    }
    return null
  }

  return { declare, find }
}
