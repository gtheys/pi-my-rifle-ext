// AIDEV-NOTE: PMR-T9ZQ 2.2 — pure building blocks for the parked-run RESUME
// picker: the decision table (planResumePickerOutcome), the menu/fallback
// label builders, the age formatter, and the best-effort owner-liveness
// hint. This is the sibling of flow/picker.ts's planTicketPickerOutcome:
// NO ui calls, NO ctx, NO async, NO side effects here — index.ts (phase 3)
// renders `ctx.ui.select` with the options returned below and re-calls the
// planner with the picked option's value as `selection`. Declining must
// therefore be expressible with zero session state change, which it is:
// every plan kind is data.
//
// AIDEV-NOTE: PMR-T9ZQ — ownerPidAlive is a COPIED pattern from
// pi-interactive-subagents assignments.ts:206-214. Cross-package runtime
// imports are forbidden, so it is duplicated here on purpose; keep both
// copies' semantics (ESRCH=dead, EPERM=alive, other=dead) in sync.
// Pid REUSE IS AN ACCEPTED DISPLAY-ONLY RISK (mirrors assignments.ts:64): a
// dead owner's pid may be recycled by an unrelated process, which can make
// the hint read "appears alive" when the owner is gone. Nothing here gates
// on liveness — the hint never blocks, pre-selects, or auto-resumes; the
// human decision is authoritative.

import type { OwnerRecord } from '../run-state.ts'
import type { ParkedCandidate } from './durable-refs.ts'

/** One select row. `value` is the stable id the caller maps back to a
 * candidate (refs for run rows, RESUME_NONE_VALUE for the clean-session
 * row); `label` is the display string handed to ctx.ui.select. */
export interface ResumePickerOption {
  label: string
  value: string
}

/** Sentinel value for the "None — leave this session clean" row: picking it
 * declines, exactly like cancelling the dialog. */
export const RESUME_NONE_VALUE = '__resume-none__'

/** What the caller's select returned. `resume-cancelled` is Esc/abort;
 * `value` is the picked option's value (never a label prefix match). A
 * value that resolves to no candidate is a lookup miss (the list changed
 * between render and pick) and is handled fail-closed. */
export type ResumeSelection =
  | { stage: 'resume-cancelled' }
  | { stage: 'resume-picked'; value: string }

/**
 * What the caller does next. Pure data, one kind per branch:
 * - 'silent': zero candidates — nothing to say, nothing to ask.
 * - 'fallback': headless (or fail-closed after a select throw) — lines the
 *   caller surfaces as info; the session stays clean.
 * - 'menu': render ctx.ui.select with these options.
 * - 'declined': the human said no (or the pick went stale) — no binding,
 *   no heal, no injection; `refs` feeds one info line listing the
 *   recovery command(s).
 * - 'resume': the human consented to this exact candidate — the caller may
 *   now bind/heal/consume.
 */
export type ResumePickerPlan =
  | { kind: 'silent' }
  | { kind: 'fallback'; lines: string[] }
  | { kind: 'menu'; options: ResumePickerOption[] }
  | { kind: 'declined'; refs: string[] }
  | { kind: 'resume'; candidate: ParkedCandidate }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Human age of `atIso` relative to `nowIso`: 'just now' (< 1m), 'Xm ago'
 * (< 1h), 'Xh ago' (< 1d), 'Xd ago' beyond that. A future or unparsable
 * timestamp is never a negative/NaN age: future → 'just now', malformed →
 * 'unknown'.
 */
export function formatAge(nowIso: string, atIso: string): string {
  const nowMs = Date.parse(nowIso)
  const atMs = Date.parse(atIso)
  if (Number.isNaN(nowMs) || Number.isNaN(atMs)) return 'unknown'
  const deltaMs = nowMs - atMs
  if (deltaMs < MINUTE_MS) return 'just now'
  if (deltaMs < HOUR_MS) return `${Math.floor(deltaMs / MINUTE_MS)}m ago`
  if (deltaMs < DAY_MS) return `${Math.floor(deltaMs / HOUR_MS)}h ago`
  return `${Math.floor(deltaMs / DAY_MS)}d ago`
}

function errorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return ''
  const code: unknown = Reflect.get(err, 'code')
  if (typeof code === 'string') return code
  return ''
}

/**
 * Copied liveness probe (see the header AIDEV-NOTE): `process.kill(pid, 0)`
 * performs permission/existence checks without signalling. ESRCH → dead;
 * EPERM → alive (another user's process); success → alive; any other throw
 * (incl. a non-positive pid, which would otherwise mean "signal my own
 * process group") → dead. Display-only: nothing gates on the answer.
 */
export function ownerPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

/** Liveness hint for one owner record: '' when there is no owner at all
 * (pre-owner journals), else the alive/exited wording shown in the menu. */
export function ownerHint(owner: OwnerRecord | undefined): string {
  if (owner === undefined) return ''
  if (ownerPidAlive(owner.pid)) return 'owner session appears alive'
  return 'owner session exited'
}

/** Age reference for a candidate: the owner refresh stamp when present (the
 * run-activity stamp is otherwise the freshest signal the picker has). */
function candidateAgeIso(candidate: ParkedCandidate): string {
  if (candidate.owner === undefined) return candidate.updatedAt
  return candidate.owner.at
}

/** `PMR-X — implement, running, updated 5m ago[, owner session …]` — the
 * shared one-line description behind both the menu label and the fallback
 * line. Pure strings only, so tests can pin the exact text. */
function describeCandidate(candidate: ParkedCandidate, nowIso: string): string {
  // A run before its first phase-start has no phase; the menu still needs
  // a readable row, so null renders as 'none'.
  let phaseText = 'none'
  if (candidate.phase !== null) phaseText = candidate.phase
  const age = formatAge(nowIso, candidateAgeIso(candidate))
  const base = `${candidate.ref} — ${phaseText}, ${candidate.status}, updated ${age}`
  const hint = ownerHint(candidate.owner)
  if (hint === '') return base
  return `${base}, ${hint}`
}

/** One menu row per candidate plus the clean-session row, always last. */
export function buildResumeMenuOptions(
  candidates: readonly ParkedCandidate[],
  nowIso: string,
): ResumePickerOption[] {
  const options: ResumePickerOption[] = []
  for (const candidate of candidates) {
    options.push({
      label: `Resume ${describeCandidate(candidate, nowIso)}`,
      value: candidate.ref,
    })
  }
  options.push({
    label: 'None — leave this session clean',
    value: RESUME_NONE_VALUE,
  })
  return options
}

/** Headless / fail-closed plain-text listing: one line per candidate naming
 * the exact recovery command. The caller surfaces these and binds nothing. */
export function buildResumeFallbackLines(
  candidates: readonly ParkedCandidate[],
  nowIso: string,
): string[] {
  const lines: string[] = []
  for (const candidate of candidates) {
    lines.push(
      `${describeCandidate(candidate, nowIso)} — recover with /flow ${candidate.ref}`,
    )
  }
  return lines
}

function candidateRefs(candidates: readonly ParkedCandidate[]): string[] {
  const refs: string[] = []
  for (const candidate of candidates) {
    refs.push(candidate.ref)
  }
  return refs
}

/**
 * Pure decision table for the parked-run resume picker. Ordering matters
 * and mirrors the incident this guards: no candidates means there is
 * nothing to ask (silent) whatever the UI or selection state; a session
 * without UI never sees a menu (fallback); only a UI session with no
 * selection yet gets the menu; then the selection is classified —
 * cancel/Esc, the clean-session row, and a stale/unknown value all land on
 * 'declined' (fail-closed: nothing is bound, healed, or injected), and
 * only an exact ref match yields 'resume'.
 */
export function planResumePickerOutcome(
  hasUI: boolean,
  candidates: readonly ParkedCandidate[],
  selection?: ResumeSelection,
  nowIso: string = new Date().toISOString(),
): ResumePickerPlan {
  if (candidates.length === 0) {
    return { kind: 'silent' }
  }
  if (!hasUI) {
    return {
      kind: 'fallback',
      lines: buildResumeFallbackLines(candidates, nowIso),
    }
  }
  if (selection === undefined) {
    return { kind: 'menu', options: buildResumeMenuOptions(candidates, nowIso) }
  }
  if (selection.stage === 'resume-cancelled') {
    return { kind: 'declined', refs: candidateRefs(candidates) }
  }
  if (selection.value === RESUME_NONE_VALUE) {
    return { kind: 'declined', refs: candidateRefs(candidates) }
  }
  const picked = candidates.find((c) => c.ref === selection.value)
  if (picked === undefined) {
    // Lookup miss: the menu was rendered from a list this candidate no
    // longer belongs to. Stay clean rather than guessing across refs.
    return { kind: 'declined', refs: candidateRefs(candidates) }
  }
  return { kind: 'resume', candidate: picked }
}
