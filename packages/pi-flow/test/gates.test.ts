import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveRunGates } from '../flow/gates.ts'
import type {
  CommandReceiptRecord,
  FlowRunState,
  GateTargetRecord,
  LoopStateRecord,
} from '../run-state.ts'

// Hand-built FlowRunState literals mirroring the projection shapes in
// run-state.ts (schema 'gtheys.pi-flow.run.v1').

function baseState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'personal',
    startedAt: '2026-11-17T10:00:00Z',
    updatedAt: '2026-11-17T11:00:00Z',
    completedPhases: ['plan', 'implement'],
    currentPhase: null,
    notes: [],
    ...overrides,
  }
}

function loopState(status: LoopStateRecord['status']): LoopStateRecord {
  return {
    phase: 'validate',
    awaitingOutcome: false,
    blockerRetries: 0,
    validateStartedAt: '2026-11-17T10:30:00Z',
    status,
  }
}

function receipt(
  command: CommandReceiptRecord['command'],
  target: string,
): CommandReceiptRecord {
  return { command, target, status: 'ok', at: '2026-11-17T10:40:00Z' }
}

function gateTarget(
  targetId: string,
  gate: GateTargetRecord['gate'],
): GateTargetRecord {
  return {
    targetId,
    gate,
    baseSha: 'aaa111',
    headSha: 'bbb222',
    diffSha256: 'deadbeef',
    at: '2026-11-17T10:45:00Z',
  }
}

// --- paused runs ---

test('paused run yields a flow-paused gate', () => {
  const state = baseState({ loop: loopState('paused') })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].kind, 'flow-paused')
  assert.equal(gates[0].answerCommand, undefined)
  assert.match(gates[0].title, /^PMR-1/)
  assert.equal(gates[0].title.includes('\n'), false)
})

test('running/halted/done loop yields no paused gate', () => {
  const gates = deriveRunGates([
    baseState({ loop: loopState('running') }),
    baseState({ loop: loopState('halted') }),
    baseState({ loop: loopState('done') }),
  ])
  assert.deepEqual(
    gates.filter((g) => g.kind === 'flow-paused'),
    [],
  )
})

// --- code-review gate (validate phase + missing code_review receipt) ---

test('validate phase without code_review receipt yields a code-review gate', () => {
  const state = baseState({ currentPhase: 'validate' })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'code-review')
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].answerCommand, undefined)
})

test('validate phase WITH code_review receipt yields no gate', () => {
  const state = baseState({
    currentPhase: 'validate',
    receipts: [receipt('code_review', 'PMR-1')],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('non-validate phase yields no code-review gate', () => {
  const state = baseState({ currentPhase: 'implement' })
  assert.deepEqual(deriveRunGates([state]), [])
})

// --- answer gates (open vs answered, both record mechanisms) ---

test('open gate target (no decisions, no answers) yields an answer-gate with answerCommand', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [],
    gateAnswers: [],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'answer-gate')
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].answerCommand, '/flow answer PMR-1')
  assert.match(gates[0].title, /^PMR-1/)
  assert.equal(gates[0].title.includes('\n'), false)
})

test('gate target answered via gateDecisions targetId yields no gate', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'spec-review',
        status: 'pass',
        at: '2026-11-17T10:50:00Z',
      },
    ],
    gateAnswers: [],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('gate target answered via gateAnswers kind (fallback) yields no gate', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'code-review')],
    gateDecisions: [],
    gateAnswers: [
      {
        gate: 'code-review',
        choice: 'approve',
        at: '2026-11-17T10:50:00Z',
      },
    ],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('gate target open when decision is absent even though another target was decided', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'review'), gateTarget('t2', 'review')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'review',
        status: 'stale',
        at: '2026-11-17T10:50:00Z',
      },
    ],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'answer-gate')
})

test('answered gate does NOT reopen via either mechanism (conservative OR, D6)', () => {
  // decision exists for the target AND an answer exists for the gate kind —
  // either record alone closes the gate.
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'spec-review',
        status: 'pass',
        at: '2026-11-17T10:50:00Z',
      },
    ],
    gateAnswers: [
      {
        gate: 'spec-review',
        choice: 'approve',
        at: '2026-11-17T10:55:00Z',
      },
    ],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

// --- research-era / old projections without optional fields ---

test('projection without optional fields derives no gates and does not crash', () => {
  // bare run-start projection: no loop, receipts, gateTargets, gateAnswers
  const state = baseState()
  assert.deepEqual(deriveRunGates([state]), [])
})

test('paused loop alongside missing gate fields still derives only the paused gate', () => {
  const state = baseState({ loop: loopState('paused') })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'flow-paused')
})

// --- ordering across multiple states ---

test('multiple states produce gates in input order', () => {
  const states = [
    baseState({ ref: 'PMR-A', loop: loopState('paused') }),
    baseState({ ref: 'PMR-B', currentPhase: 'validate' }),
    baseState({
      ref: 'PMR-C',
      gateTargets: [gateTarget('t1', 'spec-review')],
    }),
  ]
  const gates = deriveRunGates(states)
  assert.deepEqual(
    gates.map((g) => g.ref),
    ['PMR-A', 'PMR-B', 'PMR-C'],
  )
  assert.deepEqual(
    gates.map((g) => g.kind),
    ['flow-paused', 'code-review', 'answer-gate'],
  )
})

test('empty input yields no gates', () => {
  assert.deepEqual(deriveRunGates([]), [])
})
