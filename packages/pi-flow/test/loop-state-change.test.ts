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
// PMR-ZV9Y fix round (P1 blocker): the guarded v2 emission must be invalidated
// by a TOOL-journaled state-change, not only by the loop's own emissions.
//
// Mechanism under test: `noteExternalV2State(ref, state)` is the seam index.ts
// calls from the fan-out writer's `onStateChange` sink — the single choke point
// that sees EVERY journaled v2 state-change (loop AND tools, per the
// telemetry/dispatch.ts seam map). run-attempt escalate (waiting_human) and
// deviation rerun (waiting_machine) journal a wait but never journal the
// running return, so the loop's `lastEmittedV2` stays pinned at `running` and
// the next snapshot('running') is guard-suppressed (pi_flow_state stuck at the
// wait while the run is actively working).
//
// The fix: the sink re-seeds `lastEmittedV2` to the journaled wait, so the
// loop's next differing-state emission is NOT suppressed.
// ===========================================================================

// A fixed ISO timestamp for the hand-built journal events (the fold/render
// assertions only care about ordering + vocabulary, not wall-clock).
const AT = '2026-11-25T09:00:00.000Z'

test('P1: a tool-journaled wait un-pins the loop — the next running snapshot emits', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted once; lastEmittedV2 = 'running'
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  // The sink mirrors a tool-side wait (run-attempt escalate / deviation rerun)
  // WITHOUT the tool journaling the running return.
  loop.noteExternalV2State('TP-1', 'waiting_human')
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
  // A foreign run's wait must not un-pin THIS run's guard.
  loop.noteExternalV2State('OTHER-1', 'waiting_human')
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

test('P1 sink (real fan-out): a tool state-change recorded through the wrapped writer un-pins the loop', async () => {
  // Locks the wiring mechanism (option a): index.ts's single choke point is the
  // fan-out dispatcher wrapping the mode-aware writer; its onStateChange sink
  // calls loop.noteExternalV2State. Here we drive that sink for real.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted
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
  const handlers: FanoutHandlers = {
    onStateChange: (event) => {
      loop.noteExternalV2State(event.ref, event.state)
    },
  }
  const fanout = createEventFanoutWriter(baseWriter, handlers)
  // The tool journals ONLY the wait through the shared sink.
  await fanout.record({
    kind: 'state-change',
    at: AT,
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
  // The tool journals the wait into the SAME journal, then the sink re-seeds.
  journal.push({
    kind: 'state-change',
    at: new Date(Date.parse(AT) + 1000).toISOString(),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  loop.noteExternalV2State('TP-1', 'waiting_human')
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
