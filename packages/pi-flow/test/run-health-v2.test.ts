// AIDEV-NOTE: PMR-ZV9Y 3.2 — tests for the v2 append site in
// `renderRunHealthLines` (flow/run-health.ts): blocks 10+ (the six v2 gauge
// families from flow/state-metrics.ts) render AFTER the frozen v1 block, and
// the v1 lines themselves do not move. This is the render half of ISC-1 and
// the byte-identity half of ISC-A-4 — the live alert rules and the `piflow-*`
// boards read the v1 series until the 6.5 cutover, so "additive" is a
// production requirement, not a style preference.
//
// Deliberately a NEW file: test/run-health.test.ts stays untouched and green
// (ISC-A-4), and it owns the v1 exact-body pins. What is pinned here is the
// seam between the two vocabularies — the v1 prefix byte-for-byte plus the v2
// suffix in the plan's table order — and the no-derivation case where the body
// must equal the v1 body exactly.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPushBody } from '../flow/cost.ts'
import { renderRunHealthLines } from '../flow/run-health.ts'
import { renderStateMetricLines } from '../flow/state-metrics.ts'
import type { FlowReason, FlowState } from '../flow/vocabulary.ts'
import type { FlowPhase, FlowRunEvent, LoopRunStatus } from '../run-state.ts'

const REF = 'PMR-H'
const T0 = '2026-11-23T10:00:00.000Z'
const START_SECONDS = Math.floor(Date.parse(T0) / 1000)

/** The metric families 3.2 appends, i.e. everything that is NOT v1. */
const V2_PREFIXES = [
  'pi_flow_state{',
  'pi_flow_state_start_seconds{',
  'pi_flow_phase{',
  'pi_flow_wait_seconds{',
  'pi_flow_step{',
  'pi_flow_step_seconds{',
]

function shift(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString()
}

function runStart(): FlowRunEvent {
  return { kind: 'run-start', at: T0, ref: REF, mode: 'personal' }
}

function loopState(
  at: string,
  status: LoopRunStatus,
  phase: FlowPhase = 'validate',
): FlowRunEvent {
  return {
    kind: 'loop-state',
    at,
    ref: REF,
    loop: {
      phase,
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status,
    },
  }
}

function gateAnswer(
  at: string,
  gate: 'spec-review' | 'code-review',
  choice: 'approve' | 'reject' | 'pass' | 'fail',
): FlowRunEvent {
  return { kind: 'gate-answer', at, ref: REF, gate, choice }
}

function change(
  state: FlowState,
  reason: FlowReason | '',
  at: string,
): FlowRunEvent {
  return { kind: 'state-change', at, ref: REF, state, reason }
}

function stepStart(phase: FlowPhase, step: string, at: string): FlowRunEvent {
  return { kind: 'step-start', at, ref: REF, phase, step }
}

function isV2Line(line: string): boolean {
  return V2_PREFIXES.some((prefix) => line.startsWith(prefix))
}

/** Split a rendered body into the v1 prefix and the appended v2 suffix. */
function splitLines(lines: readonly string[]): {
  v1: string[]
  v2: string[]
} {
  return {
    v1: lines.filter((line) => !isV2Line(line)),
    v2: lines.filter((line) => isV2Line(line)),
  }
}

// ---------------------------------------------------- the append-site contract

test('a v2 journal renders the frozen v1 prefix byte-for-byte, then the v2 suffix', () => {
  const events = [
    runStart(),
    loopState(shift(1), 'running', 'plan'),
    change('running', '', shift(1)),
    gateAnswer(shift(5), 'spec-review', 'approve'),
    change('waiting_human', 'spec_approval_pending', shift(60)),
    stepStart('plan', 'plan.spec-approval', shift(60)),
  ]
  const lines = renderRunHealthLines(REF, events)
  // The v1 block, verbatim and in its original order: run status, the gate
  // decision, the two counters, the run-start epoch, the per-gate wait. No
  // pi_flow_human_wait_seconds here because nothing journaled a paused
  // loop-state.
  assert.deepEqual(splitLines(lines).v1, [
    'pi_flow_run_status{ref="PMR-H",status="running"} 1',
    'pi_flow_gate_decisions_total{ref="PMR-H",gate="spec-review",choice="approve"} 1',
    'pi_flow_retry_attempts{ref="PMR-H"} 0',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 0',
  ])
  // The v2 suffix, in the plan's vocabulary-table order.
  assert.deepEqual(splitLines(lines).v2, [
    `pi_flow_state{ref="PMR-H",state="waiting_human",reason="spec_approval_pending"} 1`,
    `pi_flow_state_start_seconds{ref="PMR-H",state="waiting_human",reason="spec_approval_pending"} ${Math.floor(Date.parse(shift(60)) / 1000)}`,
    'pi_flow_phase{ref="PMR-H",phase="plan"} 1',
    'pi_flow_step{ref="PMR-H",phase="plan",step="plan.spec-approval"} 1',
  ])
  // strict position: every v2 line sits after every v1 line
  let lastV1 = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (!isV2Line(lines[index])) lastV1 = index
  }
  const firstV2 = lines.findIndex(isV2Line)
  assert.ok(firstV2 > lastV1, lines.join('\n'))
})

test('the v2 suffix is exactly renderStateMetricLines output, appended unchanged', () => {
  const events = [
    runStart(),
    loopState(shift(1), 'paused', 'plan'),
    change('waiting_human', 'code_review_pending', shift(30)),
    stepStart('validate', 'validate.code-review', shift(30)),
  ]
  const lines = renderRunHealthLines(REF, events)
  assert.deepEqual(lines, [
    ...lines.filter((line) => !isV2Line(line)),
    ...renderStateMetricLines(REF, events),
  ])
})

// -------------------------------------------------- nothing derives = v1 body

test('no v2 lines when the journal has a run-start but no state at all', () => {
  // The projection exists (so the v1 block renders its counters) but carries
  // neither a loop record nor a 'state-change': renderStateMetricLines derives
  // nothing and the body IS the v1 body, byte for byte.
  const lines = renderRunHealthLines(REF, [runStart()])
  assert.deepEqual(lines, [
    'pi_flow_retry_attempts{ref="PMR-H"} 0',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
  ])
  assert.deepEqual(splitLines(lines).v2, [])
})

test('an empty journal renders nothing in either vocabulary', () => {
  assert.deepEqual(renderRunHealthLines(REF, []), [])
})

test('a journal with no run-start renders nothing (no projection to agree with)', () => {
  // Both blocks must describe the same run: with no projection the v1 block
  // emits nothing, so the v2 block must not start a body on its own.
  const events = [
    loopState(shift(1), 'running', 'plan'),
    change('waiting_machine', 'subagent_in_flight', shift(2)),
  ]
  assert.deepEqual(renderRunHealthLines(REF, events), [])
})

// ----------------------------------------------------------- ISC-6 through 3.2

test('a legacy journal gains v2 lines through the append site (ISC-6)', () => {
  // No 'state-change' events at all: the v2 block comes from the legacy
  // loop-status fallback, so an old run shows the new vocabulary with reason
  // "" while its frozen v1 lines stay exactly where they were.
  const events = [
    runStart(),
    loopState(shift(1), 'halted', 'validate'),
    gateAnswer(shift(2), 'code-review', 'fail'),
  ]
  const lines = renderRunHealthLines(REF, events)
  assert.deepEqual(splitLines(lines).v1, [
    'pi_flow_run_status{ref="PMR-H",status="halted"} 1',
    'pi_flow_run_halt_reason{ref="PMR-H",reason=""} 1',
    'pi_flow_gate_decisions_total{ref="PMR-H",gate="code-review",choice="fail"} 1',
    'pi_flow_retry_attempts{ref="PMR-H"} 0',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="code-review",choice="fail",n="1"} 0',
  ])
  assert.deepEqual(splitLines(lines).v2, [
    'pi_flow_state{ref="PMR-H",state="halted",reason=""} 1',
    `pi_flow_state_start_seconds{ref="PMR-H",state="halted",reason=""} ${Math.floor(Date.parse(shift(1)) / 1000)}`,
    'pi_flow_phase{ref="PMR-H",phase="validate"} 1',
  ])
})

// ------------------------------------------------------------ exposition shape

test('the combined body never emits a comment or TYPE line', () => {
  // THE TYPE-LINE RULE (flow/state-metrics.ts:50): push.ts strips every `#`
  // line when it reads a group back, so a typed first push plus an untyped
  // tombstone re-POST is the whole-group 400 from PMR-WBC2.
  const events = [
    runStart(),
    loopState(shift(1), 'running', 'plan'),
    change('waiting_human', 'escalation', shift(10)),
    stepStart('validate', 'validate.deviation', shift(10)),
  ]
  for (const line of renderRunHealthLines(REF, events)) {
    assert.ok(!line.startsWith('#'), `comment line emitted: ${line}`)
    assert.ok(line.startsWith('pi_flow'), `foreign metric: ${line}`)
  }
})

test('the render is deterministic for identical events', () => {
  const events = [
    runStart(),
    loopState(shift(1), 'running', 'plan'),
    change('running', '', shift(1)),
    change('waiting_machine', 'subagent_in_flight', shift(20)),
    stepStart('implement', 'implement.build', shift(20)),
    stepStart('validate', 'validate.deviation', shift(30)),
  ]
  assert.deepEqual(
    renderRunHealthLines(REF, events),
    renderRunHealthLines(REF, events),
  )
})

test('buildPushBody carries both vocabularies (the shared seam of both push paths)', () => {
  // Both producers of a stored group go through buildPushBody: the terminal
  // autopush and the daemon liveness pass (flow/liveness.ts). Asserting the
  // v2 lines here proves the ISC-1 render half for the autopush path;
  // test/run-liveness-pattern-v2.test.ts proves it for the liveness path.
  const events = [
    runStart(),
    loopState(shift(1), 'running', 'plan'),
    change('running', '', shift(1)),
  ]
  const body = buildPushBody(REF, [], [], events)
  assert.ok(
    body.includes('pi_flow_run_status{ref="PMR-H",status="running"} 1'),
    body,
  )
  assert.ok(
    body.includes('pi_flow_state{ref="PMR-H",state="running",reason=""} 1'),
    body,
  )
  assert.ok(body.endsWith('\n'))
  assert.ok(!body.endsWith('\n\n'))
})
