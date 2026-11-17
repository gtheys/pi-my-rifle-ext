import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OpenGate } from '../flow/gates.ts'
import {
  type AssignmentSummary,
  renderFlowStatusLines,
  type StatusInput,
  shouldShowWidget,
} from '../flow/status.ts'
import type { FlowRunState } from '../run-state.ts'

function makeState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-ZGPY',
    mode: 'work',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    completedPhases: [],
    currentPhase: null,
    notes: [],
    ...overrides,
  }
}

function makeGate(overrides: Partial<OpenGate> = {}): OpenGate {
  return {
    ref: 'PMR-ZGPY',
    kind: 'flow-paused',
    title: 'PMR-ZGPY — flow run paused',
    ...overrides,
  }
}

describe('renderFlowStatusLines', () => {
  it('renders header and four phase lines mid-run (ISC-1)', () => {
    const lines = renderFlowStatusLines({
      state: makeState({
        completedPhases: ['plan'],
        currentPhase: 'implement',
      }),
      subtasks: [],
      gates: [],
    })
    assert.equal(lines[0], 'flow PMR-ZGPY · work')
    assert.equal(lines.length, 5)
    assert.match(lines[1], /^\[x\] plan/)
    assert.match(lines[1], /\(planned\)/)
    assert.match(lines[2], /^\[ \] implement/)
    assert.match(lines[2], /<- running/)
    assert.match(lines[3], /^\[ \] validate/)
    assert.match(lines[4], /^\[ \] feedback/)
  })

  it('renders four pending rows when nothing is completed', () => {
    const lines = renderFlowStatusLines({
      state: makeState(),
      subtasks: [],
      gates: [],
    })
    assert.equal(lines.length, 5) // header + 4 phases
    for (const line of lines.slice(1)) {
      assert.match(line, /^\[ \]/)
      assert.ok(!line.includes('running'))
    }
  })

  it('renders subtask rows (ISC-2)', () => {
    const subtasks: AssignmentSummary[] = [
      { name: 'render helpers', status: 'completed' },
      { name: 'widget wiring', status: 'running' },
    ]
    const lines = renderFlowStatusLines({
      state: makeState(),
      subtasks,
      gates: [],
    })
    const joined = lines.join('\n')
    assert.ok(joined.includes('subtasks:'))
    assert.ok(joined.includes('render helpers — completed'))
    assert.ok(joined.includes('widget wiring — running'))
  })

  it('renders gate rows with answer hint (ISC-3)', () => {
    const gates: OpenGate[] = [
      makeGate(),
      makeGate({
        ref: 'PMR-AAAA',
        kind: 'answer-gate',
        title: 'PMR-AAAA — deviation gate awaiting answer',
        answerCommand: '/flow answer PMR-AAAA',
      }),
    ]
    const lines = renderFlowStatusLines({
      state: makeState(),
      subtasks: [],
      gates,
    })
    const joined = lines.join('\n')
    assert.ok(joined.includes('gates:'))
    assert.ok(joined.includes('PMR-ZGPY — flow run paused'))
    assert.ok(joined.includes('PMR-AAAA — deviation gate awaiting answer'))
    assert.ok(joined.includes('→ /flow answer PMR-AAAA'))
  })

  it('renders gates block only when state is null', () => {
    const lines = renderFlowStatusLines({
      state: null,
      subtasks: [],
      gates: [makeGate()],
    })
    const joined = lines.join('\n')
    assert.ok(!joined.includes('flow PMR-ZGPY'))
    assert.ok(!joined.includes('[ ]'))
    assert.ok(joined.includes('gates:'))
    assert.ok(joined.includes('PMR-ZGPY — flow run paused'))
  })
})

describe('shouldShowWidget', () => {
  const empty: StatusInput = { state: null, subtasks: [], gates: [] }

  it('returns false for empty input (ISC-4)', () => {
    assert.equal(shouldShowWidget(empty), false)
  })

  it('returns true when only state is present', () => {
    assert.equal(shouldShowWidget({ ...empty, state: makeState() }), true)
  })

  it('returns true when only subtasks are present', () => {
    const subtasks: AssignmentSummary[] = [{ name: 'x', status: 'pending' }]
    assert.equal(shouldShowWidget({ ...empty, subtasks }), true)
  })

  it('returns true when only gates are present', () => {
    assert.equal(shouldShowWidget({ ...empty, gates: [makeGate()] }), true)
  })
})
