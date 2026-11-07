import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'

interface Harness {
  deps: FlowLoopDeps
  sent: string[]
  events: { kind: string }[]
  notifications: { message: string; level: string }[]
  labels: string[] | null
  env: Record<string, string | undefined>
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    events: [],
    notifications: [],
    labels,
    env: {},
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
    readPlanState: async () => null,
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: (prompt) => {
      h.sent.push(prompt)
    },
    env: h.env,
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

test('attribution: start stamps ref/phase/traceparent into the loop env', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(h.env.PI_FLOW_REF, 'TP-1')
  assert.equal(h.env.PI_FLOW_PHASE, 'plan')
  assert.match(
    h.env.PI_FLOW_TRACEPARENT ?? '',
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
  )
})

test('attribution: phase transition re-stamps the phase', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.env.PI_FLOW_REF, 'TP-1')
  assert.equal(h.env.PI_FLOW_PHASE, 'implement')
})

test('attribution: halt clears the flow env', async () => {
  const h = makeHarness(null) // aven failure -> fail-closed halt
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.equal(h.env.PI_FLOW_REF, undefined)
  assert.equal(h.env.PI_FLOW_PHASE, undefined)
  assert.equal(h.env.PI_FLOW_TRACEPARENT, undefined)
})

test('attribution: run completion clears the flow env', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed'])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // plan done -> implement
  await loop.onSettled() // implement done -> validate (personal stops after? mode personal: validate next)
  await loop.onSettled()
  // keep settling until the loop goes idle
  for (let i = 0; i < 3 && loop.isActive(); i++) await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.equal(h.env.PI_FLOW_REF, undefined)
  assert.equal(h.env.PI_FLOW_PHASE, undefined)
})

test('attribution: invalid ref aborts start without sending a prompt', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), ref: 'bad ref!' })
  assert.equal(loop.isActive(), false)
  assert.equal(h.sent.length, 0)
  assert.equal(h.env.PI_FLOW_REF, undefined)
  assert.equal(
    h.notifications.some((n) => n.message.includes('invalid flow ref')),
    true,
  )
})

test('attribution: superseding a run re-stamps for the new ref', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.start({ ...startInput(), ref: 'TP-2' })
  assert.equal(h.env.PI_FLOW_REF, 'TP-2')
})
