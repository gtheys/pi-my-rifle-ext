import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import type { FlowRunEvent } from '../run-state.ts'

interface Harness {
  deps: FlowLoopDeps
  sent: string[]
  notes: { ref: string; text: string }[]
  events: FlowRunEvent[]
  notifications: { message: string; level: string }[]
  labels: string[] | null
  planState: string | null
  openChildren?: boolean
  inFlight?: boolean
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    notes: [],
    events: [],
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
    readLabels: async () => h.labels,
    readPlanState: async () => h.planState,
    avenNote: async (ref, text) => {
      h.notes.push({ ref, text })
      return true
    },
    epicHasOpenChildren: async () => h.openChildren ?? false,
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
  workRoots: [],
}

function startInput() {
  return {
    ref: 'TP-1',
    phase: 'plan' as const,
    promptInput: { ...PROMPT_INPUT },
  }
}

test('start: sends one phase prompt and awaits outcome', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /plan\.md|Plan phase/)
  assert.equal(loop.isActive(), true)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['phase-start'],
  )
})

test('settled with label landed: advances to the next phase prompt', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['phase-start', 'phase-complete', 'phase-start'],
  )
})

test('settled without label: halt note, journal note, no advance', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.notes, [
    {
      ref: 'TP-1',
      text: 'flow halted at plan: phase completed without landing the "planned" label',
    },
  ])
  assert.equal(loop.isActive(), false)
  const noteEvent = h.events.at(-1)
  assert.equal(noteEvent?.kind, 'note')
})

test('settled after an aborted turn (label never landed): halts', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.match(h.notes[0].text, /without landing the "planned" label/)
})

test('settled without label but a subagent is in flight: stays armed, no halt, re-checks next settle', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.notes.length, 0)
  assert.equal(h.sent.length, 1)
  assert.equal(loop.isActive(), true)
  assert.equal(h.events.at(-1)?.kind, 'note')
  // child steers back, turn settles again with the label landed: advances
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
})

test('settled without label once the subagent is gone: halts', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(loop.isActive(), true)
  h.inFlight = false
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /without landing the "planned" label/)
})

test('plan settles without "planned" while plan-state=review: awaiting-approval pause, no failure halt', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.equal(h.sent.length, 1) // no implement prompt
  assert.equal(loop.isActive(), false)
  assert.equal(h.notes.length, 1)
  assert.match(h.notes[0].text, /awaiting spec approval/)
  assert.doesNotMatch(h.notes[0].text, /halted/)
  const last = h.notifications.at(-1)
  assert.equal(last?.level, 'info')
  assert.match(last?.message ?? '', /awaiting spec approval/)
  assert.equal(h.events.at(-1)?.kind, 'note')
})

test('plan settles without label and plan-state not in review: failure halt as before', async () => {
  const h = makeHarness([])
  h.planState = 'approved'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.match(
    h.notes[0].text,
    /flow halted at plan: phase completed without landing the "planned" label/,
  )
})

test('plan settles without label and plan-state read fails (null): failure halt, gate never triggers', async () => {
  const h = makeHarness([])
  h.planState = null
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.match(
    h.notes[0].text,
    /flow halted at plan: phase completed without landing the "planned" label/,
  )
})

test('resume after approval: /flow re-enters plan, refreshed prompt run lands the label and completes the phase', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  // spec approved meanwhile (plan-state=approved); a later /flow re-enters plan
  h.planState = 'approved'
  await loop.start({ ...startInput(), phase: 'plan' })
  assert.match(h.sent.at(-1) ?? '', /plan\.md|Plan phase/)
  h.labels = ['planned'] // refreshed plan prompt run lands "planned"
  await loop.onSettled()
  assert.match(h.sent.at(-1) ?? '', /Implement phase/)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['phase-start', 'note', 'phase-start', 'phase-complete', 'phase-start'],
  )
})

test('settled with aven failure: halts fail-closed', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = null
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.match(h.notes[0].text, /cannot read aven labels/)
})

test('settled when idle: ignored (side conversations never advance the flow)', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.onSettled()
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  await loop.start(startInput())
  h.labels = ['planned']
  await loop.onSettled()
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
})

test('final phase complete: flow done, loop inactive', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed', 'done'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'feedback' })
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.equal(loop.isActive(), false)
  assert.equal(
    h.notifications.some((n) => n.message.includes('all phases complete')),
    true,
  )
})

test('implement gate block at start: halt note, nothing sent', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'implement' })
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /flow halted at implement/)
})

test('implement injection with open epic children forces the plan route', async () => {
  const h = makeHarness(['planned'])
  h.openChildren = true
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'implement' })
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /implement-plan-aven/)
  assert.match(h.sent[0], /Route: plan/)
})

// PMR-VZEV: start resets the landing state so stale authorization (or a
// stale human code-review pass marker) cannot leak into a later flow.
test('start: resets the landing state (authorized + humanReviewPassed)', async () => {
  const h = makeHarness([])
  let resets = 0
  h.deps.resetLandingState = () => {
    resets += 1
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(resets, 1)
  await loop.start({ ...startInput(), ref: 'TP-2' })
  assert.equal(resets, 2)
})

test('start: works without an optional resetLandingState dep', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(loop.isActive(), true)
})
