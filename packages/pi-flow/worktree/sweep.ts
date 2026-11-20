// AIDEV-NOTE: PMR-YG2N — durable sweep over run-journal refs; labels-done
// gate; fail-closed. Pure helpers live here; the sweep engine itself lands in
// a later slice (sweepMergedFlowWorktrees).

import { existsSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { avenShowFull } from '../aven/client.ts'
import { nextPhase } from '../flow/orchestrate.ts'
import { resumeSeedFromEvents } from '../flow/resume.ts'
import { type FlowWorktree, getFlowWorktree } from '../flow/worktree-context.ts'
import { isValidRef } from '../herdr/viewer.ts'
import type { EffectJournal, FlowRunEvent } from '../run-state.ts'
import {
  latestWorktreeNote,
  matchHerdrWorktree,
} from '../tools/code-review-parse.ts'
import { type HerdrWorktree, worktreeList } from './herdr.ts'
import {
  type CleanupFlowWorktreeSummary,
  cleanupFlowWorktree,
} from './index.ts'

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

// --- resolveDoneWorktree ---

/**
 * AIDEV-NOTE: PMR-YG2N 3.1 — resolve the worktree a finished flow's done
 * branch should clean up: the live /flow binding first (getFlowWorktree),
 * the aven note second (resolveNoteWorktree). undefined = nothing bound.
 * Never throws — the done branch must not block on resolution failure.
 */
export async function resolveDoneWorktree(
  pi: ExtensionAPI,
  cwd: string,
  ref: string,
): Promise<FlowWorktree | undefined> {
  const attached = getFlowWorktree()
  if (attached !== null && attached.ref === ref) {
    return attached
  }
  try {
    const binding = await resolveNoteWorktree(pi, cwd, ref)
    if (binding.kind === 'bound') {
      return binding.worktree
    }
  } catch {
    // never throw from resolution — the caller treats this as unbound
  }
  return undefined
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
    let reason: string
    if (error instanceof Error) {
      reason = error.message
    } else {
      reason = String(error)
    }
    return {
      kind: 'unverifiable',
      reason,
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
      let reason: string
      if (error instanceof Error) {
        reason = error.message
      } else {
        reason = String(error)
      }
      return {
        kind: 'unverifiable',
        reason,
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

// --- sweepMergedFlowWorktrees ---

export interface SweepDeps {
  listRefs: () => Promise<string[]>
  readEvents: (ref: string) => Promise<FlowRunEvent[]>
  appendEvent: (event: FlowRunEvent) => Promise<void>
  readLabels: (ref: string) => Promise<string[] | null>
  annotate: (ref: string, body: string) => Promise<void>
  sessionGitRoot: () => Promise<string | null>
  notify?: (message: string, level: 'info' | 'warning') => void
}

/**
 * AIDEV-NOTE: PMR-YG2N — background sweep engine over run-journal refs.
 * Never-throw by construction: only truly global steps (sessionGitRoot,
 * worktreeList) short-circuit the whole sweep by return — fail-closed; every
 * per-ref fallible step is locally try/caught so one bad ref never rejects
 * the sweep nor poisons the others. Local-only filters (terminal marker,
 * gitRoot match) run before any per-ref aven exec. The labels-done gate
 * below is what makes this sweep safe for in-flight flows: an active loop
 * always carries un-set phase labels, so `nextPhase(labels, mode)` can never
 * return 'done' for a flow that is still running — no active-loop skip-list
 * is needed, and refs failing the gate get no marker so they are retried by
 * a later sweep once they finish.
 */
export async function sweepMergedFlowWorktrees(
  pi: ExtensionAPI,
  effects: EffectJournal,
  cwd: string,
  deps: SweepDeps,
): Promise<void> {
  let sessionRoot: string | null
  try {
    sessionRoot = await deps.sessionGitRoot()
  } catch {
    return
  }
  if (sessionRoot === null) {
    return
  }

  let sharedWorktrees: HerdrWorktree[]
  try {
    // AIDEV-NOTE: fetched once and shared across all refs — no re-list per ref.
    sharedWorktrees = await worktreeList(pi, cwd)
  } catch {
    return
  }
  if (sharedWorktrees.length === 0) {
    // Zero aven execs on an empty herdr state.
    return
  }

  let refs: string[]
  try {
    refs = await deps.listRefs()
  } catch {
    return
  }

  for (const ref of refs) {
    let events: FlowRunEvent[]
    try {
      events = await deps.readEvents(ref)
    } catch {
      continue
    }
    const prior = lastSweepOutcome(events)
    if (prior !== null && isTerminalSweepOutcome(prior.outcome)) {
      continue
    }
    const candidate = sweepCandidateInput(events)
    if (candidate === null) {
      continue
    }
    if (candidate.gitRoot !== sessionRoot) {
      continue
    }

    let labels: string[] | null
    try {
      labels = await deps.readLabels(ref)
    } catch {
      continue
    }
    if (labels === null) {
      // No marker: label-read failure is retried by a later sweep.
      continue
    }
    // AIDEV-NOTE: PMR-YG2N — the labels-done gate. Runs before
    // resolveNoteWorktree and before anything destructive (see note above).
    const phase = nextPhase(labels, candidate.mode)
    if (phase.kind !== 'done') {
      // No marker: not-done refs are retried later.
      continue
    }

    let binding: NoteBinding
    try {
      binding = await resolveNoteWorktree(pi, cwd, ref, sharedWorktrees)
    } catch {
      // No marker: unverifiable refs are retried by a later sweep.
      continue
    }
    if (binding.kind === 'unverifiable') {
      continue
    }
    if (binding.kind === 'none' || binding.kind === 'gone') {
      let detail: string
      if (binding.kind === 'none') {
        detail = 'no recorded worktree note'
      } else {
        // AIDEV-NOTE: PMR-YG2N fix round — 'gone' means the note EXISTS but
        // the worktree it recorded is gone or absent from herdr state; the
        // old wording ('no existing worktree note') was misleading.
        detail = 'recorded worktree gone or absent from herdr'
      }
      try {
        await deps.appendEvent({
          kind: 'worktree-sweep',
          at: new Date().toISOString(),
          ref,
          source: 'sweep',
          outcome: 'noop',
          detail,
        })
      } catch {
        // A failed marker changes nothing else.
      }
      continue
    }

    let summary: CleanupFlowWorktreeSummary
    try {
      summary = await cleanupFlowWorktree(pi, effects, {
        ref,
        mode: candidate.mode,
        worktree: binding.worktree,
        cwd,
        annotate: deps.annotate,
      })
    } catch {
      continue
    }
    try {
      await deps.appendEvent({
        kind: 'worktree-sweep',
        at: new Date().toISOString(),
        ref,
        source: 'sweep',
        outcome: summary.action,
        detail: summary.reason,
      })
    } catch {
      // A failed marker changes nothing else.
    }
    if (summary.action === 'removed' || summary.action === 'kept-all') {
      if (deps.notify !== undefined) {
        let level: 'info' | 'warning'
        let message: string
        if (summary.action === 'removed') {
          level = 'info'
          message = `Sweep: removed flow worktree for ${ref}`
        } else {
          // kept-all means an unmerged worktree was deliberately left in
          // place — worth surfacing as a warning so the user can look.
          level = 'warning'
          message = `Sweep: kept flow worktree for ${ref} (${summary.reason})`
        }
        try {
          deps.notify(message, level)
        } catch {
          // A failed notify changes nothing else.
        }
      }
    }
  }
}
