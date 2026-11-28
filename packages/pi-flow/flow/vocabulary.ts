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
// Vocabulary history (PMR-0NRH): `human_ask_pending` was added here as the
// HUMAN wait for a mid-turn plain ask in the main session — the generic ask
// emitter journals it, so every current and future prompt-instructed ask
// becomes visible on the Waiting-on-me board with no per-gate reason and no
// prompt edit. `SELF_CLOSING_HUMAN_WAITS` was added in the same feature's
// review round (PMR-422Q): the per-reason "its owning seam journals its own
// `running` close" property that lets flow/loop.ts hold the board for a live
// ask without latching on a wait nobody ever closes.
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
 * brainstorm missed); `subagent_ask_pending` was added by the worker-ask-wait
 * fix (an in-flight child parked on ask_owner is a HUMAN wait — flow/loop.ts
 * emits it instead of `subagent_in_flight` when a pending ask exists);
 * `human_ask_pending` was added by the mid-turn-ask fix PMR-0NRH (a mid-turn
 * plain ask in the MAIN session is a HUMAN wait — the generic ask emitter
 * journals it, so a prompt-instructed `ask_user_question` becomes visible on
 * the Waiting-on-me board without any per-gate reason or prompt edit).
 */
export type FlowReason =
  | 'spec_approval_pending'
  | 'code_review_pending'
  | 'escalation'
  | 'retry_budget_exhausted'
  | 'blocker_budget_exhausted'
  | 'label_miss'
  | 'label_reset_failed'
  | 'deviation_gate_rerun'
  | 'subagent_in_flight'
  | 'subagent_ask_pending'
  | 'human_ask_pending'
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
  'label_reset_failed',
  'deviation_gate_rerun',
  'subagent_in_flight',
  'subagent_ask_pending',
  'human_ask_pending',
  'prompt_send_failed',
  'aven_read_failed',
]

/**
 * reason -> wait_kind. The human reasons are the ones an operator can
 * resolve; everything else clears itself (or needs a code/label fix, which is
 * still not an interactive wait).
 *
 * AIDEV-NOTE (worker-ask-wait fix): `subagent_ask_pending` is human because the
 * blocker is the OPERATOR answering an ask_owner question in a child pane — the
 * machine half (`subagent_in_flight`, the child still working) is a different
 * wait. Before this reason existed, that case was labelled machine and the
 * "Waiting on me — act now" board missed it.
 *
 * AIDEV-NOTE (PMR-0NRH): `human_ask_pending` is human for the same reason one
 * level up — the blocker is the OPERATOR answering an `ask_user_question` in the
 * main session. Before it existed, a mid-turn ask in the main session was
 * invisible: only child asks (subagent_ask_pending) and registered gate waits
 * showed up on the board.
 */
export const WAIT_KIND: Readonly<Record<FlowReason, WaitKind>> = {
  spec_approval_pending: 'human',
  code_review_pending: 'human',
  escalation: 'human',
  retry_budget_exhausted: 'machine',
  blocker_budget_exhausted: 'machine',
  label_miss: 'machine',
  // AIDEV-NOTE: PMR-B033 — machine wait: the blocker route-back could not
  // reset the stale implement completion label (removal dep absent, returned
  // false, or threw). Nothing interactive to answer; recovery is fixing aven
  // reachability/the ticket labels and rerunning /flow <ref>.
  label_reset_failed: 'machine',
  deviation_gate_rerun: 'machine',
  subagent_in_flight: 'machine',
  subagent_ask_pending: 'human',
  human_ask_pending: 'human',
  prompt_send_failed: 'machine',
  aven_read_failed: 'machine',
}

/**
 * reason -> the command that unblocks the run, with `{ref}` as the placeholder.
 * Only the human wait kinds have one; the Waiting-on-me board mirrors these
 * strings as value mappings and the desktop notification uses them verbatim.
 *
 * AIDEV-NOTE (worker-ask-wait fix): `subagent_ask_pending` is the one human wait
 * with NO slash command — the operator answers the child in its pane (or tells
 * the parent to run `answer_subagent`), so its action is plain prose and
 * deliberately carries no `{ref}` placeholder.
 *
 * AIDEV-NOTE (PMR-0NRH): `human_ask_pending` is the second human wait with no
 * slash command — the operator answers the ask in the session it was asked in,
 * so its action is prose with no `{ref}` placeholder either.
 */
export const EXPECTED_ACTION: Readonly<Partial<Record<FlowReason, string>>> = {
  spec_approval_pending: '/flow answer {ref} approve',
  code_review_pending: '/flow answer {ref} pass|fail',
  escalation: 'intervene: /flow {ref} (or fix forward)',
  subagent_ask_pending: 'answer the subagent (its pane or answer_subagent)',
  human_ask_pending: 'answer the agent (the ask in this session)',
}

/** Rendered when nothing unblocks the run (no human action registered). */
export const NO_EXPECTED_ACTION = '—'

/**
 * AIDEV-NOTE: PMR-422Q (PMR-0NRH review blocker 2) — the HUMAN waits whose
 * OWNING SEAM journals its own `running` close, i.e. the wait is guaranteed to
 * be released by an external `state-change{running}` observation. flow/loop.ts
 * arms its live-wait hold ONLY for these reasons: a hold that nothing can
 * release is a latch, and a latched hold silently drops every later
 * loop-emitted wait for the rest of the process's run.
 *
 * Membership is by EMISSION SITE, not by wait kind:
 *  * `human_ask_pending` — IN. flow/ask-emitter.ts journals the close on
 *    tool_result / tool_execution_end for the toolCallId it opened.
 *  * `code_review_pending` — IN. tools/code-review.ts `closeReviewGate` journals
 *    step-stop + `state-change{running}` on a pass/fail answer.
 *  * `escalation` — OUT. `run_attempt` escalates through the shared fan-out
 *    writer and NEVER journals the running return; the loop's own
 *    snapshot('running') is the only thing that unsticks that journal (the
 *    PMR-ZV9Y fix-round P1 invariant), so arming here is exactly the latch.
 *  * `spec_approval_pending` — OUT. A loop-owned pause (`snapshot('paused', ...)`)
 *    whose close is the loop's own next snapshot; holding the loop against its
 *    own pause would deadlock the run.
 *  * `subagent_ask_pending` — OUT. Emitted by the loop's own settle branch; the
 *    child's answer is not an external state-change, so no external close ever
 *    arrives for it.
 *  * every machine reason — OUT by definition: the hold exists to protect a
 *    HUMAN wait against a competing loop emission.
 */
export const SELF_CLOSING_HUMAN_WAITS: readonly FlowReason[] = [
  'code_review_pending',
  'human_ask_pending',
]

/**
 * True when a reason's owning seam journals its own `running` close, so a
 * hold armed on it is guaranteed to be released. The empty reason (a state
 * that carries none) is never self-closing.
 */
export function reasonOwnsExternalClose(reason: FlowReason | ''): boolean {
  if (reason === '') return false
  return SELF_CLOSING_HUMAN_WAITS.includes(reason)
}

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
