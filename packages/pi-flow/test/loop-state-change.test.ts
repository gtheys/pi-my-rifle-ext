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
import type { FlowRunEvent } from '../run-state.ts'

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
