// AIDEV-NOTE: tests for the journal-derived run-health exposition lines
// (flow/run-health.ts). Frozen metric names/labels — dashboards in
// piflow-health/runs are built against these exact lines, so treat changes
// here as dashboard-breaking and update the dashboards together.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPushBody, buildWorkerRows } from '../flow/cost.ts'
import { renderRunHealthLines } from '../flow/run-health.ts'
import type { FlowPhase, FlowRunEvent, LoopRunStatus } from '../run-state.ts'

const REF = 'PMR-H'
const T0 = '2026-11-23T10:00:00.000Z'

function shift(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString()
}

function runStart(): FlowRunEvent {
  return { kind: 'run-start', at: T0, ref: REF, mode: 'personal' }
}

function loopState(
  at: string,
  status: LoopRunStatus,
  blockerRetries = 0,
  phase: FlowPhase = 'validate',
): FlowRunEvent {
  return {
    kind: 'loop-state',
    at,
    ref: REF,
    loop: {
      phase,
      awaitingOutcome: false,
      blockerRetries,
      validateStartedAt: at,
      status,
    },
  }
}

function noteText(at: string, text: string): FlowRunEvent {
  return { kind: 'note', at, ref: REF, text }
}

function gateAnswer(
  at: string,
  gate: 'spec-review' | 'code-review',
  choice: 'approve' | 'reject' | 'pass' | 'fail',
): FlowRunEvent {
  return { kind: 'gate-answer', at, ref: REF, gate, choice }
}

function attemptRecord(
  at: string,
  outcome: 'passed' | 'retry' | 'escalate',
  attempts: number,
): FlowRunEvent {
  return {
    kind: 'attempt-record',
    at,
    ref: REF,
    tool: 'flow_run_attempt',
    outcome,
    attempts,
  }
}

function sweep(
  at: string,
  outcome: 'removed' | 'noop' | 'kept-all' | 'deferred',
): FlowRunEvent {
  return { kind: 'worktree-sweep', at, ref: REF, source: 'sweep', outcome }
}

function findLine(
  lines: readonly string[],
  prefix: string,
): string | undefined {
  return lines.find((line) => line.startsWith(prefix))
}

// ---------------------------------------------------------------- status
// AIDEV-NOTE (PMR-ZV9Y 7.1): this section used to pin `pi_flow_run_status` and
// `pi_flow_run_halt_reason` byte-for-byte. Both series are RETIRED — every
// dashboard and alert rule was cut to the v2 state vocabulary in 6.2–6.5, and
// the halt reason is now ONLY the closed `reason` enum carried by
// `pi_flow_state` / `pi_flow_wait_seconds` (flow/state-metrics.ts), never a
// free-text halt note. The v2 coverage lives in test/run-health-v2.test.ts and
// test/state-metrics.test.ts; only the journal-projection guard below is
// vocabulary-independent and stays.

test('renderRunHealthLines emits nothing for an empty journal', () => {
  assert.deepEqual(renderRunHealthLines(REF, []), [])
})

test('a run-start with no loop snapshot still emits the kept counters', () => {
  // The retired status gauge used to be the only line derived from
  // `state.loop`; the kept blocker-retries counter now carries that guard — a
  // journal with no loop record must still render the projection-only lines.
  const lines = renderRunHealthLines(REF, [runStart()])
  assert.deepEqual(lines, [
    'pi_flow_retry_attempts{ref="PMR-H"} 0',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${Math.floor(Date.parse(T0) / 1000)}`,
  ])
})

// ------------------------------------------------------------ gate answers

test('gate decisions count RAW answers per gate and choice', () => {
  // The projection keeps only the latest answer per gate — the metric must
  // count every raw gate-answer event instead.
  const lines = renderRunHealthLines(REF, [
    runStart(),
    gateAnswer(shift(1), 'spec-review', 'reject'),
    gateAnswer(shift(2), 'spec-review', 'approve'),
    gateAnswer(shift(3), 'spec-review', 'approve'),
    gateAnswer(shift(4), 'code-review', 'pass'),
  ])
  assert.ok(
    lines.includes(
      'pi_flow_gate_decisions_total{ref="PMR-H",gate="spec-review",choice="reject"} 1',
    ),
  )
  assert.ok(
    lines.includes(
      'pi_flow_gate_decisions_total{ref="PMR-H",gate="spec-review",choice="approve"} 2',
    ),
  )
  assert.ok(
    lines.includes(
      'pi_flow_gate_decisions_total{ref="PMR-H",gate="code-review",choice="pass"} 1',
    ),
  )
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_gate_decisions_total'))
      .length,
    3,
  )
})

// ------------------------------------------------------------ human wait
// AIDEV-NOTE (PMR-ZV9Y 7.1): `pi_flow_human_wait_seconds` and the per-gate
// `pi_flow_gate_wait_seconds` are RETIRED, together with the scanPausedWindows
// path that used to feed both. The v2 `pi_flow_wait_seconds` gauge in
// flow/state-metrics.ts supersedes them (per wait_kind + closed-enum reason),
// and its own mirror of the paused-window arithmetic is pinned by
// test/state-metrics.test.ts. The two sections this note replaces
// ("human wait", "per-gate wait") are deleted, not rewritten — removing the
// behavior IS the point of the subtask (plan PMR-ZV9Y 7.1).

// ------------------------------------------------------- attempts/retries

test('retry attempts come from the projection and reset on passed', () => {
  const retrying = renderRunHealthLines(REF, [
    runStart(),
    attemptRecord(shift(1), 'retry', 2),
  ])
  assert.equal(
    findLine(retrying, 'pi_flow_retry_attempts'),
    'pi_flow_retry_attempts{ref="PMR-H"} 2',
  )
  const passed = renderRunHealthLines(REF, [
    runStart(),
    attemptRecord(shift(1), 'retry', 2),
    attemptRecord(shift(2), 'passed', 3),
  ])
  assert.equal(
    findLine(passed, 'pi_flow_retry_attempts'),
    'pi_flow_retry_attempts{ref="PMR-H"} 0',
  )
})

test('retry attempts and blocker retries emit zero without their events', () => {
  const lines = renderRunHealthLines(REF, [runStart()])
  assert.ok(
    lines.includes('pi_flow_retry_attempts{ref="PMR-H"} 0'),
    lines.join('\n'),
  )
  assert.ok(
    lines.includes('pi_flow_blocker_retries{ref="PMR-H"} 0'),
    lines.join('\n'),
  )
})

test('blocker retries come from the projected loop record', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(1), 'running', 3),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_blocker_retries'),
    'pi_flow_blocker_retries{ref="PMR-H"} 3',
  )
})

// ------------------------------------------------------------ worktree sweep

test('worktree sweep counts group raw events per outcome', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    sweep(shift(1), 'removed'),
    sweep(shift(2), 'removed'),
    sweep(shift(3), 'deferred'),
  ])
  assert.ok(
    lines.includes(
      'pi_flow_worktree_sweep_total{ref="PMR-H",outcome="removed"} 2',
    ),
  )
  assert.ok(
    lines.includes(
      'pi_flow_worktree_sweep_total{ref="PMR-H",outcome="deferred"} 1',
    ),
  )
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_worktree_sweep_total'))
      .length,
    2,
  )
})

// -------------------------------------------------------------- wiring

function costRows() {
  return buildWorkerRows(
    [
      {
        childId: 'c1',
        name: 'w',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s1.jsonl',
        at: '',
        phase: 'implement' as const,
      },
    ],
    [],
    new Map<string, readonly unknown[]>([
      [
        '/s1.jsonl',
        [
          {
            type: 'message',
            message: {
              role: 'assistant',
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0.5 },
              },
            },
          },
        ],
      ],
    ]),
  )
}

test('buildPushBody appends health lines when events are provided', () => {
  const rows = costRows()
  const events: FlowRunEvent[] = [
    runStart(),
    loopState(shift(1), 'halted', 1),
    noteText(shift(2), 'halt: human said no'),
  ]
  const body = buildPushBody(
    REF,
    rows,
    [{ phase: 'implement', seconds: 5 }],
    events,
  )
  const lines = body.split('\n')
  // one trailing newline, same as before
  assert.equal(lines[lines.length - 1], '')
  assert.equal(body.endsWith('\n'), true)
  assert.ok(!body.endsWith('\n\n'))
  // cost lines still come first, health lines appended after them
  const costIndex = lines.findIndex((line) =>
    line.startsWith('pi_flow_run_cost_usd'),
  )
  const blockerIndex = lines.findIndex((line) =>
    line.startsWith('pi_flow_blocker_retries'),
  )
  assert.ok(costIndex >= 0 && blockerIndex > costIndex, body)
  assert.equal(lines[blockerIndex], 'pi_flow_blocker_retries{ref="PMR-H"} 1')
  // AIDEV-NOTE (PMR-ZV9Y 7.1): the retirement guard for the autopush path —
  // a body rendered for a HALTED run with a halt note must carry none of the
  // retired v1 state-vocabulary lines (the note is no longer a label value).
  assert.ok(!body.includes('pi_flow_run_status'), body)
  assert.ok(!body.includes('pi_flow_run_halt_reason'), body)
  assert.ok(!body.includes('pi_flow_human_wait_seconds'), body)
  assert.ok(!body.includes('pi_flow_gate_wait_seconds'), body)
})

test('buildPushBody is unchanged when the events parameter is omitted', () => {
  const rows = costRows()
  const durations = [{ phase: 'implement' as FlowPhase, seconds: 5 }]
  const omitted = buildPushBody(REF, rows, durations)
  assert.ok(!omitted.includes('pi_flow_retry_attempts'))
  assert.ok(!omitted.includes('pi_flow_blocker_retries'))
  // an empty events list appends nothing either (byte-identical)
  assert.equal(buildPushBody(REF, rows, durations, []), omitted)
})

// ----------------------------------------------------------- run start epoch

const START_SECONDS = Math.floor(Date.parse(T0) / 1000)

function runStartAt(at: string): FlowRunEvent {
  return { kind: 'run-start', at, ref: REF, mode: 'personal' }
}

test('run start seconds come from the run-start journal event', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(10), 'running'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_run_start_seconds'),
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
  )
})

test('run start uses the FIRST run-start, so a restart keeps the original start', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(10), 'running'),
    runStartAt(shift(600)),
    loopState(shift(610), 'running'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_run_start_seconds'),
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
  )
})

// AIDEV-NOTE: the fallback is the only reachable "no usable run-start" case —
// projectRunState needs a run-start event to build any state at all, so a
// journal genuinely missing one emits no lines (see the next test). A
// leniently parsed run-start with an unparseable `at` is the real-world shape
// where the earliest event timestamp stands in for the start.
test('run start falls back to the earliest event when the run-start at is unusable', () => {
  const lines = renderRunHealthLines(REF, [
    runStartAt('not-a-timestamp'),
    loopState(shift(30), 'running'),
    noteText(shift(10), 'early note'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_run_start_seconds'),
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS + 10}`,
  )
})

test('no run start line when no event has a usable timestamp', () => {
  const lines = renderRunHealthLines(REF, [
    runStartAt('not-a-timestamp'),
    loopState('still-not-a-timestamp', 'running'),
  ])
  assert.equal(findLine(lines, 'pi_flow_run_start_seconds'), undefined)
})

test('a journal without a run-start event emits nothing, including no start line', () => {
  // No projection is possible without run-start, so the whole body stays empty.
  const lines = renderRunHealthLines(REF, [
    loopState(shift(10), 'running'),
    noteText(shift(20), 'orphan note'),
  ])
  assert.deepEqual(lines, [])
})

// AIDEV-NOTE: frozen-body ordering. This test asserts the whole body
// byte-for-byte, so it has to grow with every additive metric — new additive
// metrics go AFTER the frozen block, in order of introduction.
// AIDEV-NOTE (PMR-ZV9Y 3.2): grew this tail for the v2 state-machine block,
// exactly the posture recorded above. This fixture carries NO 'state-change'
// event, so its four appended lines are the ISC-6 legacy fallback: the
// projected `paused` loop status maps to state="waiting_human" reason="", its
// `at` is the last loop-state's, and the paused window the note at +2s closed
// is the aggregate wait.
// AIDEV-NOTE (PMR-ZV9Y 7.1): the v1 state-vocabulary lines this pinned
// (`pi_flow_run_status`, `pi_flow_human_wait_seconds`,
// `pi_flow_gate_wait_seconds`) are retired, so the frozen block below IS the
// new frozen set — gate decisions, retry attempts, blocker retries, worktree
// sweep, run start — followed by the v2 gauges. Every KEPT line stayed
// byte-identical and in its original relative position; only the retired lines
// disappeared. This is the body-shape half of the ISC-5 retirement contract.
const V2_METRICS = [
  'pi_flow_state',
  'pi_flow_phase',
  'pi_flow_wait_seconds',
  'pi_flow_step',
]

test('the frozen block keeps its order and the v2 gauges are appended last', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(1), 'paused'),
    noteText(shift(2), 'human answered'),
    gateAnswer(shift(3), 'spec-review', 'approve'),
    sweep(shift(4), 'removed'),
    attemptRecord(shift(5), 'retry', 2),
  ])
  const frozen = lines.filter(
    (line) => !V2_METRICS.some((metric) => line.startsWith(metric)),
  )
  assert.deepEqual(
    frozen.map((line) => line.split('{')[0]),
    [
      'pi_flow_gate_decisions_total',
      'pi_flow_retry_attempts',
      'pi_flow_blocker_retries',
      'pi_flow_worktree_sweep_total',
      'pi_flow_run_start_seconds',
    ],
  )
  // the whole body, byte-for-byte: the five frozen lines in their original
  // order, then the v2 state-machine block in its plan table order.
  assert.deepEqual(lines, [
    'pi_flow_gate_decisions_total{ref="PMR-H",gate="spec-review",choice="approve"} 1',
    'pi_flow_retry_attempts{ref="PMR-H"} 2',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    'pi_flow_worktree_sweep_total{ref="PMR-H",outcome="removed"} 1',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
    `pi_flow_state{ref="PMR-H",state="waiting_human",reason=""} 1`,
    `pi_flow_state_start_seconds{ref="PMR-H",state="waiting_human",reason=""} ${START_SECONDS + 1}`,
    `pi_flow_phase{ref="PMR-H",phase="validate"} 1`,
    `pi_flow_wait_seconds{ref="PMR-H",wait_kind="human",reason=""} 1`,
  ])
  assert.equal(frozen.length, 5)
})

// ------------------------------------------------------------ per-gate wait
// AIDEV-NOTE (PMR-ZV9Y 7.1): the pi_flow_gate_wait_seconds tests that lived
// here are gone with the metric — see the "human wait" note above for why and
// for the successor family.
