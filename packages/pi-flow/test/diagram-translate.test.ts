import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import { buildDiagram } from '../flow-diagram/translate.ts'
import type { FlowRunEvent } from '../run-state.ts'

function runStart(at: string, ref = 'PMR-TEST'): FlowRunEvent {
  return {
    kind: 'run-start',
    at,
    ref,
    mode: 'personal',
  }
}

function phaseStart(at: string, phase: 'plan' | 'implement'): FlowRunEvent {
  return { kind: 'phase-start', at, ref: 'PMR-TEST', phase }
}

function phaseComplete(at: string, phase: 'plan' | 'implement'): FlowRunEvent {
  return { kind: 'phase-complete', at, ref: 'PMR-TEST', phase, label: phase }
}

function assignment(overrides: Partial<AssignmentRecord>): AssignmentRecord {
  return {
    childId: 'child-1',
    name: 'worker-1',
    task: 'do things',
    sessionFile: '/sessions/child-1.jsonl',
    cwd: '/repo',
    status: 'working',
    claim: { pid: 1, id: 'parent' },
    createdAt: '2026-11-07T01:00:00Z',
    updatedAt: '2026-11-07T01:00:00Z',
    ...overrides,
  }
}

function twoRunEvents(): FlowRunEvent[] {
  return [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
    phaseComplete('2026-11-07T01:11:00Z', 'plan'),
    runStart('2026-11-07T02:00:00Z'),
    phaseStart('2026-11-07T02:01:00Z', 'implement'),
    phaseComplete('2026-11-07T02:31:00Z', 'implement'),
  ]
}

test('default selector picks the latest run segment', () => {
  const events = twoRunEvents()
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.runCount, 2)
  assert.equal(result.header.runIndex, 2)
  // only the second segment's phases are counted
  assert.deepEqual(
    result.header.phases.map((p) => p.phase),
    ['implement'],
  )
  assert.deepEqual(
    result.header.phases.map((p) => p.seconds),
    [30 * 60],
  )
})

test('explicit index 1 picks the first run segment', () => {
  const events = twoRunEvents()
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.runIndex, 1)
  assert.deepEqual(
    result.header.phases.map((p) => p.phase),
    ['plan'],
  )
})

test('out-of-range selector is detectable via runCount', () => {
  const events = twoRunEvents()
  const result = buildDiagram('PMR-TEST', 3, events, [], new Map())
  if (result.kind !== 'out-of-range') {
    assert.fail('expected out-of-range')
  }
  assert.equal(result.runCount, 2)
})

test('events before the first run-start belong to run 1', () => {
  const events: FlowRunEvent[] = [
    phaseStart('2026-11-06T23:00:00Z', 'plan'),
    phaseComplete('2026-11-06T23:30:00Z', 'plan'),
    runStart('2026-11-07T01:00:00Z'),
  ]
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(
    result.header.phases.map((p) => p.phase),
    ['plan'],
  )
})

test('header carries ref, trackRef, mode from run-start', () => {
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-07T01:00:00Z',
      ref: 'DP-71',
      mode: 'work',
      trackRef: 'PMR-AB12',
    },
  ]
  const result = buildDiagram('DP-71', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.ref, 'DP-71')
  assert.equal(result.header.trackRef, 'PMR-AB12')
  assert.equal(result.header.mode, 'work')
})

test('absent trackRef is undefined, not fake', () => {
  const events = [runStart('2026-11-07T01:00:00Z')]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.trackRef, undefined)
})

test('commits per subtask come from subtask-ranges', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    {
      kind: 'subtask-ranges',
      at: '2026-11-07T01:10:00Z',
      ref: 'PMR-TEST',
      gate: 'code-review',
      baseSha: 'a',
      headSha: 'b',
      bySubtask: [
        { subtask: '2.1', commits: ['abc', 'def'] },
        { subtask: '2.2', commits: ['123'] },
      ],
      unattributed: ['xyz'],
    },
  ]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.header.commitsBySubtask, [
    { subtask: '2.1', commits: ['abc', 'def'] },
    { subtask: '2.2', commits: ['123'] },
  ])
  assert.deepEqual(result.header.unattributed, ['xyz'])
})

test('missing subtask-ranges yields empty commit lists', () => {
  const events = [runStart('2026-11-07T01:00:00Z')]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.header.commitsBySubtask, [])
  assert.deepEqual(result.header.unattributed, [])
})

test('prUrl comes from the last step-output with a prUrl', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    {
      kind: 'step-output',
      at: '2026-11-07T01:05:00Z',
      ref: 'PMR-TEST',
      phase: 'implement',
      step: 'a',
      prUrl: 'https://github.com/x/pr/1',
    },
    {
      kind: 'step-output',
      at: '2026-11-07T01:06:00Z',
      ref: 'PMR-TEST',
      phase: 'implement',
      step: 'b',
    },
  ]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.prUrl, 'https://github.com/x/pr/1')
})

test('missing step-output leaves prUrl undefined', () => {
  const events = [runStart('2026-11-07T01:00:00Z')]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.prUrl, undefined)
})

test('records are empty until record synthesis lands', () => {
  const events = twoRunEvents()
  const result = buildDiagram(
    'PMR-TEST',
    null,
    events,
    [assignment({})],
    new Map(),
  )
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.records, [])
})
