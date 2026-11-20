import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  buildDiagram,
  type SpawnCallRecord,
} from '../flow-diagram/translate.ts'
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

// --- 2.2: spawn synthesis fixtures -------------------------------------

function spawnRecordEvent(overrides: {
  at: string
  childId?: string
  name?: string
  subtask?: string
  sessionFile?: string
}): FlowRunEvent {
  return {
    kind: 'spawn-record',
    at: overrides.at,
    ref: 'PMR-TEST',
    childId: overrides.childId ?? 'child-1',
    name: overrides.name ?? 'worker-1',
    spawnKind: 'spawn',
    subtask: overrides.subtask,
    sessionFile: overrides.sessionFile,
  }
}

/** Minimal pi session-jsonl assistant entry carrying a usage block. */
function assistantEntry(
  id: string,
  timestamp: string,
  usage: Record<string, number>,
): unknown {
  return {
    type: 'message',
    id,
    timestamp,
    message: { role: 'assistant', usage },
  }
}

function okSpawn(result: ReturnType<typeof buildDiagram>): SpawnCallRecord[] {
  if (result.kind !== 'ok') assert.fail('expected ok')
  return result.records.filter(
    (record): record is SpawnCallRecord => record.tool === 'Agent',
  )
}

test('spawn-record yields one Agent call record with schema-v2 fields', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      sessionFile: '/sessions/child-1.jsonl',
    }),
  ]
  const entries = [
    assistantEntry('m1', '2026-11-07T01:03:00Z', {
      input: 10,
      cacheWrite: 1,
      cacheRead: 2,
      output: 5,
    }),
  ]
  const sessions = new Map([['/sessions/child-1.jsonl', entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  const spawns = okSpawn(result)
  assert.equal(spawns.length, 1)
  const spawn = spawns[0]
  assert.equal(spawn.v, 2)
  assert.equal(spawn.harness, 'pi')
  assert.equal(spawn.session, 'PMR-TEST run 1')
  assert.equal(spawn.agent_id, 'main')
  assert.equal(spawn.tool, 'Agent')
  assert.equal(spawn.tool_use_id, 'spawn-child-1')
  assert.equal(spawn.child_agent_id, 'child-1')
  assert.equal(spawn.name, 'worker-1')
  // end = last entry timestamp; duration = end − spawn at
  assert.equal(spawn.at, new Date('2026-11-07T01:03:00Z').toISOString())
  assert.equal(spawn.duration_ms, 60_000)
})

test('child_spend is precomputed from usage blocks, deduped by entry id', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      sessionFile: '/sessions/child-1.jsonl',
    }),
  ]
  const entries = [
    assistantEntry('m1', '2026-11-07T01:03:00Z', {
      input: 10,
      cacheWrite: 1,
      cacheRead: 2,
      output: 5,
    }),
    // same message id twice — must be deduped
    assistantEntry('m1', '2026-11-07T01:04:00Z', {
      input: 999,
      cacheWrite: 999,
      cacheRead: 999,
      output: 999,
    }),
    assistantEntry('m2', '2026-11-07T01:05:00Z', {
      input: 3,
      cacheWrite: 0,
      cacheRead: 1,
      output: 2,
    }),
  ]
  const sessions = new Map([['/sessions/child-1.jsonl', entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  const spawn = okSpawn(result)[0]
  assert.deepEqual(spawn.child_spend, { new: 14, cached: 3, out: 7, calls: 2 })
  assert.equal(spawn.at, new Date('2026-11-07T01:05:00Z').toISOString())
})

test('assignment fallback covers sessionFile: null spawn notes', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      childId: 'child-2',
      name: 'reviewer-1',
    }),
  ]
  const records = [
    assignment({
      childId: 'child-2',
      name: 'reviewer-1',
      agent: 'reviewer',
      subtask: '3.1',
      sessionFile: '/sessions/child-2.jsonl',
      updatedAt: '2026-11-07T01:30:00Z',
    }),
  ]
  const sessions = new Map([['/sessions/child-2.jsonl', []]])
  const result = buildDiagram('PMR-TEST', 1, events, records, sessions)
  const spawn = okSpawn(result)[0]
  assert.equal(spawn.child_agent_id, 'child-2')
  assert.equal(spawn.child_agent_type, 'reviewer')
  // empty child session: end falls back to assignment.updatedAt
  assert.equal(spawn.at, new Date('2026-11-07T01:30:00Z').toISOString())
  assert.equal(spawn.duration_ms, 28 * 60_000)
  // no usage entries → no spend
  assert.equal(spawn.child_spend, undefined)
  assert.equal(spawn.name, 'reviewer · 3.1')
})

test('missing assignment AND missing sessionFile still yield a lane', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      sessionFile: '/sessions/child-1.jsonl',
    }),
  ]
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  const spawn = okSpawn(result)[0]
  assert.equal(spawn.child_agent_id, 'child-1')
  assert.equal(spawn.child_agent_type, undefined)
  assert.equal(spawn.child_spend, undefined)
  assert.equal(spawn.at, new Date('2026-11-07T01:02:00Z').toISOString())
  assert.equal(spawn.duration_ms, 0)
  assert.equal(spawn.name, 'worker-1')
})

test('name is clipped to ~60 chars', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      name: 'w'.repeat(80),
      subtask: 'a very long subtask description that pushes past the limit',
    }),
  ]
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  const spawn = okSpawn(result)[0]
  assert.ok(spawn.name.length <= 60)
})

test('no spawn-record events → no spawn records', () => {
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
