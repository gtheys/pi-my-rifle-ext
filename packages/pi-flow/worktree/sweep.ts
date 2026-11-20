// AIDEV-NOTE: PMR-YG2N — durable sweep over run-journal refs; labels-done
// gate; fail-closed. Pure helpers live here; the sweep engine itself lands in
// a later slice (sweepMergedFlowWorktrees).

import { resumeSeedFromEvents } from '../flow/resume.ts'
import { isValidRef } from '../herdr/viewer.ts'
import type { FlowRunEvent } from '../run-state.ts'

export type SweepOutcome = 'removed' | 'noop' | 'kept-all' | 'deferred'

/** Terminal sweep outcomes let a later sweep skip the ref entirely. */
export function isTerminalSweepOutcome(outcome: SweepOutcome): boolean {
  if (outcome === 'removed') return true
  if (outcome === 'noop') return true
  return false
}

export interface SweepOutcomePick {
  outcome: SweepOutcome
  source: 'flow-done' | 'sweep'
}

/** Latest worktree-sweep event's outcome+source, or null when none exist. */
export function lastSweepOutcome(
  events: FlowRunEvent[],
): SweepOutcomePick | null {
  let pick: SweepOutcomePick | null = null
  for (const event of events) {
    if (event.kind === 'worktree-sweep') {
      pick = { outcome: event.outcome, source: event.source }
    }
  }
  return pick
}

/**
 * Refs present in a pi-flow runs dir listing: journal/projection suffixes
 * stripped, invalid charsets dropped, deduped, sorted.
 */
export function refsFromRunsDir(names: string[]): string[] {
  const refs = new Set<string>()
  for (const name of names) {
    let candidate: string | null = null
    if (name.endsWith('.journal.jsonl')) {
      candidate = name.slice(0, -'.journal.jsonl'.length)
    } else if (name.endsWith('.json')) {
      candidate = name.slice(0, -'.json'.length)
    }
    if (candidate !== null && isValidRef(candidate)) {
      refs.add(candidate)
    }
  }
  return [...refs].sort()
}

export interface SweepCandidateInput {
  mode: 'work' | 'personal'
  gitRoot: string
}

/**
 * Latest run-input's { mode, gitRoot } from the journal, or null when the
 * journal has none. Reuses resumeSeedFromEvents with an always-true
 * gitRootExists so the pick is identical to the resume path.
 */
export function sweepCandidateInput(
  events: FlowRunEvent[] | null,
): SweepCandidateInput | null {
  const seed = resumeSeedFromEvents(events, () => true)
  if (seed.input === undefined) return null
  return { mode: seed.input.mode, gitRoot: seed.input.gitRoot }
}
