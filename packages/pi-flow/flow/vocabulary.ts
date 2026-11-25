// AIDEV-NOTE: PMR-ZV9Y 1.1 — THE v2 state-machine vocabulary (plan PMR-ZV9Y,
// "The v2 vocabulary"). One closed enum per dimension plus the two derived
// tables (wait_kind, expected action). This module is deliberately PURE with
// ZERO imports so every consumer can reach it: the run journal (run-state.ts
// validates its v2 events against these sets), the daemon-side Prometheus
// derivation (flow/state-metrics.ts, node-only closure), the Loki pusher
// labels, the desktop-notify body, and the Grafana value mappings.
//
// Cardinality rule (ISC-A-1): nothing in this file is free text and nothing
// outside it may ever become a metric/log LABEL value. If a new state or
// reason is needed, add it here, mirror it in the Grafana value mappings, and
// extend the run-state tests — the deepEqual pins in test/vocabulary.test.ts
// are the drift alarm.
//
// v2 state is DERIVED, never a rename: LoopRunStatus ('running' | 'paused' |
// 'halted' | 'done') stays as-is because resume (flow/resume.ts), the
// phase-3 pending protocol and old journals depend on it (ISC-A-2).

/** The v2 run state (supersedes the free-text halt-note vocabulary). */
export type FlowState =
  | 'running'
  | 'waiting_human'
  | 'waiting_machine'
  | 'halted'
  | 'done'
  | 'stale'

/**
 * The closed v2 reason enum. `answer_pending` was dropped from the brainstorm
 * list (no emission site produces it — dead vocabulary); `prompt_send_failed`
 * and `aven_read_failed` were added (real halt paths in flow/loop.ts the
 * brainstorm missed).
 */
export type FlowReason =
  | 'spec_approval_pending'
  | 'code_review_pending'
  | 'escalation'
  | 'retry_budget_exhausted'
  | 'blocker_budget_exhausted'
  | 'label_miss'
  | 'deviation_gate_rerun'
  | 'subagent_in_flight'
  | 'prompt_send_failed'
  | 'aven_read_failed'

/** Who can unblock a wait: the operator (human) or the machine itself. */
export type WaitKind = 'human' | 'machine'

/** Guard set for `FlowState` — mirrors the type, pinned by tests. */
export const FLOW_STATES: readonly FlowState[] = [
  'running',
  'waiting_human',
  'waiting_machine',
  'halted',
  'done',
  'stale',
]

/** Guard set for `FlowReason` — mirrors the type, pinned by tests. */
export const FLOW_REASONS: readonly FlowReason[] = [
  'spec_approval_pending',
  'code_review_pending',
  'escalation',
  'retry_budget_exhausted',
  'blocker_budget_exhausted',
  'label_miss',
  'deviation_gate_rerun',
  'subagent_in_flight',
  'prompt_send_failed',
  'aven_read_failed',
]

/**
 * reason -> wait_kind. The three human reasons are the ones an operator can
 * resolve; everything else clears itself (or needs a code/label fix, which is
 * still not an interactive wait).
 */
export const WAIT_KIND: Readonly<Record<FlowReason, WaitKind>> = {
  spec_approval_pending: 'human',
  code_review_pending: 'human',
  escalation: 'human',
  retry_budget_exhausted: 'machine',
  blocker_budget_exhausted: 'machine',
  label_miss: 'machine',
  deviation_gate_rerun: 'machine',
  subagent_in_flight: 'machine',
  prompt_send_failed: 'machine',
  aven_read_failed: 'machine',
}

/**
 * reason -> the command that unblocks the run, with `{ref}` as the placeholder.
 * Only the human wait kinds have one; the Waiting-on-me board mirrors these
 * strings as value mappings and the desktop notification uses them verbatim.
 */
export const EXPECTED_ACTION: Readonly<Partial<Record<FlowReason, string>>> = {
  spec_approval_pending: '/flow answer {ref} approve',
  code_review_pending: '/flow answer {ref} pass|fail',
  escalation: 'intervene: /flow {ref} (or fix forward)',
}

/** Rendered when nothing unblocks the run (no human action registered). */
export const NO_EXPECTED_ACTION = '—'

/**
 * The wait kind for a reason. Out-of-vocabulary input (a leniently parsed
 * journal, a future writer) degrades to `machine` so a drifted value can
 * never fabricate a "waiting on you" row.
 */
export function reasonWaitKind(reason: FlowReason): WaitKind {
  if (!FLOW_REASONS.includes(reason)) return 'machine'
  return WAIT_KIND[reason]
}

/**
 * The single source for "what do I type to unblock this run?". Only a
 * `waiting_human` state has an action; every other state/reason pair renders
 * as NO_EXPECTED_ACTION.
 */
export function expectedAction(
  state: FlowState,
  reason: FlowReason | '',
  ref: string,
): string {
  if (state !== 'waiting_human') return NO_EXPECTED_ACTION
  if (reason === '') return NO_EXPECTED_ACTION
  const template = EXPECTED_ACTION[reason]
  if (template === undefined) return NO_EXPECTED_ACTION
  return template.replaceAll('{ref}', ref)
}
