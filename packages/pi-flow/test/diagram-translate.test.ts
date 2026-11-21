import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  buildDiagram,
  type MilestoneMarkerRecord,
  type PhaseMarkerRecord,
  type SpawnCallRecord,
  type SpendRecord,
  type ToolCallRecord,
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
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
  ]
  const result = buildDiagram('DP-71', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.header.ref, 'DP-71')
  assert.equal(result.header.trackRef, 'PMR-AB12')
  assert.equal(result.header.mode, 'work')
})

test('absent trackRef is undefined, not fake', () => {
  const events = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
  ]
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
  const events = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
  ]
  const result = buildDiagram('PMR-TEST', null, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.header.commitsBySubtask, [])
  assert.deepEqual(result.header.unattributed, [])
})

test('prUrl comes from the last step-output with a prUrl', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'implement'),
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
  const events = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
  ]
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
    (record): record is SpawnCallRecord => 'child_agent_id' in record,
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
  // AIDEV-NOTE (deviation fix): at is the spawn event's own timestamp
  // (verbatim journal value — position, not an end claim).
  assert.equal(spawn.at, '2026-11-07T01:02:00Z')
  // AIDEV-NOTE (deviation fix): lost child = no session end, no assignment
  // updatedAt — the record carries no duration_ms ("lanes without ends").
  assert.equal(spawn.duration_ms, undefined)
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

test('no synthesizable records → kind no-records', () => {
  // a bare run-start with no phases, spawns, sessions or markers
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    runStart('2026-11-07T02:00:00Z'),
  ]
  const result = buildDiagram(
    'PMR-TEST',
    null,
    events,
    [assignment({})],
    new Map(),
  )
  assert.equal(result.kind, 'no-records')
})

// --- 2.3: tool calls, spend records, markers ----------------------------

function assistantWithToolCall(
  id: string,
  timestamp: string,
  blockId: string,
  toolName: string,
  totalTokens?: number,
  command?: string,
): unknown {
  const args: Record<string, unknown> = {}
  if (command !== undefined) args.command = command
  const block: Record<string, unknown> = {
    type: 'toolCall',
    id: blockId,
    name: toolName,
    arguments: args,
  }
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: [block],
  }
  if (totalTokens !== undefined) {
    message.usage = { totalTokens }
  }
  return { type: 'message', id, timestamp, message }
}

function toolResultEntry(
  id: string,
  timestampMs: number,
  toolCallId: string,
  text: string,
  isError = false,
): unknown {
  return {
    type: 'message',
    id,
    // top-level timestamp is an ISO string in real pi session files
    // (message.timestamp stays ms-epoch) — entryTimeMs clips on it
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError,
      timestamp: timestampMs,
    },
  }
}

function mainSessionEvents(sessionFile: string): FlowRunEvent[] {
  return [
    runStart('2026-11-07T01:00:00Z'),
    {
      kind: 'main-session',
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-TEST',
      sessionFile,
    },
    // AIDEV-NOTE (review blocker B2): lanes clip main entries to phase
    // windows (buildMainRows rule), so fixtures need a window bracketing
    // their entry timestamps — 01:00:30 → 01:30 covers 01:01.
    phaseStart('2026-11-07T01:00:30Z', 'plan'),
    phaseComplete('2026-11-07T01:30:00Z', 'plan'),
  ]
}

const CHILD_SESSION = '/sessions/child-1.jsonl'
const MAIN_SESSION_FILE = '/sessions/main.jsonl'

function spawnForMainChild(): FlowRunEvent {
  return spawnRecordEvent({
    at: '2026-11-07T01:02:00Z',
    sessionFile: CHILD_SESSION,
  })
}

test('paired toolCall/toolResult yield a record with duration, ok, context_tokens, labels', () => {
  const events = mainSessionEvents(MAIN_SESSION_FILE)
  const entries = [
    assistantWithToolCall(
      'a1',
      '2026-11-07T01:01:00.000Z',
      'tool_1',
      'bash',
      21_017,
      'npm test -- --watch',
    ),
    toolResultEntry(
      'a2',
      Date.parse('2026-11-07T01:01:05.500Z'),
      'tool_1',
      'all tests passed\nmore output',
    ),
  ]
  const sessions = new Map([[MAIN_SESSION_FILE, entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const calls = result.records.filter(
    (record): record is ToolCallRecord =>
      'tool' in record && record.tool === 'bash',
  )
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.session, 'PMR-TEST run 1')
  assert.equal(call.agent_id, 'main')
  assert.equal(call.tool_use_id, 'tool_1')
  assert.equal(call.name, 'npm')
  assert.equal(call.args, 'npm test -- --watch')
  assert.equal(call.duration_ms, 5_500)
  assert.equal(call.ok, true)
  assert.equal(call.context_tokens, 21_017)
  assert.equal(call.result, 'all tests passed')
  assert.equal(call.at, new Date('2026-11-07T01:01:05.500Z').toISOString())
  assert.equal(call.running, undefined)
})

test('isError toolResult sets ok: false; unpaired toolCall yields running: true, duration 0', () => {
  const events = mainSessionEvents(MAIN_SESSION_FILE)
  const entries = [
    assistantWithToolCall('a1', '2026-11-07T01:01:00.000Z', 'tool_1', 'edit'),
    toolResultEntry(
      'a2',
      Date.parse('2026-11-07T01:01:02.000Z'),
      'tool_1',
      'failed',
      true,
    ),
    assistantWithToolCall('a3', '2026-11-07T01:02:00.000Z', 'tool_2', 'read'),
  ]
  const sessions = new Map([[MAIN_SESSION_FILE, entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const calls = result.records.filter(
    (record): record is ToolCallRecord =>
      'tool' in record && record.tool !== 'Skill' && !('event' in record),
  )
  assert.equal(calls.length, 2)
  const failed = calls.find((c) => c.tool_use_id === 'tool_1')
  assert.equal(failed?.ok, false)
  assert.equal(failed?.duration_ms, 2_000)
  const running = calls.find((c) => c.tool_use_id === 'tool_2')
  assert.equal(running?.running, true)
  assert.equal(running?.duration_ms, 0)
  assert.equal(running?.ok, undefined)
  assert.equal(running?.at, new Date('2026-11-07T01:02:00.000Z').toISOString())
})

test('long labels are clipped to 60 chars', () => {
  const events = mainSessionEvents(MAIN_SESSION_FILE)
  const entries = [
    assistantWithToolCall(
      'a1',
      '2026-11-07T01:01:00.000Z',
      'tool_1',
      'bash',
      undefined,
      `npm ${'x'.repeat(100)}`,
    ),
    toolResultEntry(
      'a2',
      Date.parse('2026-11-07T01:01:01.000Z'),
      'tool_1',
      'y'.repeat(100),
    ),
  ]
  const sessions = new Map([[MAIN_SESSION_FILE, entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const call = result.records.find(
    (record): record is ToolCallRecord =>
      'tool' in record && record.tool === 'bash',
  )
  assert.ok(call)
  assert.ok((call.args ?? '').length <= 60)
  assert.ok((call.result ?? '').length <= 60)
})

test('orchestrator subagent tool calls are skipped', () => {
  const events = mainSessionEvents(MAIN_SESSION_FILE)
  const entries = [
    assistantWithToolCall(
      'a1',
      '2026-11-07T01:01:00.000Z',
      'tool_1',
      'subagent',
    ),
  ]
  const sessions = new Map([[MAIN_SESSION_FILE, entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  // AIDEV-NOTE (review blocker B2): the bracketed factory emits phase-marker
  // records, so absence is asserted at the CALL level — the raw orchestrator
  // subagent tool call must not become a tool-call record.
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const calls = result.records.filter(
    (record) => 'tool_use_id' in record && 'tool' in record,
  )
  assert.deepEqual(calls, [])
})

test('one SubagentStop spend record per context, main included, exact mapping', () => {
  const events = [
    runStart('2026-11-07T01:00:00Z'),
    spawnForMainChild(),
    // AIDEV-NOTE (review blocker B2): phase window bracketing the main
    // entries (01:01/01:02) — main lanes clip to windows; child lanes keep
    // per-run session semantics.
    phaseStart('2026-11-07T01:00:30Z', 'plan'),
    phaseComplete('2026-11-07T01:30:00Z', 'plan'),
  ]
  const mainEntries = [
    assistantEntry('m1', '2026-11-07T01:01:00Z', {
      input: 10,
      cacheWrite: 1,
      cacheRead: 2,
      output: 5,
    }),
    assistantEntry('m1', '2026-11-07T01:02:00Z', {
      input: 999,
      cacheWrite: 999,
      cacheRead: 999,
      output: 999,
    }),
  ]
  const childEntries = [
    assistantEntry('c1', '2026-11-07T01:03:00Z', {
      input: 100,
      cacheWrite: 0,
      cacheRead: 50,
      output: 10,
    }),
  ]
  const sessions = new Map([
    [CHILD_SESSION, childEntries],
    [MAIN_SESSION_FILE, mainEntries],
  ])
  const eventsWithMain = [
    ...events,
    {
      kind: 'main-session' as const,
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-TEST',
      sessionFile: MAIN_SESSION_FILE,
    },
  ]
  const result = buildDiagram('PMR-TEST', 1, eventsWithMain, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const spends = result.records.filter(
    (record): record is SpendRecord =>
      'event' in record && record.event === 'SubagentStop',
  )
  assert.equal(spends.length, 2)
  const main = spends.find((s) => s.agent_id === 'main')
  assert.ok(main)
  // dedup by message id: the duplicate m1 (999s) must be ignored
  assert.deepEqual(main.spend, { new: 11, cached: 2, out: 5, calls: 1 })
  assert.equal(main.at, new Date('2026-11-07T01:02:00Z').toISOString())
  const child = spends.find((s) => s.agent_id === 'child-1')
  assert.ok(child)
  assert.deepEqual(child.spend, { new: 100, cached: 50, out: 10, calls: 1 })
})

test('phase-start events yield PreCompact markers; gate/receipt/commit milestones yield Skill markers', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
    phaseStart('2026-11-07T01:02:00Z', 'implement'),
    {
      kind: 'gate-decision',
      at: '2026-11-07T01:03:00Z',
      ref: 'PMR-TEST',
      gate: 'code-review',
      targetId: 't1',
      status: 'pass',
    },
    {
      kind: 'gate-decision',
      at: '2026-11-07T01:04:00Z',
      ref: 'PMR-TEST',
      gate: 'code-review',
      targetId: 't1',
      status: 'fail',
    },
    {
      kind: 'command-receipt',
      at: '2026-11-07T01:05:00Z',
      ref: 'PMR-TEST',
      command: 'flow_phase_complete',
      target: 'implement',
      status: 'ok',
    },
    {
      kind: 'subtask-ranges',
      at: '2026-11-07T01:06:00Z',
      ref: 'PMR-TEST',
      gate: 'code-review',
      baseSha: 'a',
      headSha: 'b',
      bySubtask: [{ subtask: '2.1', commits: ['abcdef1234'] }],
      unattributed: [],
    },
  ]
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const markers = result.records.filter(
    (record): record is MilestoneMarkerRecord =>
      'tool' in record && record.tool === 'Skill',
  )
  const names = markers.map((m) => m.name)
  // latest gate-decision per gate wins (rejected, not approved)
  assert.ok(names.includes('gate code-review: fail'))
  assert.ok(!names.includes('gate code-review: pass'))
  assert.ok(names.includes('receipt: flow_phase_complete'))
  assert.ok(names.includes('commit abcdef1 → 2.1'))
  // sequential mark ids
  assert.deepEqual(
    markers.map((m) => m.tool_use_id),
    ['mark-1', 'mark-2', 'mark-3'],
  )
  const phaseMarkers = result.records.filter(
    (record): record is PhaseMarkerRecord =>
      'event' in record && record.event === 'PreCompact',
  )
  assert.deepEqual(
    phaseMarkers.map((m) => m.trigger),
    ['phase plan', 'phase implement'],
  )
  for (const marker of [...markers, ...phaseMarkers]) {
    assert.equal(marker.session, 'PMR-TEST run 1')
    assert.equal(marker.agent_id, 'main')
  }
})

test('records are sorted by at', () => {
  const events = [runStart('2026-11-07T01:00:00Z'), spawnForMainChild()]
  const childEntries = [
    assistantEntry('c1', '2026-11-07T01:03:00Z', {
      input: 1,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1,
    }),
  ]
  const sessions = new Map([[CHILD_SESSION, childEntries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  const ats = result.records.map((r) => r.at)
  const sorted = [...ats].sort()
  assert.deepEqual(ats, sorted)
})

// AIDEV-NOTE (review blocker B2): main sessions resume across runs, so a
// lane must only carry entries inside the SELECTED segment's phase windows —
// same rule as buildMainRows in flow/cost.ts. Pre/post-flow chat and the
// other run's entries must not leak into main-lane calls or token totals.
function mainSessionCall(id: string, atIso: string): readonly unknown[] {
  const ms = Date.parse(atIso)
  return [
    {
      type: 'message',
      id: `a-${id}`,
      timestamp: atIso,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id,
            name: 'bash',
            arguments: { command: `echo ${id}` },
          },
        ],
        usage: {
          input: 10,
          cacheWrite: 0,
          cacheRead: 0,
          output: 1,
          totalTokens: 11,
        },
      },
    },
    {
      type: 'message',
      id: `r-${id}`,
      timestamp: atIso,
      message: {
        role: 'toolResult',
        toolCallId: id,
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: ms + 5,
      },
    },
  ]
}

function resumedMainEvents(): FlowRunEvent[] {
  return [
    runStart('2026-11-07T01:00:00Z'),
    {
      kind: 'main-session',
      at: '2026-11-07T01:00:30Z',
      ref: 'PMR-TEST',
      sessionFile: '/sessions/main.jsonl',
    },
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
    phaseComplete('2026-11-07T01:11:00Z', 'plan'),
    runStart('2026-11-07T02:00:00Z'),
    {
      kind: 'main-session',
      at: '2026-11-07T02:00:30Z',
      ref: 'PMR-TEST',
      sessionFile: '/sessions/main.jsonl',
    },
    phaseStart('2026-11-07T02:01:00Z', 'implement'),
    phaseComplete('2026-11-07T02:31:00Z', 'implement'),
  ]
}

function resumedMainEntries(): Map<string, readonly unknown[]> {
  const entries = [
    ...mainSessionCall('tc-pre', '2026-11-07T00:59:30Z'),
    ...mainSessionCall('tc-run1', '2026-11-07T01:05:00Z'),
    ...mainSessionCall('tc-run2', '2026-11-07T02:05:00Z'),
    ...mainSessionCall('tc-post', '2026-11-07T03:00:00Z'),
  ]
  return new Map([['/sessions/main.jsonl', entries]])
}

function mainToolCallIds(result: ReturnType<typeof buildDiagram>): string[] {
  if (result.kind !== 'ok') return []
  return result.records
    .filter(
      (r): r is ToolCallRecord =>
        'tool_use_id' in r &&
        'tool' in r &&
        r.tool === 'bash' &&
        r.agent_id === 'main',
    )
    .map((r) => r.tool_use_id)
}

function mainSpendNew(
  result: ReturnType<typeof buildDiagram>,
): number | undefined {
  if (result.kind !== 'ok') return undefined
  const spend = result.records.find(
    (r): r is SpendRecord =>
      'event' in r && r.event === 'SubagentStop' && r.agent_id === 'main',
  )
  return spend?.spend.new
}

test('run 1 diagram clips main lane to run 1 windows', () => {
  const result = buildDiagram(
    'PMR-TEST',
    1,
    resumedMainEvents(),
    [],
    resumedMainEntries(),
  )
  assert.equal(result.kind, 'ok')
  assert.deepEqual(mainToolCallIds(result), ['tc-run1'])
  assert.equal(mainSpendNew(result), 10)
})

test('run 2 diagram clips main lane to run 2 windows', () => {
  const result = buildDiagram(
    'PMR-TEST',
    2,
    resumedMainEvents(),
    [],
    resumedMainEntries(),
  )
  assert.equal(result.kind, 'ok')
  assert.deepEqual(mainToolCallIds(result), ['tc-run2'])
  assert.equal(mainSpendNew(result), 10)
})

// --- PMR-9CHQ: NaN/unparseable timestamps degrade, never throw ----------

test('timestamp-less toolCall entry is skipped with a warning, render survives', () => {
  // Child lanes are NOT window-clipped, so a timestamp-less assistant entry
  // reaches the synthesizer; previously this produced at: '' which threw in
  // the vendored renderer's clock().
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    spawnRecordEvent({
      at: '2026-11-07T01:02:00Z',
      sessionFile: CHILD_SESSION,
    }),
  ]
  const entries = [
    // assistant entry with a toolCall but NO timestamp at all
    {
      type: 'message',
      id: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-no-ts', name: 'read', arguments: {} },
        ],
      },
    },
  ]
  const sessions = new Map([[CHILD_SESSION, entries]])
  const result = buildDiagram('PMR-TEST', 1, events, [], sessions)
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(
    result.records.filter(
      (r) => 'tool_use_id' in r && r.tool_use_id === 'tc-no-ts',
    ).length,
    0,
  )
  // the spawn record itself (valid at) still renders
  assert.equal(okSpawn(result).length, 1)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /unparseable or missing timestamp/)
})

test('corrupted spawn note at is skipped with a warning, markers survive', () => {
  const events: FlowRunEvent[] = [
    runStart('2026-11-07T01:00:00Z'),
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
    spawnRecordEvent({ at: 'not-a-date', sessionFile: undefined }),
  ]
  const result = buildDiagram('PMR-TEST', 1, events, [], new Map())
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(okSpawn(result).length, 0)
  // the phase marker from the healthy journal event still renders
  assert.ok(
    result.records.some((r) => 'trigger' in r && r.trigger === 'phase plan'),
  )
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /unparseable or missing timestamp/)
})
