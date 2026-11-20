// AIDEV-NOTE: PMR-YG2N — durable sweep over run-journal refs; labels-done
// gate; fail-closed. Pure helpers live here; the sweep engine itself lands in
// a later slice (sweepMergedFlowWorktrees).

import { existsSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { avenShowFull } from '../aven/client.ts'
import { resumeSeedFromEvents } from '../flow/resume.ts'
import type { FlowWorktree } from '../flow/worktree-context.ts'
import { isValidRef } from '../herdr/viewer.ts'
import type { FlowRunEvent } from '../run-state.ts'
import {
  latestWorktreeNote,
  matchHerdrWorktree,
} from '../tools/code-review-parse.ts'
import { type HerdrWorktree, worktreeList } from './herdr.ts'

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

// --- resolveNoteWorktree ---

export type NoteBinding =
  | { kind: 'bound'; worktree: FlowWorktree }
  | { kind: 'gone' }
  | { kind: 'none' }
  | { kind: 'unverifiable'; reason: string }

/**
 * AIDEV-NOTE: PMR-8SFJ — resolve the worktree an aven note recorded for a
 * ref against live herdr state. Never throws: every fallible step (aven
 * show, herdr list) degrades to 'unverifiable'. The bound result's ref is
 * the ticket-read ref and its branch is the herdr-authoritative one, so
 * cleanupFlowWorktree's ref-invariant (worktree.ref === ref) holds by
 * construction.
 */
export async function resolveNoteWorktree(
  pi: ExtensionAPI,
  cwd: string,
  ref: string,
  worktrees?: HerdrWorktree[],
): Promise<NoteBinding> {
  let stdout: string | null = null
  try {
    stdout = await avenShowFull(ref)
  } catch (error: unknown) {
    return {
      kind: 'unverifiable',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (stdout === null) {
    return { kind: 'unverifiable', reason: 'aven show failed' }
  }
  const note = latestWorktreeNote(stdout)
  if (note === null) {
    return { kind: 'none' }
  }
  if (!existsSync(note.path)) {
    return { kind: 'gone' }
  }
  let list: HerdrWorktree[]
  if (worktrees !== undefined) {
    list = worktrees
  } else {
    try {
      list = await worktreeList(pi, cwd)
    } catch (error: unknown) {
      return {
        kind: 'unverifiable',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }
  let found: HerdrWorktree | null = null
  if (note.branch !== null) {
    found = matchHerdrWorktree(list, note.branch)
  } else {
    for (const w of list) {
      if (w.isLinked && w.path === note.path) {
        found = w
        break
      }
    }
  }
  if (found === null) {
    return { kind: 'gone' }
  }
  return {
    kind: 'bound',
    worktree: { ref, path: found.path, branch: found.branch },
  }
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
