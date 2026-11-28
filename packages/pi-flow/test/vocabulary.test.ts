// AIDEV-NOTE: PMR-ZV9Y 1.1 — pins the v2 state-machine vocabulary: the closed
// enum sets, the reason -> wait_kind derivation, the expected-action map, and
// the registered step names. These tables are the contract every later phase
// (emissions, Prometheus gauges, Loki labels, desktop notify, Grafana value
// mappings) reads. Changing a value here changes the dashboards — the
// deepEqual pins below are the drift alarm, not an oversight.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRegisteredStep, STEP_REGISTRY } from '../flow/steps.ts'
import {
  EXPECTED_ACTION,
  expectedAction,
  FLOW_REASONS,
  FLOW_STATES,
  type FlowReason,
  NO_EXPECTED_ACTION,
  reasonOwnsExternalClose,
  reasonWaitKind,
  SELF_CLOSING_HUMAN_WAITS,
  WAIT_KIND,
} from '../flow/vocabulary.ts'

// --- the closed enums ---

test('FLOW_STATES is the v2 state enum (6 values)', () => {
  assert.deepEqual(
    [...FLOW_STATES],
    ['running', 'waiting_human', 'waiting_machine', 'halted', 'done', 'stale'],
  )
})

test('FLOW_REASONS is the v2 reason enum (13 values)', () => {
  assert.deepEqual(
    [...FLOW_REASONS],
    [
      'spec_approval_pending',
      'code_review_pending',
      'escalation',
      'retry_budget_exhausted',
      'blocker_budget_exhausted',
      'label_miss',
      // PMR-B033: blocker route-back could not reset the stale implement
      // completion label — fail-closed halt, machine wait.
      'label_reset_failed',
      'deviation_gate_rerun',
      'subagent_in_flight',
      'subagent_ask_pending',
      'human_ask_pending',
      'prompt_send_failed',
      'aven_read_failed',
    ],
  )
})

test('vocabulary sets are duplicate-free', () => {
  assert.equal(new Set(FLOW_STATES).size, FLOW_STATES.length)
  assert.equal(new Set(FLOW_REASONS).size, FLOW_REASONS.length)
})

// --- wait_kind derivation ---

test('WAIT_KIND covers every reason exactly once', () => {
  const keys = Object.keys(WAIT_KIND).sort()
  assert.deepEqual(keys, [...FLOW_REASONS].sort())
})

test('reasonWaitKind: the five human reasons are human, the rest machine', () => {
  const human: FlowReason[] = [
    'spec_approval_pending',
    'code_review_pending',
    'escalation',
    'subagent_ask_pending',
    'human_ask_pending',
  ]
  for (const reason of human) {
    assert.equal(reasonWaitKind(reason), 'human', reason)
    assert.equal(WAIT_KIND[reason], 'human', reason)
  }
  for (const reason of FLOW_REASONS) {
    if (human.includes(reason)) continue
    assert.equal(reasonWaitKind(reason), 'machine', reason)
    assert.equal(WAIT_KIND[reason], 'machine', reason)
  }
})

test('reasonWaitKind: a drifted (out-of-vocabulary) reason is machine, never a phantom human wait', () => {
  // Journals are parsed leniently, so the derivation can be handed a value
  // outside the enum; it must degrade to machine, not throw.
  const drift = 'from_the_future' as string as FlowReason
  assert.equal(reasonWaitKind(drift), 'machine')
})

// --- expected action ---

test('expectedAction: waiting_human + spec_approval_pending is the approve command', () => {
  assert.equal(
    expectedAction('waiting_human', 'spec_approval_pending', 'PMR-X'),
    '/flow answer PMR-X approve',
  )
})

test('expectedAction: waiting_human + code_review_pending is pass|fail', () => {
  assert.equal(
    expectedAction('waiting_human', 'code_review_pending', 'PMR-X'),
    '/flow answer PMR-X pass|fail',
  )
})

test('expectedAction: waiting_human + escalation points a human at the run', () => {
  const action = expectedAction('waiting_human', 'escalation', 'PMR-X')
  assert.notEqual(action, NO_EXPECTED_ACTION)
  assert.ok(action.includes('/flow PMR-X'), action)
})

// AIDEV-NOTE: the subagent-ask wait has NO slash command (the human answers the
// child in its pane or through the parent's answer_subagent tool), so its
// expected action is plain prose and must NOT carry a {ref} placeholder — an
// unsubstituted literal would leak into the desktop notification body and the
// Waiting-on-me board value mapping.
test('expectedAction: waiting_human + subagent_ask_pending tells the human where to answer', () => {
  const action = expectedAction(
    'waiting_human',
    'subagent_ask_pending',
    'PMR-X',
  )
  assert.equal(action, 'answer the subagent (its pane or answer_subagent)')
  assert.ok(!action.includes('{ref}'), action)
})

// AIDEV-NOTE: PMR-0NRH — a mid-turn plain ask in the MAIN session is answered
// in-session, exactly like the subagent ask above: prose only, NO {ref} placeholder.
// An unsubstituted literal would leak into the desktop notification body and the
// Waiting-on-me board value mapping.
test('expectedAction: waiting_human + human_ask_pending tells the human to answer the agent', () => {
  const action = expectedAction('waiting_human', 'human_ask_pending', 'PMR-X')
  assert.equal(action, 'answer the agent (the ask in this session)')
  assert.ok(!action.includes('{ref}'), action)
})

test('expectedAction: machine reasons, no reason, and non-human states all have no action', () => {
  assert.equal(
    expectedAction('waiting_human', 'subagent_in_flight', 'PMR-X'),
    NO_EXPECTED_ACTION,
  )
  assert.equal(
    expectedAction('waiting_machine', 'label_miss', 'PMR-X'),
    NO_EXPECTED_ACTION,
  )
  assert.equal(expectedAction('waiting_human', '', 'PMR-X'), NO_EXPECTED_ACTION)
  assert.equal(expectedAction('running', '', 'PMR-X'), NO_EXPECTED_ACTION)
  assert.equal(
    expectedAction('halted', 'prompt_send_failed', 'PMR-X'),
    NO_EXPECTED_ACTION,
  )
  assert.equal(expectedAction('done', '', 'PMR-X'), NO_EXPECTED_ACTION)
})

test('EXPECTED_ACTION only maps reasons the wait-kind derivation calls human', () => {
  for (const reason of Object.keys(EXPECTED_ACTION) as FlowReason[]) {
    assert.ok(FLOW_REASONS.includes(reason), `unknown reason ${reason}`)
    assert.equal(reasonWaitKind(reason), 'human', reason)
  }
  assert.equal(Object.keys(EXPECTED_ACTION).length, 5)
})

// --- self-closing human waits (PMR-422Q, PMR-0NRH review blocker 2) ---

// AIDEV-NOTE: PMR-0NRH — the closed set of HUMAN waits whose owning seam
// journals its own `running` close. This is the property flow/loop.ts reads to
// decide whether an external waiting_human may hold the loop's own emissions:
// a hold that nothing can release is a latch, so only self-closing waits may
// arm it. ISC-A-1 puts the semantics HERE, not in a second list in loop.ts.
test('SELF_CLOSING_HUMAN_WAITS is exactly the two waits that journal their own close', () => {
  assert.deepEqual(
    [...SELF_CLOSING_HUMAN_WAITS],
    ['code_review_pending', 'human_ask_pending'],
  )
  assert.equal(new Set(SELF_CLOSING_HUMAN_WAITS).size, 2)
})

test('every self-closing human wait is a WAIT_KIND human reason', () => {
  for (const reason of SELF_CLOSING_HUMAN_WAITS) {
    assert.equal(WAIT_KIND[reason], 'human', reason)
    assert.equal(reasonWaitKind(reason), 'human', reason)
  }
})

test('reasonOwnsExternalClose: escalation, spec_approval_pending and subagent_ask_pending are NOT self-closing', () => {
  // escalation: run_attempt journals the wait but never the running return —
  // arming the hold on it latches the guard for the rest of the process.
  assert.equal(reasonOwnsExternalClose('escalation'), false)
  // spec_approval_pending: a LOOP-owned pause whose close is the loop's own
  // snapshot, so holding the loop against it would deadlock the run.
  assert.equal(reasonOwnsExternalClose('spec_approval_pending'), false)
  // subagent_ask_pending: emitted by the loop's own settle branch, no
  // external close exists to release a hold.
  assert.equal(reasonOwnsExternalClose('subagent_ask_pending'), false)
})

test('reasonOwnsExternalClose: every machine reason and the empty reason are never self-closing', () => {
  for (const reason of FLOW_REASONS) {
    if (SELF_CLOSING_HUMAN_WAITS.includes(reason)) continue
    assert.equal(reasonOwnsExternalClose(reason), false, reason)
  }
  assert.equal(reasonOwnsExternalClose(''), false)
})

// --- step registry ---

test('STEP_REGISTRY covers all four phases with the registered names only', () => {
  assert.deepEqual(Object.keys(STEP_REGISTRY).sort(), [
    'feedback',
    'implement',
    'plan',
    'validate',
  ])
  // PMR-S7FQ: exhaustive snapshot — plan gained the evidence-only
  // plan.route-confirmed, validate gained validate.review-tool and
  // validate.land. implement/feedback stay EMPTY on purpose (the advisory is
  // suppressed for an empty registry, see flow/step-output.ts:301-308).
  assert.deepEqual(
    [...STEP_REGISTRY.plan],
    ['plan.spec-approval', 'plan.route-confirmed'],
  )
  assert.deepEqual([...STEP_REGISTRY.validate].sort(), [
    'validate.aven-notes',
    'validate.code-review',
    'validate.deviation',
    'validate.land',
    'validate.review-tool',
    'validate.spec-diff',
  ])
  assert.deepEqual([...STEP_REGISTRY.implement], [])
  assert.deepEqual([...STEP_REGISTRY.feedback], [])
})

test('isRegisteredStep accepts registered names and rejects everything else', () => {
  assert.equal(isRegisteredStep('plan', 'plan.spec-approval'), true)
  assert.equal(isRegisteredStep('validate', 'validate.code-review'), true)
  assert.equal(isRegisteredStep('validate', 'validate.deviation'), true)
  assert.equal(isRegisteredStep('implement', 'implement.commit'), false)
  assert.equal(isRegisteredStep('plan', 'validate.code-review'), false)
  assert.equal(isRegisteredStep('plan', ''), false)
})

test('isRegisteredStep: a drifted phase name never throws', () => {
  const drift = 'research' as string as 'plan'
  assert.equal(isRegisteredStep(drift, 'plan.spec-approval'), false)
})
