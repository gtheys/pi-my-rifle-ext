// AIDEV-NOTE: PMR-XTQQ phase 2 — resume seeding from the durable journal.
// Pure tail-reader over readRunEvents output: picks the latest run-input and
// loop-state events for a ref. The seed restores the loop's retry budget and
// the validate blockers-note cutoff EXACTLY (a fresh Date.now() would
// re-narrow the freshness window). Phase position is NEVER seeded here —
// aven labels remain the run state; the loop re-derives it via nextPhase().
// The journaled prompt-input scalars are used only when their gitRoot still
// exists on disk (otherwise the handler rebuilds fresh via commandPhaseInput).
import type {
  FlowRunEvent,
  LoopRunStatus,
  LoopStateRecord,
  RunInputRecord,
} from '../run-state.ts'

export interface FlowResumeSeed {
  /** Restored budget/cutoff; present when the last snapshot was non-terminal. */
  resume?: { blockerRetries: number; validateStartedAt: string }
  /** Journaled prompt-input scalars; present only when gitRoot still exists. */
  input?: RunInputRecord
}

const NON_TERMINAL: readonly LoopRunStatus[] = ['running', 'paused']

export function resumeSeedFromEvents(
  events: FlowRunEvent[] | null,
  gitRootExists: (p: string) => boolean,
): FlowResumeSeed {
  const seed: FlowResumeSeed = {}
  let loop: LoopStateRecord | null = null
  let input: RunInputRecord | null = null
  if (events !== null) {
    for (const event of events) {
      if (event.kind === 'loop-state') loop = event.loop
      if (event.kind === 'run-input') input = event.input
    }
  }
  // AIDEV-NOTE: only non-terminal snapshots seed — a halted/done run must
  // not leak a stale blockers cutoff into a fresh rerun.
  if (loop !== null && NON_TERMINAL.includes(loop.status)) {
    seed.resume = {
      blockerRetries: loop.blockerRetries,
      validateStartedAt: loop.validateStartedAt,
    }
  }
  if (input !== null && gitRootExists(input.gitRoot)) {
    seed.input = input
  }
  return seed
}

export interface JournalablePromptInput {
  mode: 'work' | 'personal'
  gitRoot: string
  workRoots: readonly string[]
}

/**
 * AIDEV-NOTE: PMR-XTQQ 2.2 — the /flow handler's seed override: journaled
 * scalars win over the freshly rebuilt commandPhaseInput result (the gitRoot
 * existence gate already ran in resumeSeedFromEvents, so an override here is
 * safe). Extracted pure so flow.test.ts exercises exactly what the handler
 * merges before it journals run-input.
 */
export function mergeSeedInput<T extends JournalablePromptInput>(
  promptInput: T,
  seed: FlowResumeSeed,
): T {
  if (seed.input === undefined) {
    return promptInput
  }
  return {
    ...promptInput,
    mode: seed.input.mode,
    gitRoot: seed.input.gitRoot,
    workRoots: seed.input.workRoots,
  }
}

/**
 * AIDEV-NOTE: PMR-XTQQ 2.2 — the serializable prompt-input subset the /flow
 * handler journals as a run-input event. Closures and labels (findTicketRef,
 * epicHasOpenChildren, ...) are rebuilt per invocation and never journaled.
 */
export function runInputRecord(
  promptInput: JournalablePromptInput,
): RunInputRecord {
  return {
    mode: promptInput.mode,
    gitRoot: promptInput.gitRoot,
    workRoots: [...promptInput.workRoots],
  }
}
