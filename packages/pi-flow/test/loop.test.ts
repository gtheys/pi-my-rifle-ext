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
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    notes: [],
    events: [],
    notifications: [],
    labels,
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
    avenNote: async (ref, text) => {
      h.notes.push({ ref, text })
      return true
    },
    sendPrompt: (prompt) => {
      h.sent.push(prompt)
    },
  }
  return h
}

const PROMPT_INPUT = {
  mode: 'personal' as const,
  ref: 'TP-1',
  skipResearch: false,
  gitRoot: '/home/x/repo',
  workRoots: [],
}

function startInput() {
  return {
    ref: 'TP-1',
    phase: 'research' as const,
    skipResearch: false,
    researchSkip: false,
    promptInput: { ...PROMPT_INPUT },
  }
}

test('start: sends one phase prompt and awaits outcome', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /Research phase/)
  assert.equal(loop.isActive(), true)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['phase-start'],
  )
})

test('settled with label landed: advances to the next phase prompt', async () => {
  const h = makeHarness(['researched'])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /plan\.md|Plan phase/)
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
      text: 'flow halted at research: phase completed without landing the "researched" label',
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
  assert.match(h.notes[0].text, /without landing the "researched" label/)
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
  const h = makeHarness(['researched'])
  const loop = createFlowLoop(h.deps)
  await loop.onSettled()
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  await loop.start(startInput())
  h.labels = ['researched']
  await loop.onSettled()
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
})

test('final phase complete: flow done, loop inactive', async () => {
  const h = makeHarness([
    'researched',
    'planned',
    'active',
    'review-passed',
    'done',
  ])
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

test('researchSkip at start: skip journal + aven note, no research prompt', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ...startInput(),
    phase: 'plan',
    skipResearch: true,
    researchSkip: true,
  })
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /plan\.md|Plan phase/)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['phase-skip', 'phase-start'],
  )
  assert.match(h.notes[0].text, /research skip confirmed by user/)
})

test('implement gate block at start: halt note, nothing sent', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'implement' })
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /flow halted at implement/)
})
