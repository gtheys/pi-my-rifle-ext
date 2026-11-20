// AIDEV-NOTE: /flow-diagram command tests — arg matrix + handler
// degradation matrix, mirroring test/cost.test.ts stub-ExtensionAPI style.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import type { FlowDiagramDeps } from '../flow-diagram/command.ts'
import {
  parseDiagramArgs,
  registerFlowDiagramCommand,
} from '../flow-diagram/command.ts'
import type { FlowRunEvent } from '../run-state.ts'

const noopDeps: FlowDiagramDeps = {
  readRunEvents: async () => null,
  listAssignmentRecords: () => [],
  readSessionFile: () => null,
  loadRenderer: () => null,
  writeDiagram: async () => '/tmp/diagram.html',
  openDiagram: async () => true,
}

interface Notif {
  message: string
  level: string
}

function stubPi(commands: Map<string, Handler>): ExtensionAPI {
  return {
    registerCommand: (name: string, def: { handler: Handler }) => {
      commands.set(name, def.handler)
    },
  } as unknown as ExtensionAPI
}

type Handler = (args: string, ctx: unknown) => Promise<void>

function assistantEntry(totalTokens: number): string {
  return JSON.stringify({
    type: 'message',
    id: 'a1',
    timestamp: '2026-11-07T01:00:01.000Z',
    message: {
      role: 'assistant',
      content: [],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 0,
        totalTokens,
      },
    },
  })
}

function journal(ref: string): FlowRunEvent[] {
  return [
    { kind: 'run-start', at: '2026-11-07T01:00:00Z', ref, mode: 'personal' },
    {
      kind: 'phase-start',
      at: '2026-11-07T01:00:01Z',
      ref,
      phase: 'plan',
    },
  ]
}

test('parseDiagramArgs arg matrix', () => {
  assert.deepEqual(parseDiagramArgs(''), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('   '), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('PMR-ABC'), {
    kind: 'ok',
    ref: 'PMR-ABC',
    run: null,
  })
  // aven:-prefixed ref accepted and stripped
  assert.deepEqual(parseDiagramArgs('aven:PMR-ABC'), {
    kind: 'ok',
    ref: 'PMR-ABC',
    run: null,
  })
  // valid run selector
  assert.deepEqual(parseDiagramArgs('PMR-ABC 2'), {
    kind: 'ok',
    ref: 'PMR-ABC',
    run: 2,
  })
  assert.deepEqual(parseDiagramArgs('aven:PMR-ABC 3'), {
    kind: 'ok',
    ref: 'PMR-ABC',
    run: 3,
  })
  // non-numeric, zero, negative, fractional run, extra token -> help
  assert.deepEqual(parseDiagramArgs('PMR-ABC two'), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('PMR-ABC 0'), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('PMR-ABC -1'), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('PMR-ABC 1.5'), { kind: 'help' })
  assert.deepEqual(parseDiagramArgs('PMR-ABC 2 3'), { kind: 'help' })
})

test('handler: no args -> usage info notify', async () => {
  const commands = new Map<string, Handler>()
  registerFlowDiagramCommand(stubPi(commands), noopDeps)
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'info')
  assert.match(notifications[0].message, /Usage: \/flow-diagram <ref> \[run\]/)
})

test('handler: invalid ref -> warning with charset wording', async () => {
  const commands = new Map<string, Handler>()
  registerFlowDiagramCommand(stubPi(commands), noopDeps)
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('bad!ref', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(
    notifications[0].message,
    /invalid ref \(must match \[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,99\}\)/,
  )
})

test('handler: renderer load null -> warning, no write', async () => {
  const commands = new Map<string, Handler>()
  let wrote = false
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    readRunEvents: async () => journal('PMR-DIA'),
    writeDiagram: async () => {
      wrote = true
      return '/tmp/never.html'
    },
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(notifications[0].message, /renderer/)
  assert.equal(wrote, false)
})

test('handler: no journal -> warning', async () => {
  const commands = new Map<string, Handler>()
  const rendererLoads: number[] = []
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => {
      rendererLoads.push(1)
      return { renderHtml: () => '<html></html>' }
    },
    readRunEvents: async () => null,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-NOPE', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(notifications[0].message, /no run journal found/)
  // renderer loaded before the journal read, matching the handler flow
  assert.equal(rendererLoads.length, 1)
})

test('handler: run out of range -> warning naming run count', async () => {
  const commands = new Map<string, Handler>()
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-DIA',
      mode: 'personal',
    },
    {
      kind: 'run-start',
      at: '2026-11-07T02:00:00Z',
      ref: 'PMR-DIA',
      mode: 'personal',
    },
  ]
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => ({ renderHtml: () => '<html></html>' }),
    readRunEvents: async () => events,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA 5', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(notifications[0].message, /journal has 2 run/)
})

test('handler: no records -> warning', async () => {
  const commands = new Map<string, Handler>()
  // journal with no run-start and nothing synthesizable
  const events: FlowRunEvent[] = []
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => ({ renderHtml: () => '<html></html>' }),
    readRunEvents: async () => events,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(notifications[0].message, /nothing to diagram/)
})

test('handler: write ok + open ok -> path notified as info', async () => {
  const commands = new Map<string, Handler>()
  let rendered = false
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => ({
      renderHtml: () => {
        rendered = true
        return '<html>/*FLOW_HEADER*/null</html>'
      },
    }),
    readRunEvents: async () => journal('PMR-DIA'),
    writeDiagram: async (html: string) => {
      assert.match(html, /<html>/)
      return '/tmp/diagram.html'
    },
    openDiagram: async () => true,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(rendered, true)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'info')
  assert.match(notifications[0].message, /\/tmp\/diagram\.html/)
})

test('handler: write ok + open fails -> warning that still shows the path', async () => {
  const commands = new Map<string, Handler>()
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => ({ renderHtml: () => '<html></html>' }),
    readRunEvents: async () => journal('PMR-DIA'),
    writeDiagram: async () => '/tmp/diagram.html',
    openDiagram: async () => false,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].level, 'warning')
  assert.match(notifications[0].message, /open failed/)
  assert.match(notifications[0].message, /\/tmp\/diagram\.html/)
})

test('handler: unreadable session files -> exactly one summary notify', async () => {
  const commands = new Map<string, Handler>()
  // Two spawn notes pointing at missing files, plus one readable main session.
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-DIA',
      mode: 'personal',
    },
    {
      kind: 'main-session',
      at: '2026-11-07T01:00:00Z',
      ref: 'PMR-DIA',
      sessionFile: '/main.jsonl',
    },
    {
      kind: 'spawn-record',
      at: '2026-11-07T01:00:01Z',
      ref: 'PMR-DIA',
      childId: 'c1',
      name: 'scout',
      spawnKind: 'spawn',
      sessionFile: '/missing1.jsonl',
    },
    {
      kind: 'spawn-record',
      at: '2026-11-07T01:00:02Z',
      ref: 'PMR-DIA',
      childId: 'c2',
      name: 'worker',
      spawnKind: 'spawn',
      sessionFile: '/missing2.jsonl',
    },
  ]
  registerFlowDiagramCommand(stubPi(commands), {
    ...noopDeps,
    loadRenderer: () => ({ renderHtml: () => '<html></html>' }),
    readRunEvents: async () => events,
    listAssignmentRecords: () => [] as AssignmentRecord[],
    readSessionFile: (file: string) => {
      if (file === '/main.jsonl') return `${assistantEntry(100)}\n`
      return null
    },
    writeDiagram: async () => '/tmp/diagram.html',
    openDiagram: async () => true,
  })
  const handler = commands.get('flow-diagram')
  assert.ok(handler !== undefined)
  const notifications: Notif[] = []
  await handler('PMR-DIA', {
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
  })
  const summaries = notifications.filter((n) =>
    /session files unreadable/.test(n.message),
  )
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].level, 'info')
  assert.match(summaries[0].message, /2 session files unreadable/)
})
