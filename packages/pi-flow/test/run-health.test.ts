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

test('renderRunHealthLines emits nothing for an empty journal', () => {
  assert.deepEqual(renderRunHealthLines(REF, []), [])
})

test('run status metric comes from the projected loop record only', () => {
  const withoutLoop = renderRunHealthLines(REF, [runStart()])
  assert.equal(findLine(withoutLoop, 'pi_flow_run_status'), undefined)
  assert.equal(findLine(withoutLoop, 'pi_flow_run_halt_reason'), undefined)

  const running = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(10), 'running'),
  ])
  assert.equal(
    findLine(running, 'pi_flow_run_status'),
    'pi_flow_run_status{ref="PMR-H",status="running"} 1',
  )
})

test('halt reason is the last projected note, escaped like cost labels', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    noteText(shift(1), 'first note'),
    noteText(shift(2), 'halted on "gate"\nretry needed'),
    loopState(shift(3), 'halted'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_run_halt_reason'),
    'pi_flow_run_halt_reason{ref="PMR-H",reason="halted on \\"gate\\"\\nretry needed"} 1',
  )
})

test('halt reason is an empty label when a halted run has no notes', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(3), 'halted'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_run_halt_reason'),
    'pi_flow_run_halt_reason{ref="PMR-H",reason=""} 1',
  )
})

test('no halt reason line while the run is not halted', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    noteText(shift(1), 'some note'),
    loopState(shift(2), 'paused'),
  ])
  assert.equal(findLine(lines, 'pi_flow_run_halt_reason'), undefined)
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

test('human wait sums paused windows from raw events', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    noteText(shift(120), 'human answered'),
  ])
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 120',
  )
})

test('consecutive paused snapshots do not restart the window', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    loopState(shift(10), 'paused'),
    loopState(shift(50), 'running'),
  ])
  // window opened at +0 (not restarted at +10) and closed at the
  // running loop-state (+50), even though that event IS a loop-state.
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 50',
  )
})

test('a never-closed paused window contributes nothing', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
  ])
  assert.equal(findLine(lines, 'pi_flow_human_wait_seconds'), undefined)
})

test('multiple paused windows are summed', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    loopState(shift(30), 'running'), // closes window 1: 30s
    loopState(shift(40), 'paused'), // opens window 2
    noteText(shift(70), 'resumed later'), // closes window 2: 30s
  ])
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 60',
  )
})

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
  const statusIndex = lines.findIndex((line) =>
    line.startsWith('pi_flow_run_status'),
  )
  const haltIndex = lines.findIndex((line) =>
    line.startsWith('pi_flow_run_halt_reason'),
  )
  assert.ok(costIndex >= 0 && statusIndex > costIndex)
  assert.equal(
    lines[haltIndex],
    'pi_flow_run_halt_reason{ref="PMR-H",reason="halt: human said no"} 1',
  )
})

test('buildPushBody is unchanged when the events parameter is omitted', () => {
  const rows = costRows()
  const durations = [{ phase: 'implement' as FlowPhase, seconds: 5 }]
  const omitted = buildPushBody(REF, rows, durations)
  assert.ok(!omitted.includes('pi_flow_run_status'))
  assert.ok(!omitted.includes('pi_flow_human_wait_seconds'))
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

// AIDEV-NOTE: additive-metric ordering. This test asserted the whole body
// byte-for-byte, so it has to grow with every additive metric — the seven
// lines it froze are still asserted verbatim; only the tail gained the
// pi_flow_gate_wait_seconds line this fixture now produces (the gate-answer
// at +3s closes no paused window, so its occurrence is a 0). New additive
// metrics go AFTER pi_flow_run_start_seconds, in order of introduction.
// AIDEV-NOTE (PMR-ZV9Y 3.2): grew this tail again for the v2 state-machine
// block, exactly the posture recorded above. This fixture carries NO
// 'state-change' event, so its four appended lines are the ISC-6 legacy
// fallback: the projected `paused` loop status maps to
// state="waiting_human" reason="", its `at` is the last loop-state's, and the
// paused window the note at +2s closed is the aggregate wait. Every v1 line
// above stays byte-identical and in place — the frozen guarantee this test
// exists to protect is about the PRE-EXISTING lines, not about the tail never
// growing (which is how pi_flow_run_start_seconds and pi_flow_gate_wait_seconds
// each landed too). Retirement of the v1 state-vocabulary lines belongs to
// phase 7, after the 6.5 cutover.
const V2_METRICS = [
  'pi_flow_state',
  'pi_flow_phase',
  'pi_flow_wait_seconds',
  'pi_flow_step',
]

test('additive metrics are appended last and existing lines keep their order', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(1), 'paused'),
    noteText(shift(2), 'human answered'),
    gateAnswer(shift(3), 'spec-review', 'approve'),
    sweep(shift(4), 'removed'),
    attemptRecord(shift(5), 'retry', 2),
  ])
  const withoutAdditive = lines.filter(
    (line) =>
      !line.startsWith('pi_flow_run_start_seconds') &&
      !line.startsWith('pi_flow_gate_wait_seconds') &&
      !V2_METRICS.some((metric) => line.startsWith(metric)),
  )
  assert.deepEqual(
    withoutAdditive.map((line) => line.split('{')[0]),
    [
      'pi_flow_run_status',
      'pi_flow_gate_decisions_total',
      'pi_flow_human_wait_seconds',
      'pi_flow_retry_attempts',
      'pi_flow_blocker_retries',
      'pi_flow_worktree_sweep_total',
    ],
  )
  // the whole body, byte-for-byte: six frozen lines in their original order,
  // then the additive lines (start epoch first, then the per-gate waits, then
  // the v2 state-machine block in its plan table order).
  assert.deepEqual(lines, [
    'pi_flow_run_status{ref="PMR-H",status="paused"} 1',
    'pi_flow_gate_decisions_total{ref="PMR-H",gate="spec-review",choice="approve"} 1',
    'pi_flow_human_wait_seconds{ref="PMR-H"} 1',
    'pi_flow_retry_attempts{ref="PMR-H"} 2',
    'pi_flow_blocker_retries{ref="PMR-H"} 0',
    'pi_flow_worktree_sweep_total{ref="PMR-H",outcome="removed"} 1',
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 0',
    `pi_flow_state{ref="PMR-H",state="waiting_human",reason=""} 1`,
    `pi_flow_state_start_seconds{ref="PMR-H",state="waiting_human",reason=""} ${START_SECONDS + 1}`,
    `pi_flow_phase{ref="PMR-H",phase="validate"} 1`,
    `pi_flow_wait_seconds{ref="PMR-H",wait_kind="human",reason=""} 1`,
  ])
  assert.equal(withoutAdditive.length, 6)
})

// ---------------------------------------------------------- per-gate wait

const GATE_WAIT = 'pi_flow_gate_wait_seconds'

test('gate wait seconds come from the paused window the gate-answer closed', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    gateAnswer(shift(120), 'spec-review', 'approve'),
  ])
  assert.equal(
    findLine(lines, GATE_WAIT),
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 120',
  )
  // the same 120s is in the aggregate: sum(gate waits) <= human wait.
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 120',
  )
})

test('a second answer for the same gate gets n=2', () => {
  // reject -> rework -> approve: each answer closes its own paused window.
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    gateAnswer(shift(30), 'spec-review', 'reject'),
    loopState(shift(40), 'paused'),
    gateAnswer(shift(90), 'spec-review', 'approve'),
  ])
  const gateWait = lines.filter((line) => line.startsWith(GATE_WAIT))
  assert.deepEqual(gateWait, [
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="reject",n="1"} 30',
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="2"} 50',
  ])
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 80',
  )
})

test('a gate-answer that closes no paused window emits 0', () => {
  // The answer arrived while the run was 'running' — the occurrence is still
  // emitted so n stays gapless and the board shows 'this step blocked nothing'.
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'running'),
    gateAnswer(shift(10), 'code-review', 'pass'),
  ])
  assert.equal(
    findLine(lines, GATE_WAIT),
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="code-review",choice="pass",n="1"} 0',
  )
  assert.equal(findLine(lines, 'pi_flow_human_wait_seconds'), undefined)
})

test('a window closed by a non-gate-answer event attributes 0 to the later answer', () => {
  // The 60s stay in pi_flow_human_wait_seconds only — the gate-answer at +70
  // found no open window. Intentional asymmetry (see the run-health NOTE).
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    loopState(shift(60), 'running'),
    gateAnswer(shift(70), 'spec-review', 'approve'),
  ])
  assert.equal(
    findLine(lines, GATE_WAIT),
    'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 0',
  )
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 60',
  )
})

test('n counts occurrences per gate, not per run', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    gateAnswer(shift(20), 'spec-review', 'approve'),
    loopState(shift(30), 'paused'),
    gateAnswer(shift(45), 'code-review', 'pass'),
  ])
  assert.deepEqual(
    lines.filter((line) => line.startsWith(GATE_WAIT)),
    [
      'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 20',
      'pi_flow_gate_wait_seconds{ref="PMR-H",gate="code-review",choice="pass",n="1"} 15',
    ],
  )
})

test('no gate wait lines when the journal has no gate-answer events', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    loopState(shift(0), 'paused'),
    noteText(shift(60), 'human answered'),
  ])
  assert.equal(findLine(lines, GATE_WAIT), undefined)
  assert.equal(
    findLine(lines, 'pi_flow_human_wait_seconds'),
    'pi_flow_human_wait_seconds{ref="PMR-H"} 60',
  )
})

test('gate wait lines follow journal order of the gate-answer events', () => {
  const lines = renderRunHealthLines(REF, [
    runStart(),
    gateAnswer(shift(5), 'code-review', 'fail'),
    loopState(shift(10), 'paused'),
    gateAnswer(shift(20), 'spec-review', 'approve'),
  ])
  assert.deepEqual(
    lines.filter((line) => line.startsWith(GATE_WAIT)),
    [
      'pi_flow_gate_wait_seconds{ref="PMR-H",gate="code-review",choice="fail",n="1"} 0',
      'pi_flow_gate_wait_seconds{ref="PMR-H",gate="spec-review",choice="approve",n="1"} 10',
    ],
  )
  // additive block sits after every pre-existing line
  const lastFrozen = lines.lastIndexOf(
    `pi_flow_run_start_seconds{ref="PMR-H"} ${START_SECONDS}`,
  )
  const firstGateWait = lines.findIndex((line) => line.startsWith(GATE_WAIT))
  assert.ok(firstGateWait > lastFrozen, lines.join('\n'))
})
