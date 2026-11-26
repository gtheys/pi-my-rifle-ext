// AIDEV-NOTE: PMR-ZV9Y 3.1 — tests for the pure v2 journal→Prometheus
// derivation (flow/state-metrics.ts). These lines are the render half of
// ISC-1 and the old-journal fallback half of ISC-6, so the load-bearing
// invariants pinned here are: (a) the legacy fallback (a journal with no
// 'state-change' events still renders v2 state from the projected loop
// status, with reason ""); (b) window arithmetic — re-opened waits SUM and
// an unclosed window contributes NOTHING (same posture as
// scanPausedWindows in run-health.ts); (c) closed-enum labels only
// (ISC-A-1) — a drifted enum value is never a label value; (d) the six
// families render in the plan's table order, bare sample lines, no `mode`
// label and no comment lines (push.ts drops every `#` line when it reads a
// group back, so an emitted `# TYPE` would make a tombstone re-POST
// inconsistent with the first push).
//
// Deliberately a NEW file: run-health.test.ts stays untouched (ISC-A-4).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  deriveV2State,
  renderStateMetricLines,
  scanStateWindows,
  scanStepWindows,
} from '../flow/state-metrics.ts'
import type { FlowReason, FlowState } from '../flow/vocabulary.ts'
import type { FlowPhase, FlowRunEvent, LoopRunStatus } from '../run-state.ts'

const REF = 'PMR-SM'
const T0 = '2026-11-25T09:00:00.000Z'

function shift(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString()
}

function epoch(at: string): number {
  return Math.floor(Date.parse(at) / 1000)
}

/** Decode a scanStateWindows key ("wait_kind\u0000reason"). */
function waitEntries(
  map: Map<string, number>,
): Array<[waitKind: string, reason: string, seconds: number]> {
  const out: Array<[string, string, number]> = []
  for (const [key, seconds] of map) {
    const separator = key.indexOf('\u0000')
    out.push([key.slice(0, separator), key.slice(separator + 1), seconds])
  }
  return out
}

/** Decode a scanStepWindows key ("phase\u0000step"). */
function stepEntries(
  map: Map<string, number>,
): Array<[phase: string, step: string, seconds: number]> {
  const out: Array<[string, string, number]> = []
  for (const [key, seconds] of map) {
    const separator = key.indexOf('\u0000')
    out.push([key.slice(0, separator), key.slice(separator + 1), seconds])
  }
  return out
}

function runStart(at = T0): FlowRunEvent {
  return { kind: 'run-start', at, ref: REF, mode: 'personal' }
}

function change(
  state: FlowState,
  reason: FlowReason | '',
  at: string,
): FlowRunEvent {
  return { kind: 'state-change', at, ref: REF, state, reason }
}

function step(
  kind: 'step-start' | 'step-stop',
  phase: FlowPhase,
  name: string,
  at: string,
): FlowRunEvent {
  return { kind, at, ref: REF, phase, step: name }
}

function loopState(
  at: string,
  status: LoopRunStatus,
  phase: FlowPhase = 'plan',
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

// --- deriveV2State: the v2 fold ------------------------------------------

test('empty journal derives no v2 state and renders no lines', () => {
  assert.equal(deriveV2State([]), null)
  assert.deepEqual(renderStateMetricLines(REF, []), [])
})

test('a journal without a run-start derives nothing (run-health posture)', () => {
  // projectRunState returns null with no run-start, and renderRunHealthLines
  // emits nothing for that journal — the v2 derivation must agree, otherwise
  // the two blocks in one push body would describe different runs.
  const events = [change('waiting_human', 'escalation', shift(60))]
  assert.equal(deriveV2State(events), null)
  assert.deepEqual(renderStateMetricLines(REF, events), [])
})

test('deriveV2State takes the LAST state-change (duplicate transitions)', () => {
  const events = [
    runStart(),
    change('running', '', shift(0)),
    change('waiting_human', 'spec_approval_pending', shift(60)),
    change('running', '', shift(120)),
    change('waiting_machine', 'subagent_in_flight', shift(180)),
    change('waiting_machine', 'subagent_in_flight', shift(190)),
  ]
  assert.deepEqual(deriveV2State(events), {
    state: 'waiting_machine',
    reason: 'subagent_in_flight',
    at: shift(190),
  })
})

test('deriveV2State keeps an empty reason for states that carry none', () => {
  const events = [runStart(), change('running', '', shift(30))]
  assert.deepEqual(deriveV2State(events), {
    state: 'running',
    reason: '',
    at: shift(30),
  })
})

test('an out-of-vocabulary state-change never reaches a label value', () => {
  // Lenient journals (ISC-A-1): the drift is ignored by the fold, so the
  // derivation keeps describing the last IN-vocabulary transition.
  const events: FlowRunEvent[] = [
    runStart(),
    change('waiting_human', 'escalation', shift(60)),
    {
      kind: 'state-change',
      at: shift(120),
      ref: REF,
      state: 'paused' as string as FlowState,
      reason: 'whatever_i_wrote' as string as FlowReason,
    },
  ]
  assert.deepEqual(deriveV2State(events), {
    state: 'waiting_human',
    reason: 'escalation',
    at: shift(60),
  })
  const lines = renderStateMetricLines(REF, events)
  for (const line of lines) {
    assert.ok(!line.includes('paused'), `drifted state leaked: ${line}`)
    assert.ok(
      !line.includes('whatever_i_wrote'),
      `drifted reason leaked: ${line}`,
    )
  }
})

// --- ISC-6: the legacy fallback -----------------------------------------

test('ISC-6 legacy journal maps paused to waiting_human with reason ""', () => {
  const events = [runStart(), loopState(shift(300), 'paused')]
  assert.deepEqual(deriveV2State(events), {
    state: 'waiting_human',
    reason: '',
    at: shift(300),
  })
})

test('ISC-6 legacy journal maps halted, running and done verbatim', () => {
  const halted = [runStart(), loopState(shift(10), 'halted', 'validate')]
  assert.deepEqual(deriveV2State(halted), {
    state: 'halted',
    reason: '',
    at: shift(10),
  })
  const running = [runStart(), loopState(shift(20), 'running')]
  assert.deepEqual(deriveV2State(running), {
    state: 'running',
    reason: '',
    at: shift(20),
  })
  const done = [runStart(), loopState(shift(30), 'done')]
  assert.deepEqual(deriveV2State(done), {
    state: 'done',
    reason: '',
    at: shift(30),
  })
})

test('legacy journal with no loop-state derives nothing', () => {
  // The projection has neither currentState nor loop, so there is no state
  // to report: no lines at all rather than an invented 'running'.
  const events: FlowRunEvent[] = [
    runStart(),
    { kind: 'note', at: shift(5), ref: REF, text: 'hi' },
  ]
  assert.equal(deriveV2State(events), null)
  assert.deepEqual(renderStateMetricLines(REF, events), [])
})

test('the last legacy loop snapshot wins (restart re-journals status)', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'paused'),
    loopState(shift(20), 'running'),
  ]
  assert.deepEqual(deriveV2State(events), {
    state: 'running',
    reason: '',
    at: shift(20),
  })
})

test('v2 state-change wins over the legacy loop status', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'paused'),
    change('done', '', shift(20)),
  ]
  assert.deepEqual(deriveV2State(events), {
    state: 'done',
    reason: '',
    at: shift(20),
  })
})

// --- scanStateWindows ----------------------------------------------------

test('re-opened wait windows sum into the same (wait_kind, reason) bucket', () => {
  const events = [
    runStart(),
    change('running', '', shift(0)),
    change('waiting_human', 'code_review_pending', shift(100)),
    change('running', '', shift(200)),
    change('waiting_human', 'code_review_pending', shift(300)),
    change('running', '', shift(450)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', 'code_review_pending', 250],
  ])
})

test('an unclosed wait window contributes nothing', () => {
  const events = [
    runStart(),
    change('running', '', shift(0)),
    change('waiting_human', 'escalation', shift(100)),
  ]
  assert.equal(scanStateWindows(events).seconds.size, 0)
})

test('a reason change re-opens the wait bucket (state stays waiting_human)', () => {
  const events = [
    runStart(),
    change('waiting_human', 'spec_approval_pending', shift(100)),
    change('waiting_human', 'code_review_pending', shift(200)),
    change('running', '', shift(300)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', 'spec_approval_pending', 100],
    ['human', 'code_review_pending', 100],
  ])
})

test('only waiting_human / waiting_machine windows are waits', () => {
  const events = [
    runStart(),
    change('running', '', shift(0)),
    change('halted', 'label_miss', shift(100)),
    change('running', '', shift(400)),
    change('done', '', shift(500)),
    change('waiting_machine', 'retry_budget_exhausted', shift(600)),
    change('running', '', shift(650)),
    change('stale', '', shift(700)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['machine', 'retry_budget_exhausted', 50],
  ])
})

// AIDEV-NOTE: worker-ask-wait fix — subagent_ask_pending must pass the
// FLOW_REASONS vocabulary filter in stateTransitions (an unregistered reason is
// silently DROPPED there, which would make the new human wait invisible on the
// board even though the loop emits it). Pinned as a rendered line, not only a
// bucket, so a vocabulary/filter regression shows up as a missing series.
test('subagent_ask_pending is in the reason vocabulary and buckets as a human wait', () => {
  const events = [
    runStart(),
    change('waiting_machine', 'subagent_in_flight', shift(0)),
    change('waiting_human', 'subagent_ask_pending', shift(60)),
    change('running', '', shift(160)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['machine', 'subagent_in_flight', 60],
    ['human', 'subagent_ask_pending', 100],
  ])
  const lines = renderStateMetricLines(REF, events)
  assert.ok(
    lines.includes(
      `pi_flow_wait_seconds{ref="${REF}",wait_kind="human",reason="subagent_ask_pending"} 100`,
    ),
    lines.join('\n'),
  )
})

test('wait_kind comes from the reason, not the state label', () => {
  // The plan derives wait_kind from the reason enum; a drifted writer that
  // pairs a human reason with waiting_machine still buckets as human.
  const events = [
    runStart(),
    change('waiting_machine', 'escalation', shift(100)),
    change('running', '', shift(150)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', 'escalation', 50],
  ])
})

test('a waiting window with no reason falls back to the state for wait_kind', () => {
  const events = [
    runStart(),
    change('waiting_human', '', shift(100)),
    change('running', '', shift(150)),
    change('waiting_machine', '', shift(200)),
    change('running', '', shift(250)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', '', 50],
    ['machine', '', 50],
  ])
})

test('fractional windows keep run-health unfloored millisecond math', () => {
  const events = [
    runStart(),
    change('waiting_human', 'escalation', shift(100)),
    change('running', '', '2026-11-25T09:02:10.500Z'),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', 'escalation', 30.5],
  ])
})

test('ISC-6 legacy fallback reuses the paused-window scan (human, reason "")', () => {
  // Mirrors scanPausedWindows: consecutive paused snapshots do not restart
  // the clock, the window closes at the first non-paused event, and a
  // trailing paused window contributes nothing.
  const events = [
    runStart(),
    loopState(shift(100), 'paused'),
    loopState(shift(120), 'paused'),
    loopState(shift(140), 'running'),
    loopState(shift(200), 'paused'),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', '', 40],
  ])
})

test('a v2 journal does not also run the legacy paused scan', () => {
  // Mixed journal: the paused snapshot before the first state-change must
  // not double-count the same wait.
  const events = [
    runStart(),
    loopState(shift(100), 'paused'),
    loopState(shift(200), 'paused'),
    change('running', '', shift(400)),
    change('waiting_human', 'escalation', shift(500)),
    change('running', '', shift(560)),
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [
    ['human', 'escalation', 60],
  ])
})

test('unparseable or absent timestamps never throw and never count', () => {
  const events: FlowRunEvent[] = [
    runStart(),
    change('waiting_human', 'escalation', 'not-a-date'),
    change('running', '', shift(600)),
    change('waiting_human', 'escalation', shift(700)),
    {
      kind: 'state-change',
      at: 1234 as unknown as string,
      ref: REF,
      state: 'running',
      reason: '',
    },
  ]
  assert.deepEqual(waitEntries(scanStateWindows(events).seconds), [])
  // the numeric `at` is out of vocabulary for the fold (applyEvent requires a
  // string), so the last usable transition is the escalation wait.
  assert.deepEqual(deriveV2State(events), {
    state: 'waiting_human',
    reason: 'escalation',
    at: shift(700),
  })
})

// --- scanStepWindows -----------------------------------------------------

test('step windows pair start to stop and accumulate per (phase, step)', () => {
  const events = [
    runStart(),
    step('step-start', 'plan', 'plan.spec-approval', shift(100)),
    step('step-stop', 'plan', 'plan.spec-approval', shift(400)),
  ]
  const scan = scanStepWindows(events)
  assert.deepEqual(stepEntries(scan.seconds), [
    ['plan', 'plan.spec-approval', 300],
  ])
  assert.deepEqual(scan.open, [])
})

test('an open step contributes no seconds but stays in flight', () => {
  const events = [
    runStart(),
    step('step-start', 'validate', 'validate.code-review', shift(100)),
  ]
  const scan = scanStepWindows(events)
  assert.equal(scan.seconds.size, 0)
  assert.deepEqual(scan.open, [
    { phase: 'validate', step: 'validate.code-review' },
  ])
})

test('a duplicate step-start re-begins the clock (last-start-wins)', () => {
  // Process restart / re-ask: the journaled stop evidences the work that
  // just finished, so the abandoned attempt's clock is dropped instead of
  // inflating the step duration with dead time.
  const events = [
    runStart(),
    step('step-start', 'validate', 'validate.deviation', shift(100)),
    step('step-start', 'validate', 'validate.deviation', shift(500)),
    step('step-stop', 'validate', 'validate.deviation', shift(600)),
  ]
  assert.deepEqual(stepEntries(scanStepWindows(events).seconds), [
    ['validate', 'validate.deviation', 100],
  ])
})

test('a step-stop without a matching start is ignored', () => {
  const events = [
    runStart(),
    step('step-stop', 'plan', 'plan.spec-approval', shift(100)),
  ]
  const scan = scanStepWindows(events)
  assert.equal(scan.seconds.size, 0)
  assert.deepEqual(scan.open, [])
})

test('re-opened steps sum and distinct steps keep separate keys', () => {
  const events = [
    runStart(),
    step('step-start', 'validate', 'validate.deviation', shift(100)),
    step('step-stop', 'validate', 'validate.deviation', shift(150)),
    step('step-start', 'validate', 'validate.deviation', shift(200)),
    step('step-stop', 'validate', 'validate.deviation', shift(275)),
    step('step-start', 'plan', 'plan.spec-approval', shift(300)),
    step('step-stop', 'plan', 'plan.spec-approval', shift(360)),
  ]
  assert.deepEqual(stepEntries(scanStepWindows(events).seconds), [
    ['validate', 'validate.deviation', 125],
    ['plan', 'plan.spec-approval', 60],
  ])
})

test('an unregistered free-text step name is never a label value', () => {
  // ISC-A-1: the `step` label is registry-closed at the render boundary since
  // fix-round-3 (deviation #3) — scanStepWindows consults
  // isRegisteredStep(flow/steps.ts) — on top of the structural charset guard
  // that rejects free text before the lookup. (Originally the derivation could
  // not import the registry under the node-only allowlist and relied on the
  // charset alone; that is superseded, but this fixture's outcome is unchanged:
  // 'look at the diff please' fails the charset, the 'research' phase fails the
  // PHASE_VALUES gate, and only the registered validate.code-review pair
  // survives.)
  const events: FlowRunEvent[] = [
    runStart(),
    step('step-start', 'validate', 'look at the diff please', shift(100)),
    step('step-start', 'validate', 'validate.code-review', shift(200)),
    step('step-stop', 'validate', 'validate.code-review', shift(300)),
    {
      kind: 'step-start',
      at: shift(400),
      ref: REF,
      phase: 'research' as string as FlowPhase,
      step: 'research.spec-diff',
    },
  ]
  const scan = scanStepWindows(events)
  assert.deepEqual(stepEntries(scan.seconds), [
    ['validate', 'validate.code-review', 100],
  ])
  assert.deepEqual(scan.open, [])
})

// AIDEV-NOTE: PMR-ZV9Y fix-round-3 (deviation #3) — the `step` label is now
// registry-CLOSED, not charset-only. The spec (plan.md:37) says
// "Registered names only"; a closed enum as a label value is what bounds
// cardinality (ISC-A-1). scanStepWindows is the PURE Prometheus derivation
// (it feeds pi_flow_step AND pi_flow_step_seconds and nothing else — Loki/Tempo
// read the RAW events through telemetry/dispatch.ts), so the registry gate
// lives here: an unregistered name contributes neither an open step nor a
// completed bucket, so it reaches NEITHER gauge. implement/feedback registries
// are EMPTY by design (free-form flow_submit step names), so EVERY
// implement/feedback step is now ignored on the Prometheus surface. The journal
// + Loki line still carry them — only the label surface is registry-closed.
test('registry gating: an unregistered (charset-valid) step is dropped from BOTH scans', () => {
  const events = [
    runStart(),
    // charset-valid (matches STEP_NAME_RE) but NOT in STEP_REGISTRY.validate.
    step('step-start', 'validate', 'validate.bogus', shift(100)),
    step('step-stop', 'validate', 'validate.bogus', shift(200)),
    // implement registry is empty -> even a well-formed name is unregistered.
    step('step-start', 'implement', 'implement.any-freeform', shift(100)),
  ]
  const scan = scanStepWindows(events)
  assert.equal(
    scan.seconds.size,
    0,
    'no completed bucket for unregistered steps',
  )
  assert.deepEqual(scan.open, [], 'no open step for unregistered steps')
})

test('registry gating: pi_flow_step AND pi_flow_step_seconds carry ONLY registered names', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'running', 'validate'),
    change('running', '', shift(10)),
    // registered + completed -> pi_flow_step_seconds only.
    step('step-start', 'validate', 'validate.code-review', shift(20)),
    step('step-stop', 'validate', 'validate.code-review', shift(80)),
    // registered + open -> pi_flow_step only (state is waiting_machine = live).
    step('step-start', 'validate', 'validate.deviation', shift(90)),
    // unregistered charset-valid -> ignored in BOTH gauges.
    step('step-start', 'validate', 'validate.bogus', shift(95)),
    step('step-stop', 'validate', 'validate.bogus', shift(120)),
    // free-form implement step -> ignored in BOTH gauges (empty registry).
    step('step-start', 'implement', 'implement.any-freeform', shift(100)),
    change('waiting_machine', 'subagent_in_flight', shift(130)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.deepEqual(
    lines.filter((l) => l.startsWith('pi_flow_step{')),
    [`pi_flow_step{ref="${REF}",phase="validate",step="validate.deviation"} 1`],
    lines.join('\n'),
  )
  assert.deepEqual(
    lines.filter((l) => l.startsWith('pi_flow_step_seconds{')),
    [
      `pi_flow_step_seconds{ref="${REF}",phase="validate",step="validate.code-review"} 60`,
    ],
    lines.join('\n'),
  )
})

// --- renderStateMetricLines ---------------------------------------------

// AIDEV-NOTE: PMR-ZV9Y fix round (P3a) — the open-step line is a LIVE-state
// signal. A run that ends with an unclosed step (a code-review ask aborted, a
// deviation verdict that kept mandating re-runs, a spec-approval pause on a
// ticket later closed) has NO in-flight step any more once it is halted/done/
// stale, but `scanStepWindows.open` still reports the unmatched start. The
// gateway merges on write, so that phantom `pi_flow_step` line persists in the
// stored group and surfaces on the piflow-runs Live-state row for a dead run.
// renderStateMetricLines therefore suppresses open-step lines whenever the
// DERIVED state is halted / done / stale — running and the two waiting states
// keep them (a genuinely open step is real there).
test('P3a: an unmatched step-start renders NO pi_flow_step once the run is halted', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'halted', 'validate'),
    change('halted', 'label_miss', shift(20)),
    // started, never stopped — but the run HALTED with the step open.
    step('step-start', 'validate', 'validate.code-review', shift(5)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_step{')).length,
    0,
    lines.join('\n'),
  )
  // the run is still described by the halted state line, not by an in-flight step
  assert.ok(
    lines.some(
      (l) => l.startsWith('pi_flow_state{') && l.includes('state="halted"'),
    ),
    lines.join('\n'),
  )
})

test('P3a: an unmatched step-start renders NO pi_flow_step once the run is done', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'done', 'feedback'),
    change('done', '', shift(20)),
    step('step-start', 'validate', 'validate.deviation', shift(5)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_step{')).length,
    0,
    lines.join('\n'),
  )
})

test('P3a: a stale derived state renders NO pi_flow_step (tombstone re-render guard)', () => {
  const events = [
    runStart(),
    change('stale', '', shift(10)),
    step('step-start', 'implement', 'implement.oneshot', shift(5)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_step{')).length,
    0,
    lines.join('\n'),
  )
})

test('P3a: a running run KEEPS the open-step line (genuinely in flight)', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'running', 'validate'),
    change('running', '', shift(10)),
    step('step-start', 'validate', 'validate.code-review', shift(15)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.ok(
    lines.some((line) =>
      line.startsWith(
        `pi_flow_step{ref="${REF}",phase="validate",step="validate.code-review"}`,
      ),
    ),
    lines.join('\n'),
  )
})

test('P3a: a waiting run KEEPS the open-step line (the wait is the step)', () => {
  // spec-approval pause: waiting_human with plan.spec-approval open — that IS
  // the live in-flight step and must keep rendering (it is what the boards
  // show for a run genuinely parked mid-step).
  const events = [
    runStart(),
    change('waiting_human', 'spec_approval_pending', shift(10)),
    step('step-start', 'plan', 'plan.spec-approval', shift(10)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.ok(
    lines.some((line) => line.startsWith('pi_flow_step{')),
    lines.join('\n'),
  )
})

test('happy path renders the six families in the plan table order', () => {
  const events = [
    runStart(),
    loopState(shift(30), 'running', 'plan'),
    change('running', '', shift(30)),
    change('waiting_human', 'spec_approval_pending', shift(60)),
    step('step-start', 'plan', 'plan.spec-approval', shift(60)),
    step('step-stop', 'plan', 'plan.spec-approval', shift(600)),
    change('running', '', shift(600)),
    loopState(shift(660), 'running', 'validate'),
    change('waiting_machine', 'subagent_in_flight', shift(660)),
    change('running', '', shift(720)),
    change('waiting_human', 'code_review_pending', shift(780)),
    step('step-start', 'validate', 'validate.code-review', shift(780)),
    change('waiting_human', 'escalation', shift(840)),
  ]
  assert.deepEqual(renderStateMetricLines(REF, events), [
    `pi_flow_state{ref="${REF}",state="waiting_human",reason="escalation"} 1`,
    `pi_flow_state_start_seconds{ref="${REF}",state="waiting_human",reason="escalation"} ${epoch(shift(840))}`,
    `pi_flow_phase{ref="${REF}",phase="validate"} 1`,
    `pi_flow_wait_seconds{ref="${REF}",wait_kind="human",reason="spec_approval_pending"} 540`,
    `pi_flow_wait_seconds{ref="${REF}",wait_kind="machine",reason="subagent_in_flight"} 60`,
    `pi_flow_wait_seconds{ref="${REF}",wait_kind="human",reason="code_review_pending"} 60`,
    `pi_flow_step{ref="${REF}",phase="validate",step="validate.code-review"} 1`,
    `pi_flow_step_seconds{ref="${REF}",phase="plan",step="plan.spec-approval"} 540`,
  ])
})

test('renderStateMetricLines is deterministic for identical input', () => {
  const events = [
    runStart(),
    change('waiting_human', 'escalation', shift(10)),
    change('running', '', shift(70)),
    step('step-start', 'validate', 'validate.deviation', shift(80)),
  ]
  assert.deepEqual(
    renderStateMetricLines(REF, events),
    renderStateMetricLines(REF, events),
  )
})

test('no comment lines, no mode label, no free-text labels', () => {
  const events = [
    runStart(),
    change('halted', 'prompt_send_failed', shift(60)),
    loopState(shift(60), 'halted', 'implement'),
    step('step-start', 'implement', 'implement.work', shift(60)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.ok(lines.length > 0, 'expected lines for a halted run')
  for (const line of lines) {
    assert.ok(!line.startsWith('#'), `comment line emitted: ${line}`)
    assert.ok(!line.includes('mode='), `mode label emitted: ${line}`)
  }
})

test('a state with an unparseable at renders the gauge but no start line', () => {
  // run-health's epochSeconds posture: an unusable timestamp means no line
  // for that series, never a NaN in the exposition body and never a throw.
  // The wait window it closes is unmeasurable, so it contributes nothing.
  const events: FlowRunEvent[] = [
    runStart(),
    loopState(shift(30), 'running', 'implement'),
    change('waiting_human', 'escalation', shift(60)),
    {
      kind: 'state-change',
      at: 'yesterday',
      ref: REF,
      state: 'halted',
      reason: 'label_miss',
    },
  ]
  assert.deepEqual(renderStateMetricLines(REF, events), [
    `pi_flow_state{ref="${REF}",state="halted",reason="label_miss"} 1`,
    `pi_flow_phase{ref="${REF}",phase="implement"} 1`,
  ])
})

test('legacy journal renders v2 state, phase and a reason-less human wait', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'running', 'validate'),
    loopState(shift(100), 'paused', 'validate'),
    loopState(shift(400), 'running', 'validate'),
  ]
  assert.deepEqual(renderStateMetricLines(REF, events), [
    `pi_flow_state{ref="${REF}",state="running",reason=""} 1`,
    `pi_flow_state_start_seconds{ref="${REF}",state="running",reason=""} ${epoch(shift(400))}`,
    `pi_flow_phase{ref="${REF}",phase="validate"} 1`,
    `pi_flow_wait_seconds{ref="${REF}",wait_kind="human",reason=""} 300`,
  ])
})

test('a done run with no waits and no open steps renders state and phase only', () => {
  const events = [
    runStart(),
    loopState(shift(10), 'done', 'feedback'),
    change('done', '', shift(20)),
  ]
  assert.deepEqual(renderStateMetricLines(REF, events), [
    `pi_flow_state{ref="${REF}",state="done",reason=""} 1`,
    `pi_flow_state_start_seconds{ref="${REF}",state="done",reason=""} ${epoch(shift(20))}`,
    `pi_flow_phase{ref="${REF}",phase="feedback"} 1`,
  ])
})

test('phase falls back to the projected currentPhase without a loop snapshot', () => {
  const events: FlowRunEvent[] = [
    runStart(),
    { kind: 'phase-start', at: shift(5), ref: REF, phase: 'implement' },
    change('waiting_machine', 'subagent_in_flight', shift(10)),
  ]
  const lines = renderStateMetricLines(REF, events)
  assert.ok(
    lines.includes(`pi_flow_phase{ref="${REF}",phase="implement"} 1`),
    lines.join('\n'),
  )
})

test('a phase-complete that clears currentPhase without a loop emits no phase line', () => {
  const events: FlowRunEvent[] = [
    runStart(),
    { kind: 'phase-start', at: shift(5), ref: REF, phase: 'plan' },
    {
      kind: 'phase-complete',
      at: shift(10),
      ref: REF,
      phase: 'plan',
      label: 'plan done',
    },
    change('running', '', shift(20)),
  ]
  const lines = renderStateMetricLines(REF, events)
  for (const line of lines) {
    assert.ok(
      !line.startsWith('pi_flow_phase'),
      `unexpected phase line: ${line}`,
    )
  }
})

test('every wait bucket line is emitted in first-seen order', () => {
  const events = [
    runStart(),
    change('waiting_machine', 'subagent_in_flight', shift(10)),
    change('waiting_human', 'escalation', shift(20)),
    change('running', '', shift(40)),
    change('waiting_machine', 'subagent_in_flight', shift(60)),
    change('running', '', shift(80)),
  ]
  assert.deepEqual(
    renderStateMetricLines(REF, events).filter((line) =>
      line.startsWith('pi_flow_wait_seconds'),
    ),
    [
      `pi_flow_wait_seconds{ref="${REF}",wait_kind="machine",reason="subagent_in_flight"} 30`,
      `pi_flow_wait_seconds{ref="${REF}",wait_kind="human",reason="escalation"} 20`,
    ],
  )
})

test('open steps render after the waits and before the step seconds', () => {
  const events = [
    runStart(),
    step('step-start', 'validate', 'validate.deviation', shift(10)),
    step('step-stop', 'validate', 'validate.deviation', shift(60)),
    step('step-start', 'validate', 'validate.code-review', shift(70)),
    change('waiting_human', 'escalation', shift(80)),
    change('running', '', shift(100)),
    change('waiting_human', 'escalation', shift(120)),
    step('step-stop', 'validate', 'validate.code-review', shift(200)),
    change('running', '', shift(210)),
    step('step-start', 'plan', 'plan.spec-approval', shift(220)),
  ]
  const lines = renderStateMetricLines(REF, events)
  const names = lines.map((line) => line.slice(0, line.indexOf('{')))
  assert.deepEqual(names, [
    'pi_flow_state',
    'pi_flow_state_start_seconds',
    'pi_flow_wait_seconds',
    'pi_flow_step',
    'pi_flow_step_seconds',
    'pi_flow_step_seconds',
  ])
  assert.ok(
    lines.some((line) =>
      line.startsWith(
        `pi_flow_step{ref="${REF}",phase="plan",step="plan.spec-approval"}`,
      ),
    ),
    lines.join('\n'),
  )
})
