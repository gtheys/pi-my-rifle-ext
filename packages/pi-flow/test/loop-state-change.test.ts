// AIDEV-NOTE: PMR-ZV9Y 2.1 — loop v2 state-machine emission tests. The loop
// emits `state-change`/`step-start`/`step-stop` through the OPTIONAL
// `deps.journalV2` seam (wired in index.ts to the SAME journal() writer as
// `deps.journal`). These tests follow the loop.test.ts deps-mock pattern but
// capture v2 events in their own `v2` array, so the existing loop.test.ts
// `h.events` kind-sequence assertions stay byte-identical (ISC-A-2: the
// v1 loop-state/journal stream is untouched).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFlowLoop,
  type FlowLoopDeps,
  resumeV2StateFromEvents,
} from '../flow/loop.ts'
import { deriveV2State, renderStateMetricLines } from '../flow/state-metrics.ts'
import { type FlowRunEvent, projectRunState } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import {
  createEventFanoutWriter,
  type FanoutHandlers,
} from '../telemetry/dispatch.ts'

interface Harness {
  deps: FlowLoopDeps
  sent: string[]
  notes: { ref: string; text: string }[]
  /** v1 journal stream — must stay exactly as loop.test.ts expects. */
  events: FlowRunEvent[]
  /** v2 emission stream (state-change / step-start / step-stop). */
  v2: FlowRunEvent[]
  notifications: { message: string; level: string }[]
  labels: string[] | null
  planState: string | null
  inFlight?: boolean
  /**
   * The `hasPendingSubagentAsk` dep (worker-ask-wait fix): true = an in-flight
   * child of this parent is blocked on an ask_owner question. Default false, so
   * every pre-existing in-flight test keeps asserting the machine wait; the
   * ABSENT-dep case is covered by deleting the key in its own test.
   */
  pendingAsk?: boolean
  /** when true, the journalV2 seam throws on every call. */
  v2Throws?: boolean
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    notes: [],
    events: [],
    v2: [],
    notifications: [],
    labels,
    planState: null,
    deps: undefined as unknown as FlowLoopDeps,
  }
  h.deps = {
    notify: (message, level) => {
      h.notifications.push({ message, level })
    },
    journal: (event) => {
      h.events.push(event)
    },
    journalV2: (event) => {
      if (h.v2Throws) throw new Error('v2 journal exploded')
      h.v2.push(event)
    },
    readLabels: async () => h.labels,
    readPlanState: async () => h.planState,
    avenNote: async (ref, text) => {
      h.notes.push({ ref, text })
      return true
    },
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => h.inFlight ?? false,
    hasPendingSubagentAsk: () => h.pendingAsk ?? false,
    sendPrompt: (prompt) => {
      h.sent.push(prompt)
    },
  }
  return h
}

const PROMPT_INPUT = {
  mode: 'personal' as const,
  ref: 'TP-1',
  gitRoot: '/home/x/repo',
  workRoots: [] as string[],
}

function startInput() {
  return {
    ref: 'TP-1',
    phase: 'plan' as const,
    promptInput: { ...PROMPT_INPUT },
  }
}

// AIDEV-NOTE: compact view of the v2 stream for readable assertions. State
// changes carry {state, reason}; step events carry {step, phase}.
function v2View(h: Harness) {
  return h.v2.map((e) => {
    if (e.kind === 'state-change')
      return { kind: e.kind, state: e.state, reason: e.reason }
    if (e.kind === 'step-start' || e.kind === 'step-stop') {
      return { kind: e.kind, phase: e.phase, step: e.step }
    }
    return { kind: e.kind }
  })
}

test('start: emits state-change{running} once (prompt-send running is guarded)', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  // The v1 loop-state stream is UNCHANGED — loop.test.ts green (ISC-A-2).
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['loop-state', 'phase-start', 'owner-session', 'loop-state'],
  )
})

test('aven-read halt: emits state-change{halted, aven_read_failed}', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = null
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'aven_read_failed' },
  ])
})

test('label-miss halt: emits state-change{halted, label_miss}', async () => {
  const h = makeHarness([]) // plan, no label, not review -> label_miss halt
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('blocker-budget halt: emits state-change{halted, blocker_budget_exhausted}', async () => {
  const h = makeHarness(['planned', 'active']) // validate label "review-passed" missing
  h.deps.hasFreshBlockers = async () => true
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'validate',
    promptInput: { ...PROMPT_INPUT },
    resume: { blockerRetries: 2, validateStartedAt: new Date().toISOString() },
  })
  await loop.onSettled() // budget (2 >= MAX-1) exhausted -> halt
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'halted',
      reason: 'blocker_budget_exhausted',
    },
  ])
})

test('prompt-send halt: emits state-change{halted, prompt_send_failed}', async () => {
  // work mode + empty workRoots -> validate prompt blocks in sendPhasePrompt.
  const h = makeHarness(['planned', 'active'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'validate',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'prompt_send_failed' },
  ])
})

test('spec-approval pause: emits state-change{waiting_human, spec_approval_pending} + step-start{plan.spec-approval}', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_human',
      reason: 'spec_approval_pending',
    },
    { kind: 'step-start', phase: 'plan', step: 'plan.spec-approval' },
  ])
})

test('subagent-in-flight: emits waiting_machine{subagent_in_flight}; next settle emits running (ISC-7)', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
  // child steers back, label lands -> advance emits running.
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

// ===========================================================================
// worker-ask-wait fix: an in-flight subagent that is BLOCKED ON THE HUMAN
// (ask_owner) is a human wait, not a machine wait. Before this fix the loop
// labelled every in-flight settle `waiting_machine{subagent_in_flight}`, so the
// Grafana "Waiting on me — act now" panel (state="waiting_human") never showed
// the run even though the human was the bottleneck.
// ===========================================================================

test('subagent-in-flight WITH a pending ask: emits waiting_human{subagent_ask_pending}', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_human',
      reason: 'subagent_ask_pending',
    },
  ])
  // Armed exactly as before: the wait ends when the child is answered and
  // steers back, and the next settle emits the running return (ISC-7 — still
  // NO loop-state snapshot in this branch).
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'loop-state').length,
    2,
    'the in-flight branch must not journal a loop-state snapshot',
  )
  h.pendingAsk = false
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(
    v2View(h).slice(2),
    [{ kind: 'state-change', state: 'running', reason: undefined }],
    'the answer + label landing returns the run to running',
  )
})

test('subagent-in-flight journal note says the child waits on the HUMAN when an ask is pending', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  const note = h.events.find((e) => e.kind === 'note')
  assert.ok(note && note.kind === 'note', 'the branch journals a note')
  if (note && note.kind === 'note') {
    assert.match(note.text, /waiting on the human/)
    // Still armed: the "flow stays armed" wording is what the operator reads
    // when they reopen the journal.
    assert.match(note.text, /flow stays armed/)
  }
})

test('subagent-in-flight WITHOUT a pending ask: unchanged waiting_machine{subagent_in_flight} and unchanged note', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = false
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
  const note = h.events.find((e) => e.kind === 'note')
  assert.ok(note && note.kind === 'note')
  if (note && note.kind === 'note') {
    assert.match(note.text, /a subagent is in flight/)
    assert.ok(!note.text.includes('waiting on the human'), note.text)
  }
})

test('hasPendingSubagentAsk dep ABSENT: fail closed to the old machine wait', async () => {
  // Optional dep (no fixture churn for older consumers): absent => false.
  const h = makeHarness([])
  h.inFlight = true
  delete h.deps.hasPendingSubagentAsk
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
})

test('pending ask WITHOUT an in-flight subagent: no human wait is claimed', async () => {
  // The ask probe only reclassifies the in-flight branch. A settle with no live
  // child but a leftover ask record (crashed child, record not yet cleaned) is
  // the ordinary label-miss halt — never a phantom "waiting on you" row.
  const h = makeHarness([])
  h.inFlight = false
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('done: emits state-change{done}', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed', 'done'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'feedback',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'done', reason: undefined },
  ])
})

test('resume seeds running and does NOT re-emit it (ISC-A-2 guarded)', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'running' })
  // start snapshot + prompt-send snapshot both guarded -> no v2 running.
  assert.deepEqual(v2View(h), [])
  // but a real transition still emits
  await loop.onSettled() // planned -> implement
  assert.deepEqual(v2View(h), [])
  // validate the seed derivation feeds the guard: a halt after seeded running
  // still emits halted.
})

test('resume seeds running then halts: only the halt emits (no duplicate running)', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'running' })
  await loop.onSettled() // no label -> label_miss halt
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('resume after waiting_human: seeded waiting_human -> running emitted', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'waiting_human' })
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('spec-approval resolution: step-stop{plan.spec-approval} journaled when plan advances after the pause', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  // human approves; re-run re-enters plan with the seeded prior state
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({ ...startInput(), resumeState: 'waiting_human' })
  await loop.onSettled() // planned lands -> advanceAfter('plan') -> step-stop
  const kinds = h.v2.map((e) => e.kind)
  assert.ok(kinds.includes('step-start'), 'pause must journal a step-start')
  assert.ok(kinds.includes('step-stop'), 'resolution must journal a step-stop')
  const stop = h.v2.find((e) => e.kind === 'step-stop')
  assert.ok(stop && stop.kind === 'step-stop')
  if (stop && stop.kind === 'step-stop') {
    assert.equal(stop.phase, 'plan')
    assert.equal(stop.step, 'plan.spec-approval')
  }
})

// ===========================================================================
// PMR-ZV9Y fix-round-3 (deviation #1): the plan.spec-approval step-stop timing.
// Spec Behaviour 3 (plan.md:68) — "the answer/spec-approve path journals
// step-stop{plan.spec-approval}; the loop's NEXT snapshot journals
// state-change{running}" — so on the restart that /flow answer triggers the
// journal ORDER must be step-stop THEN running. Before this fix the loop
// emitted running on the restart and deferred the stop to the plan phase-
// complete (advanceAfter), inverting the order, extending pi_flow_step_seconds
// / the Tempo span past the approval, and emitting NO stop at all if the run
// halted before plan completed. The fix closes the step at the earliest
// faithful site: start(), when the seeded specApprovalStepOpen flag says the
// approval step is still open. A reject restarts the loop the same way, so the
// wait ENDED (approve OR reject) and step-stop is correct for both.
// ===========================================================================

test('fix-round-3 #1: restart-after-approve journals step-stop BEFORE running (Behaviour 3 order)', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> waiting_human + step-start (flag open)
  const beforeRestart = h.v2.length
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  })
  assert.deepEqual(v2View(h).slice(beforeRestart), [
    { kind: 'step-stop', phase: 'plan', step: 'plan.spec-approval' },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('fix-round-3 #1: restart-after-reject journals step-stop BEFORE running (the wait ended)', async () => {
  // /flow answer reject routes back to plan work (spec to draft); the loop only
  // sees a restart with the approval step still open, exactly like approve. The
  // wait ENDED either way, so step-stop is correct for the reject path too.
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> waiting_human + step-start (flag open)
  const beforeRestart = h.v2.length
  h.planState = 'draft' // reject: spec went back to draft, no label landed yet
  h.labels = []
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  })
  assert.deepEqual(v2View(h).slice(beforeRestart), [
    { kind: 'step-stop', phase: 'plan', step: 'plan.spec-approval' },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('fix-round-3 #1: halt before plan completes still journals the step-stop, BEFORE the halt', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  }) // restart -> step-stop + running (the fix)
  // now halt before plan can complete (no label, not review -> label_miss).
  h.planState = 'draft'
  h.labels = []
  await loop.onSettled()
  const stopIdx = h.v2.findIndex((e) => e.kind === 'step-stop')
  const haltIdx = h.v2.findIndex(
    (e) => e.kind === 'state-change' && e.state === 'halted',
  )
  assert.ok(
    stopIdx >= 0,
    'a halt after an approval restart must still see a stop',
  )
  assert.ok(
    haltIdx > stopIdx,
    `stop must precede the halt: ${String(stopIdx)} vs ${String(haltIdx)}`,
  )
})

test('fix-round-3 #1: no double step-stop when advanceAfter later closes the plan phase', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  }) // restart -> step-stop (flag now cleared)
  await loop.onSettled() // planned lands -> advanceAfter('plan') -> must NOT re-stop
  const stops = h.v2.filter((e) => e.kind === 'step-stop')
  assert.equal(
    stops.length,
    1,
    `at-most-once stop, got ${String(stops.length)}: ${JSON.stringify(v2View(h))}`,
  )
})

test('fix-round-3 #1: a fresh run with no prior pause emits no step events', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(
    h.v2.filter((e) => e.kind === 'step-start' || e.kind === 'step-stop')
      .length,
    0,
    JSON.stringify(v2View(h)),
  )
})

test('journalV2 throwing never propagates and the loop still proceeds (ISC-A-5)', async () => {
  const h = makeHarness([])
  h.v2Throws = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // must not reject
  assert.equal(loop.isActive(), true)
  // v1 stream still intact and the halt still tears down despite v2 throws
  await loop.onSettled() // label miss -> halt
  assert.equal(loop.isActive(), false)
  assert.equal(h.v2.length, 0) // nothing captured (all threw)
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'halted')
})

test('journalV2 absent: loop proceeds with no v2 events and no throw', async () => {
  const h = makeHarness([])
  delete h.deps.journalV2
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.v2.length, 0)
  assert.equal(loop.isActive(), false)
})

test('resumeV2StateFromEvents: last state-change wins (phase-1 fold)', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: 't0', ref: 'R', mode: 'personal' },
    { kind: 'state-change', at: 't1', ref: 'R', state: 'running' },
    {
      kind: 'state-change',
      at: 't2',
      ref: 'R',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
    {
      kind: 'loop-state',
      at: 't3',
      ref: 'R',
      loop: {
        phase: 'implement',
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'x',
        status: 'running',
      },
    },
  ]
  assert.equal(resumeV2StateFromEvents(events), 'waiting_machine')
})

test('resumeV2StateFromEvents: no v2 events -> derived from projected loop status', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: 't0', ref: 'R', mode: 'personal' },
    {
      kind: 'loop-state',
      at: 't1',
      ref: 'R',
      loop: {
        phase: 'plan',
        awaitingOutcome: false,
        blockerRetries: 0,
        validateStartedAt: 'x',
        status: 'paused',
      },
    },
  ]
  assert.equal(resumeV2StateFromEvents(events), 'waiting_human')
})

test('resumeV2StateFromEvents: null/empty journal seeds nothing', () => {
  assert.equal(resumeV2StateFromEvents(null), undefined)
  assert.equal(resumeV2StateFromEvents([]), undefined)
})

// ===========================================================================
// PMR-ZV9Y fix round (P1 blocker) + fix-round-2 (P2a): the guarded v2 emission
// must be invalidated by a TOOL-journaled state-change, not only by the loop's
// own emissions.
//
// Mechanism under test: `noteExternalV2State(ref, state, at)` is the seam index.ts
// calls from the fan-out dispatcher's `onV2StateChangeObserved` observer — NOT
// the `onStateChange` telemetry sink. PRODUCTION DESIGN (index.ts:519 +
// telemetry/dispatch.ts route()): every journaled v2 state-change — loop AND
// tool, per the telemetry/dispatch.ts seam map — reaches the single choke point
// `route`, which fires the observer FIRST and in its OWN try/catch, fully
// independent of the `onStateChange` Loki/notify sinks. So (a) a throwing
// telemetry sink never costs the loop bookkeeping, (b) the loop learns the wait
// even when telemetry is off (`onStateChange === undefined`), and (c) the
// observer is monotonic on `event.at` (fix-round-2 P2a) because tool v2 writes
// bypass `journalSerial` and can route a stale loop echo AFTER a newer tool
// wait. run-attempt escalate (waiting_human) and deviation rerun
// (waiting_machine) journal a wait but never the running return, so without the
// observer the loop's `lastEmittedV2` stays pinned at `running` and the next
// snapshot('running') is guard-suppressed (pi_flow_state stuck at the wait).
// ===========================================================================

// A fixed ISO timestamp for the hand-built JOURNAL events (the fold/render
// assertions only care about array order + vocabulary, not wall-clock).
const AT = '2026-11-25T09:00:00.000Z'

// The loop's own emitStateChange stamps `at = now()` (real wall-clock) and, since
// fix-round-2, that timestamp advances the recency watermark. An external
// observation is therefore only applied when its `at` is STRICTLY newer, so the
// hand-driven tests date it relative to real now (offsetSec > 0). The ISO format
// is fixed-width UTC, so the test helper's string compare is a valid
// chronological compare — the same property loop.ts relies on.
function atOffset(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString()
}

test('P1: a tool-journaled wait un-pins the loop — the next running snapshot emits', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted once; lastEmittedV2 = 'running'
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  // The observer mirrors a tool-side wait (run-attempt escalate / deviation
  // rerun) WITHOUT the tool journaling the running return. The wait is NEWER
  // than the loop's own running stamp, so the P2a monotonic guard accepts it.
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(60))
  // The loop re-arms and advances (plan lands -> implement prompt) — its
  // snapshot('running') MUST now emit, because lastEmittedV2 is waiting_human.
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 guard: an external wait for a DIFFERENT ref never touches the active guard', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // active ref TP-1, lastEmittedV2 = 'running'
  // A foreign run's wait must not un-pin THIS run's guard (ref-guard runs
  // BEFORE the recency guard, so a future-dated foreign wait is still ignored).
  loop.noteExternalV2State('OTHER-1', 'waiting_human', atOffset(60))
  h.labels = ['planned']
  await loop.onSettled() // advance -> snapshot('running') still suppressed (own running)
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 no-duplicate: a plain running->running re-snapshot stays suppressed (no external wait)', async () => {
  // Proves the fix is NOT "always emit": with no external wait in between, the
  // loop's own running->running duplicate is still suppressed (the guard intact).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = ['planned']
  await loop.onSettled() // advance -> sendPhasePrompt -> snapshot('running') suppressed
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 observer (real fan-out): a tool state-change recorded through onV2StateChangeObserved un-pins the loop', async () => {
  // Repointed to the PRODUCTION wiring (fix-round-2 P1 blocker). index.ts:519
  // assigns the loop to the fan-out dispatcher's `onV2StateChangeObserved`
  // observer (NOT `onStateChange`, which is the Loki/notify telemetry sink);
  // dispatch.ts route() fires the observer first, in its own try/catch, on EVERY
  // journaled state-change. This test wires that observer exactly like index.ts
  // does, so deleting or reordering the ~7-line observer block in route() turns
  // it red (see the mutation note in the fix-round task).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted (stamps real now())
  const written: FlowRunEvent[] = []
  const baseWriter: EventWriter = {
    record: async (event) => {
      written.push(event)
      return true
    },
    recordJournalOnly: async (event) => {
      written.push(event)
    },
  }
  // onStateChange is UNDEFINED here on purpose: the telemetry-off posture is
  // exactly what the separate observer slot exists to cover.
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
  }
  const fanout = createEventFanoutWriter(baseWriter, handlers)
  // The tool journals ONLY the wait through the dispatcher's observer. The
  // `at` is strictly newer than the loop's own running stamp so the P2a
  // monotonic guard accepts it.
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.equal(written.length, 1, 'the wait reached the writer')
  // The loop re-arms and advances -> running snapshot now emits.
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    `expected the running return after the wait: ${String(
      h.v2
        .filter((e) => e.kind === 'state-change')
        .map((e) => {
          if (e.kind !== 'state-change') return e.kind
          return `${e.kind}:${e.state}`
        }),
    )}`,
  )
})

// Fix-round-2 (P1 blocker) — the observer slot itself, not just the loop seam.
// index.ts wires the loop to onV2StateChangeObserved; onStateChange is the
// Loki/notify TELEMETRY sink. These cases pin the isolation properties the
// separate slot exists for (ISC-A-5) and that the observer is the ONLY thing
// that updates the loop guard (the mutation the blocker warned about).

function baseWriterProbe() {
  const written: FlowRunEvent[] = []
  const writer: EventWriter = {
    record: async (event) => {
      written.push(event)
      return true
    },
    recordJournalOnly: async (event) => {
      written.push(event)
    },
  }
  return { writer, written }
}

test('P1 observer (a): a throwing onV2StateChangeObserved never costs onStateChange routing and never throws out of record', async () => {
  // ISC-A-5: the observer runs in its OWN try/catch, so a loop-bookkeeping bug
  // can never also cost the telemetry sink.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer, written } = baseWriterProbe()
  const sinks: FlowRunEvent[] = []
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: () => {
      throw new Error('observer exploded')
    },
    onStateChange: (event) => {
      sinks.push(event)
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.equal(written.length, 1, 'writer reached')
  assert.equal(
    sinks.length,
    1,
    'the telemetry sink STILL routed despite a throwing observer',
  )
  void loop // the throwing observer is bookkeeping-irrelevant here; the assertion is the routing
})

test('P1 observer (b): a throwing onStateChange never costs the observer — observer fires FIRST', async () => {
  // Order property: dispatch.ts route() invokes the observer BEFORE onStateChange
  // and in a separate try/catch, so a throwing notify/Loki sink can never cost
  // the loop its wait (the loop must still un-pin).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer } = baseWriterProbe()
  const order: string[] = []
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      order.push('observer')
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
    onStateChange: () => {
      order.push('sink')
      throw new Error('notify exploded')
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.deepEqual(
    order,
    ['observer', 'sink'],
    'observer fires before the sink',
  )
  // The loop un-pinned even though the telemetry sink threw -> the next
  // differing snapshot emits.
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 2, 'loop un-pinned despite the throwing sink')
})

test('P1 observer (c): onV2StateChangeObserved alone (onStateChange undefined) still updates the loop guard', async () => {
  // The telemetry-fully-disabled posture (no Loki, no notify): the ONLY handler
  // present is the observer, and the loop must still learn the wait. This is
  // the exact reason a separate slot exists (option (a) over reusing
  // onStateChange). It overlaps the real-fan-out test but pins it at the
  // routing level (no onStateChange key at all).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer, written } = baseWriterProbe()
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_machine',
    reason: 'deviation_gate_rerun',
  })
  assert.equal(written.length, 1)
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 2, 'observer-only wiring un-pins the loop')
})

test('P1 observer (d, mutation guard): WITHOUT the observer the loop guard stays stale and the running snapshot is suppressed', async () => {
  // The failure mode the P1 blocker described: the loop is wired ONLY through
  // the dispatcher's observer block, so if that ~7-line block were deleted or
  // reordered out of route(), the wait never reaches the loop. Model that here
  // by wiring ONLY the telemetry sink (as production does — it never touches
  // the loop) and NO observer, then assert the next running snapshot stays
  // suppressed. The real-fan-out test (above) goes red under the same mutation
  // (runnings 1 not 2); this test pins the counterfactual explicitly.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer } = baseWriterProbe()
  const handlers: FanoutHandlers = {
    // A pure telemetry sink: Loki/notify, NOT the loop. This is what
    // onStateChange is in production.
    onStateChange: () => {},
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    1,
    'no observer -> guard stays pinned at running -> the re-snapshot is suppressed (the original P1 symptom)',
  )
})

test('P1 fold: escalate-wait then a running snapshot renders pi_flow_state{running} through the real projection', async () => {
  // The reviewer's reproduced journal sequence, driven through the REAL
  // projectRunState + renderStateMetricLines fold (not just emission mocks).
  const h = makeHarness([])
  const journal: FlowRunEvent[] = [
    { kind: 'run-start', at: AT, ref: 'TP-1', mode: 'personal' },
  ]
  h.deps.journalV2 = (event) => {
    h.v2.push(event)
    journal.push(event)
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running journaled into the journal
  // The tool journals the wait into the SAME journal, then the observer
  // re-seeds. The observer `at` is strictly newer than the loop's own running
  // stamp so the P2a monotonic guard accepts it (the journal entry keeps its
  // fixed AT for the array-order fold — the projection reads the journal, not
  // the guard, so the two timestamps need not match).
  journal.push({
    kind: 'state-change',
    at: new Date(Date.parse(AT) + 1000).toISOString(),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(60))
  // The loop advances -> running snapshot (the fix makes it emit).
  h.labels = ['planned']
  await loop.onSettled()

  assert.equal(deriveV2State(journal)?.state, 'running', String(journal))
  const lines = renderStateMetricLines('TP-1', journal)
  const stateLine = lines.find((line) => line.startsWith('pi_flow_state{'))
  assert.ok(
    stateLine !== undefined,
    `no pi_flow_state line rendered: ${lines.join('\n')}`,
  )
  assert.ok(
    stateLine?.includes('state="running"'),
    `pi_flow_state pinned at the wait: ${String(stateLine)}\n${lines.join('\n')}`,
  )
  // The wait still contributes its window (it was a real wait) — the running
  // line is the CURRENT state, exactly one, never waiting_human.
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_state{')).length,
    1,
    lines.join('\n'),
  )
  assert.ok(!stateLine?.includes('state="waiting_human"'), lines.join('\n'))
  // projectRunState agrees with deriveV2State (last-wins). This is the guard
  // that would fail if the running return were suppressed (journal stuck at
  // waiting_human).
  const projected = projectRunState(journal)
  assert.equal(projected?.currentState?.state, 'running')
})

// ===========================================================================
// PMR-ZV9Y fix-round-2 (P2a): the external observer is MONOTONIC on the event
// timestamp. Tool v2 writes bypass `journalSerial`, so an already-enqueued loop
// `running` event can route AFTER a tool's later `waiting_human`. Without a
// recency guard, route(waiting_human) sets the guard, then the late
// route(running echo) reverts it to `running` and the next differing snapshot
// is suppressed again — the original P1 symptom in a narrow window. The fix:
// ignore external observations whose `at` is older-or-equal than the last
// applied one. ISO-8601 fixed-width UTC makes a lexicographic string compare a
// correct chronological compare.
// ===========================================================================

test('P2a: an older external wait is ignored — the guard stays pinned (recency, not just state)', async () => {
  // The external wait is a VALID un-pin by state (waiting_human != running),
  // but its `at` predates the loop's own start stamp -> it is recency-skipped,
  // so the loop's next running snapshot stays suppressed (only 1 running).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running at real now(), lastV2At = now()
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(-60)) // older -> ignored
  h.labels = ['planned']
  await loop.onSettled() // snapshot('running') still suppressed (guard = running)
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 1, 'older external observation recency-skipped')
})

test('P2a: a late loop echo cannot revert a newer tool wait (the narrow-window symptom)', async () => {
  // The exact regression. Sequence the guard must survive:
  //   1. loop emits running (lastV2At = now).
  //   2. tool's waiting_human routes FIRST  at +120s -> applied (newer).
  //   3. the loop's queued running echo routes LATER at +60s -> OLDER than the
  //      wait -> recency-skipped (the guard stays waiting_human).
  //   4. loop advances -> snapshot('running') DIFFERS from the guard -> emits.
  // Without the monotonic guard step 3 would revert the guard to `running`,
  // suppress step 4, and only 1 running would be journaled (the P1 symptom).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running, lastV2At = now()
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(120)) // tool wait (newer)
  loop.noteExternalV2State('TP-1', 'running', atOffset(60)) // late loop echo (older)
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    'the stale running echo did not re-pin the guard -> running return emitted',
  )
})

test('P2a: the loop is never locked out by a future-dated external stamp', async () => {
  // The loop's own emitStateChange is NOT recency-gated (only the external
  // observer is) — so a stale/foreign FUTURE `at` on an external observation
  // can never suppress the loop's own next differing emission. Sequence:
  //   1. loop emits running (lastV2At = now).
  //   2. external waiting_machine at +3600s (far future) -> applied, lastV2At = +3600.
  //   3. loop advances -> snapshot('running') at real now (< +3600) -> STILL
  //      emits, because the loop's own emission only checks state equality, not
  //      recency. Two runnings proves the loop was not locked out.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  loop.noteExternalV2State('TP-1', 'waiting_machine', atOffset(3600))
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    'loop emit advances the guard regardless of a future-dated lastV2At',
  )
})
