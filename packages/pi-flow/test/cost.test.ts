import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  buildPushBody,
  buildWorkerRows,
  collectSpawnNotes,
  countToolCalls,
  formatCostReport,
  parseSessionEntries,
  parseSpawnNote,
  phaseDurations,
  pushToGateway,
} from '../flow/cost.ts'
import { parseCostArgs, registerFlowCostCommand } from '../flow/cost-command.ts'
import type { FlowRunEvent } from '../run-state.ts'

function assistantEntry(cost: number, input = 10): unknown {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      usage: {
        input,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: cost },
      },
    },
  }
}

function toolEntry(tool: string, isError: boolean): unknown {
  return {
    type: 'message',
    message: { role: 'toolResult', toolName: tool, isError },
  }
}

function noteEvent(at: string, text: string, ref = 'PMR-TEST'): FlowRunEvent {
  return { kind: 'note', at, ref, text }
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

test('parseSpawnNote handles old and new journal formats', () => {
  const old = parseSpawnNote(
    'subagent child-1 ("worker-1") spawn for subtask PMR-A1 — attribution env stamped',
    'implement',
  )
  assert.ok(old !== null)
  assert.equal(old.childId, 'child-1')
  assert.equal(old.name, 'worker-1')
  assert.equal(old.kind, 'spawn')
  assert.equal(old.subtask, 'PMR-A1')
  assert.equal(old.sessionFile, null)
  assert.equal(old.phase, 'implement')

  const withSession = parseSpawnNote(
    'subagent child-2 ("scout") spawn — attribution env stamped, session="/sessions/s2.jsonl"',
    null,
  )
  assert.ok(withSession !== null)
  assert.equal(withSession.subtask, null)
  assert.equal(withSession.sessionFile, '/sessions/s2.jsonl')
  assert.equal(withSession.phase, null)

  assert.equal(parseSpawnNote('unrelated note text', 'plan'), null)
})

test('collectSpawnNotes annotates the active phase and ignores other notes', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: '2026-11-07T01:00:00Z', ref: 'R', mode: 'work' },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:01:00Z',
      ref: 'R',
      phase: 'plan',
    },
    noteEvent(
      '2026-11-07T01:02:00Z',
      'subagent c1 ("scout") spawn — attribution env stamped, session="/s1.jsonl"',
    ),
    {
      kind: 'phase-complete',
      at: '2026-11-07T01:10:00Z',
      ref: 'R',
      phase: 'plan',
      label: 'done-plan',
    },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:11:00Z',
      ref: 'R',
      phase: 'implement',
    },
    noteEvent(
      '2026-11-07T01:12:00Z',
      'subagent c2 ("worker") spawn for subtask PMR-A1 — attribution env stamped, session="/s2.jsonl"',
    ),
    noteEvent('2026-11-07T01:13:00Z', 'some other note'),
  ]
  const notes = collectSpawnNotes(events)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].phase, 'plan')
  assert.equal(notes[1].phase, 'implement')
  assert.equal(notes[1].subtask, 'PMR-A1')
})

test('parseSessionEntries skips empty and torn lines', () => {
  const text = `${JSON.stringify(assistantEntry(0.01))}\n\n{"broken": \n${JSON.stringify(toolEntry('bash', false))}\n`
  const entries = parseSessionEntries(text)
  assert.equal(entries.length, 2)
})

test('countToolCalls groups by tool and status', () => {
  const entries = [
    toolEntry('bash', false),
    toolEntry('bash', true),
    toolEntry('bash', false),
    toolEntry('edit', false),
    { type: 'message', message: { role: 'toolResult', isError: true } },
    { type: 'message', message: { role: 'assistant' } },
  ]
  const counts = countToolCalls(entries)
  assert.deepEqual(counts, [
    { tool: 'bash', status: 'error', count: 1 },
    { tool: 'bash', status: 'ok', count: 2 },
    { tool: 'edit', status: 'ok', count: 1 },
    { tool: 'unknown', status: 'error', count: 1 },
  ])
})

test('buildWorkerRows sums usage per unique session and flags coverage gaps', () => {
  const notes = [
    {
      childId: 'c1',
      name: 'scout',
      kind: 'spawn' as const,
      subtask: null,
      sessionFile: '/s1.jsonl',
      at: '',
      phase: 'plan' as const,
    },
    {
      childId: 'c2',
      name: 'worker',
      kind: 'spawn' as const,
      subtask: 'PMR-A1',
      sessionFile: '/s2.jsonl',
      at: '',
      phase: 'implement' as const,
    },
    {
      childId: 'c3',
      name: 'gone',
      kind: 'spawn' as const,
      subtask: null,
      sessionFile: '/missing.jsonl',
      at: '',
      phase: 'validate' as const,
    },
  ]
  const sessions = new Map<string, readonly unknown[]>([
    ['/s1.jsonl', [assistantEntry(0.02), toolEntry('bash', false)]],
    ['/s2.jsonl', [assistantEntry(0.1, 100), assistantEntry(0.05, 50)]],
  ])
  const rows = buildWorkerRows(notes, [], sessions)
  assert.equal(rows.length, 3)
  const scout = rows.find((r) => r.name === 'scout')
  const worker = rows.find((r) => r.name === 'worker')
  const gone = rows.find((r) => r.name === 'gone')
  assert.ok(scout && worker && gone)
  assert.equal(scout.summary.sawUsage, true)
  assert.equal(scout.summary.totals.cost, 0.02)
  assert.deepEqual(scout.toolCalls, [{ tool: 'bash', status: 'ok', count: 1 }])
  assert.equal(worker.summary.totals.input, 150)
  assert.ok(Math.abs(worker.summary.totals.cost - 0.15) < 1e-9)
  // coverage gap: file never read — flags, never invented zeros
  assert.equal(gone.sessionAvailable, false)
  assert.equal(gone.summary.sawUsage, false)
  assert.equal(gone.summary.totals.cost, 0)
})

test('buildWorkerRows attributes a takeover to the last note holder', () => {
  const notes = [
    {
      childId: 'c1',
      name: 'worker-a',
      kind: 'spawn' as const,
      subtask: 'PMR-A1',
      sessionFile: '/shared.jsonl',
      at: '',
      phase: 'implement' as const,
    },
    {
      childId: 'c2',
      name: 'worker-b',
      kind: 'resume' as const,
      subtask: 'PMR-A1',
      sessionFile: '/shared.jsonl',
      at: '',
      phase: 'implement' as const,
    },
  ]
  const sessions = new Map<string, readonly unknown[]>([
    ['/shared.jsonl', [assistantEntry(0.5)]],
  ])
  const rows = buildWorkerRows(notes, [], sessions)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'worker-b')
  assert.equal(rows[0].summary.totals.cost, 0.5)
})

test('buildWorkerRows falls back to assignment records', () => {
  // note without session path or subtask; record supplies both
  const notes = [
    {
      childId: 'c9',
      name: 'legacy',
      kind: 'spawn' as const,
      subtask: null,
      sessionFile: null,
      at: '',
      phase: 'implement' as const,
    },
  ]
  const records = [
    assignment({
      childId: 'c9',
      name: 'legacy',
      sessionFile: '/from-record.jsonl',
      subtask: 'PMR-B2',
    }),
  ]
  const sessions = new Map<string, readonly unknown[]>([
    ['/from-record.jsonl', [assistantEntry(0.07)]],
  ])
  const rows = buildWorkerRows(notes, records, sessions)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionFile, '/from-record.jsonl')
  assert.equal(rows[0].subtask, 'PMR-B2')
  assert.equal(rows[0].summary.totals.cost, 0.07)
  // no record + no note session => coverage gap row, sessionFile stays null
  const orphan = buildWorkerRows(
    [
      {
        childId: 'cX',
        name: 'orphan',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: null,
        at: '',
        phase: 'plan' as const,
      },
    ],
    records,
    sessions,
  )
  assert.equal(orphan[0].sessionFile, null)
  assert.equal(orphan[0].sessionAvailable, false)
})

test('phaseDurations covers completed and still-open phases', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: '2026-11-07T01:00:00Z', ref: 'R', mode: 'work' },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:00:10Z',
      ref: 'R',
      phase: 'plan',
    },
    {
      kind: 'phase-complete',
      at: '2026-11-07T01:01:10Z',
      ref: 'R',
      phase: 'plan',
      label: 'l',
    },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:02:00Z',
      ref: 'R',
      phase: 'implement',
    },
    noteEvent(
      '2026-11-07T01:05:00Z',
      'subagent c1 ("s") spawn — attribution env stamped, session="/s.jsonl"',
    ),
  ]
  const durations = phaseDurations(events)
  assert.deepEqual(durations, [
    { phase: 'implement', seconds: 180 },
    { phase: 'plan', seconds: 60 },
  ])
})

test('formatCostReport shows rows, coverage flags, and totals without invented zeros', () => {
  const rows = buildWorkerRows(
    [
      {
        childId: 'c1',
        name: 'scout',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s1.jsonl',
        at: '',
        phase: 'plan' as const,
      },
      {
        childId: 'c2',
        name: 'gone',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: null,
        at: '',
        phase: 'validate' as const,
      },
    ],
    [],
    new Map<string, readonly unknown[]>([
      ['/s1.jsonl', [assistantEntry(1234.5, 123456)]],
    ]),
  )
  const report = formatCostReport('PMR-TEST', rows, [
    { phase: 'plan', seconds: 61 },
  ])
  assert.match(report, /flow-cost PMR-TEST — 2 worker session\(s\)/)
  assert.match(report, /scout\s+-\s+plan\s+123,464\s+\$1234\.5000\s+ok/)
  assert.match(report, /gone\s+-\s+validate\s+-\s+-\s+NO SESSION/)
  assert.match(
    report,
    /TOTAL 123,464 tokens\s+\$1234\.5000\s+\(1\/2 session\(s\) reported usage\)/,
  )
  assert.match(report, /plan: 61s/)
})

test('buildPushBody emits labeled metrics and skips usage-less rows', () => {
  const rows = buildWorkerRows(
    [
      {
        childId: 'c1',
        name: 'worker "quoted"',
        kind: 'spawn' as const,
        subtask: 'PMR-A1',
        sessionFile: '/s1.jsonl',
        at: '',
        phase: 'implement' as const,
      },
      {
        childId: 'c2',
        name: 'dark',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: null,
        at: '',
        phase: 'plan' as const,
      },
    ],
    [],
    new Map<string, readonly unknown[]>([
      ['/s1.jsonl', [assistantEntry(0.5, 100), toolEntry('bash', true)]],
    ]),
  )
  const body = buildPushBody('PMR-TEST', rows, [
    { phase: 'implement', seconds: 42.5 },
  ])
  assert.match(
    body,
    /pi_flow_run_cost_usd\{ref="PMR-TEST",phase="implement",agent="worker \\"quoted\\"",subtask="PMR-A1",session="c1"\} 0\.5/,
  )
  assert.match(
    body,
    /pi_flow_tokens_total\{ref="PMR-TEST",phase="implement",agent="worker \\"quoted\\"",kind="input",session="c1"\} 100/,
  )
  assert.match(
    body,
    /pi_flow_tool_calls_total\{ref="PMR-TEST",phase="implement",agent="worker \\"quoted\\"",tool="bash",status="error",session="c1"\} 1/,
  )
  assert.match(
    body,
    /pi_flow_run_duration_seconds\{ref="PMR-TEST",phase="implement"\} 42\.5/,
  )
  // dark row contributed nothing
  assert.ok(!body.includes('agent="dark"'))
})

test('buildPushBody keeps label sets unique for identically-named workers', () => {
  // Two workers with the same display name, phase and no subtask — the
  // Pushgateway rejects a push containing duplicate metric label sets, so
  // the session (childId) label must disambiguate them.
  const rows = buildWorkerRows(
    [
      {
        childId: 'c1',
        name: 'Deviation check: PMR-TEST',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s1.jsonl',
        at: '',
        phase: 'validate' as const,
      },
      {
        childId: 'c2',
        name: 'Deviation check: PMR-TEST',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s2.jsonl',
        at: '',
        phase: 'validate' as const,
      },
    ],
    [],
    new Map<string, readonly unknown[]>([
      ['/s1.jsonl', [assistantEntry(0.5, 100)]],
      ['/s2.jsonl', [assistantEntry(0.25, 50)]],
    ]),
  )
  const body = buildPushBody('PMR-TEST', rows, [])
  assert.match(body, /session="c1"\} 0\.5/)
  assert.match(body, /session="c2"\} 0\.25/)
  const costLines = body
    .split('\n')
    .filter((line) => line.startsWith('pi_flow_run_cost_usd'))
  assert.equal(costLines.length, 2)
  assert.notEqual(costLines[0], costLines[1])
})

test('pushToGateway posts to the grouped path with bearer auth', async () => {
  const calls: Array<{ url: string; init: unknown }> = []
  const ok = await pushToGateway(
    'https://gw.example/',
    'PMR-TEST',
    'metric 1\n',
    async (url, init) => {
      calls.push({ url, init })
      return { status: 200, statusText: 'OK' }
    },
    'sekret',
  )
  assert.deepEqual(ok, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0].url,
    'https://gw.example/metrics/job/pi-flow/ref/PMR-TEST',
  )
  const init = calls[0].init as {
    headers: Record<string, string>
    body: string
  }
  assert.equal(init.headers.authorization, 'Bearer sekret')
  assert.equal(init.body, 'metric 1\n')

  const httpFail = await pushToGateway(
    'https://gw.example',
    'PMR-TEST',
    'x',
    async () => ({ status: 503, statusText: 'unavailable' }),
  )
  assert.equal(httpFail.ok, false)
  assert.match(httpFail.error ?? '', /503/)

  const netFail = await pushToGateway(
    'https://gw.example',
    'PMR-TEST',
    'x',
    async () => {
      throw new Error('connection refused')
    },
  )
  assert.equal(netFail.ok, false)
  assert.match(netFail.error ?? '', /connection refused/)
})

test('parseCostArgs accepts ref and --push in either order', () => {
  assert.deepEqual(parseCostArgs('PMR-TEST'), {
    kind: 'ok',
    ref: 'PMR-TEST',
    push: false,
  })
  assert.deepEqual(parseCostArgs('PMR-TEST --push'), {
    kind: 'ok',
    ref: 'PMR-TEST',
    push: true,
  })
  assert.deepEqual(parseCostArgs('--push PMR-TEST'), {
    kind: 'ok',
    ref: 'PMR-TEST',
    push: true,
  })
  assert.deepEqual(parseCostArgs(''), { kind: 'help' })
  assert.deepEqual(parseCostArgs('a b'), { kind: 'help' })
})

test('registerFlowCostCommand end-to-end with injected deps', async () => {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const pi = {
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, def)
    },
  } as unknown as ExtensionAPI
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-E2E',
      mode: 'personal',
    },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:00:01Z',
      ref: 'PMR-E2E',
      phase: 'plan',
    },
    noteEvent(
      '2026-11-07T01:00:02Z',
      'subagent c1 ("scout") spawn — attribution env stamped, session="/s1.jsonl"',
      'PMR-E2E',
    ),
  ]
  const notifications: Array<{ message: string; level: string }> = []
  registerFlowCostCommand(pi, {
    readRunEvents: async () => events,
    listAssignmentRecords: () => [],
    readSessionFile: (file) => {
      if (file === '/s1.jsonl') {
        return `${JSON.stringify(assistantEntry(0.03))}\n`
      }
      return null
    },
    push: async () => ({
      ok: false,
      error: 'PI_FLOW_PUSHGATEWAY_URL is not set',
    }),
  })
  const ctx = {
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
  }
  const def = commands.get('flow-cost')
  assert.ok(def !== undefined)

  await def.handler('PMR-E2E --push', ctx)
  assert.equal(notifications.length, 2)
  assert.match(notifications[0].message, /flow-cost PMR-E2E/)
  assert.match(notifications[0].message, /scout\s+-\s+plan/)
  assert.equal(notifications[0].level, 'info')
  assert.match(notifications[1].message, /pushgateway push FAILED/)
  assert.equal(notifications[1].level, 'warning')

  notifications.length = 0
  await def.handler('', ctx)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /Usage: \/flow-cost/)

  notifications.length = 0
  await def.handler('bad!ref', ctx)
  assert.match(notifications[0].message, /invalid ref/)
  assert.equal(notifications[0].level, 'warning')

  notifications.length = 0
  const missingCommands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const pi3 = {
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      missingCommands.set(name, def)
    },
  } as unknown as ExtensionAPI
  registerFlowCostCommand(pi3, {
    readRunEvents: async () => null,
    listAssignmentRecords: () => [],
    readSessionFile: () => null,
    push: async () => ({ ok: true }),
  })
  await missingCommands.get('flow-cost')?.handler('PMR-NOPE', ctx)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /no run journal found/)
})
