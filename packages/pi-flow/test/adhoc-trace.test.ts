import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { adhocSpanAttributes, buildAdhocBody } from '../adhoc/tracker.ts'
import { registerTelemetry } from '../telemetry/index.ts'

type Handler = (event: never, ctx: { cwd: string }) => unknown
class FakePi {
  handlers = new Map<string, Handler[]>()
  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {}
  }
  emit(event: string, payload?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) {
      void h((payload ?? {}) as never, { cwd: '/repo' })
    }
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

interface OutSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  attributes: Array<{ key: string; value: { stringValue: string } }>
}

async function setup() {
  const pi = new FakePi()
  const spans: OutSpan[] = []
  let counter = 0
  const handle = registerTelemetry(pi as unknown as ExtensionAPI, {
    loadSettings: async () => ({ endpoint: 'https://t', headers: {} }),
    env: {},
    rng: {
      bytes: (n: number) => {
        counter += 1
        return new Uint8Array(n).fill(counter)
      },
    },
    fetchImpl: (async (_u: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body)
      for (const s of parsed.resourceSpans[0].scopeSpans[0].spans) spans.push(s)
      return { status: 200 }
    }) as never,
    now: () => 1_700_000_000_000,
    onExportFailure: () => {},
  })
  pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  return { pi, handle, spans }
}

const attr = (s: OutSpan, key: string) =>
  s.attributes.find((a) => a.key === key)?.value.stringValue

const RUN = {
  id: 'brainstorm-t-1',
  kind: 'brainstorm',
  target: 'topic',
  startMs: 1_700_000_000_000,
  endMs: 1_700_000_060_000,
}

test('main-session run: root marker at begin, tool spans nest under it, one run span at end', async () => {
  const { pi, handle, spans } = await setup()
  handle.adhocBegin(RUN, true)
  await tick()
  // marker is exported immediately (before anything closes)
  const root = spans.find((s) => s.name === 'brainstorm topic')
  assert.ok(root !== undefined)
  assert.equal(attr(root, 'flow.span'), 'adhoc')
  pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  })
  handle.adhocEnd(RUN, { 'adhoc.cost_usd': '0.5', 'adhoc.run': RUN.id })
  await tick()
  pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  const tool = spans.find((s) => s.name === 'tool bash')
  const run = spans.find((s) => s.name === 'brainstorm run')
  assert.ok(tool !== undefined && run !== undefined)
  assert.equal(tool.traceId, root.traceId)
  assert.equal(tool.parentSpanId, root.spanId)
  assert.equal(run.traceId, root.traceId)
  assert.equal(run.parentSpanId, root.spanId)
  assert.equal(attr(run, 'flow.span'), 'adhoc-run')
  assert.equal(attr(run, 'adhoc.cost_usd'), '0.5')
  assert.equal(attr(tool, 'adhoc.run'), RUN.id)
  assert.equal(spans.filter((s) => s.name === 'brainstorm topic').length, 1)
})

test('after the run, spans leave the ad-hoc trace', async () => {
  const { pi, handle, spans } = await setup()
  handle.adhocBegin(RUN, true)
  handle.adhocEnd(RUN, {})
  pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'read',
    args: {},
  })
  pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't2',
    toolName: 'read',
    result: 'ok',
    isError: false,
  })
  pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  const root = spans.find((s) => s.name === 'brainstorm topic')
  const later = spans.find((s) => s.name === 'tool read')
  assert.ok(root !== undefined && later !== undefined)
  assert.notEqual(later.traceId, root.traceId)
})

test('crash mid-run: marker and children are already exported, no run span', async () => {
  const { pi, handle, spans } = await setup()
  handle.adhocBegin(RUN, true)
  pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: 'ok',
    isError: false,
  })
  // only the shutdown flush (no adhocEnd) — what is left of a dying session
  pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  const root = spans.find((s) => s.name === 'brainstorm topic')
  const tool = spans.find((s) => s.name === 'tool bash')
  assert.ok(root !== undefined && tool !== undefined)
  assert.equal(tool.parentSpanId, root.spanId)
  assert.equal(
    spans.find((s) => s.name === 'brainstorm run'),
    undefined,
  )
})

test('worker run: marker at begin (no nesting), run span at end', async () => {
  const { handle, spans } = await setup()
  const run = { ...RUN, kind: 'review', target: 'PR 7' }
  handle.adhocBegin(run, false)
  await tick()
  const root = spans.find((s) => s.name === 'review PR 7')
  assert.ok(root !== undefined)
  handle.adhocEnd(run, { 'adhoc.kind': 'review' })
  await tick()
  const span = spans.find((s) => s.name === 'review run')
  assert.ok(span !== undefined)
  assert.equal(span.parentSpanId, root.spanId)
  assert.equal(attr(span, 'flow.span'), 'adhoc-run')
})

test('end without begin (telemetry enabled mid-run): marker + run span together', async () => {
  const { handle, spans } = await setup()
  handle.adhocEnd(RUN, {})
  await tick()
  assert.ok(spans.find((s) => s.name === 'brainstorm topic') !== undefined)
  assert.ok(spans.find((s) => s.name === 'brainstorm run') !== undefined)
})

test('token metrics and span attributes aggregate session usage', () => {
  const line = JSON.stringify({
    type: 'message',
    timestamp: '2026-11-09T10:00:30Z',
    message: {
      role: 'assistant',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 900,
        cacheWrite: 5,
        totalTokens: 1025,
        cost: { total: 0.3 },
      },
    },
  })
  const run = {
    id: 'r',
    kind: 'review' as const,
    target: 't',
    startMs: 0,
    endMs: 10_000,
    mainSessionFile: null,
    workers: [{ sessionFile: '/rev', role: 'review' }],
  }
  const read = () => line
  const body = buildAdhocBody(run, read)
  assert.match(body, /pi_flow_adhoc_tokens_total\{[^}]*type="cacheRead"\} 900/)
  assert.match(body, /pi_flow_adhoc_tokens_total\{[^}]*type="input"\} 100/)
  const attrs = adhocSpanAttributes(run, [
    {
      role: 'review',
      session: 'review-1',
      input: 100,
      output: 20,
      cacheRead: 900,
      cacheWrite: 5,
      cost: 0.3,
    },
  ])
  assert.equal(attrs['adhoc.tokens.cache_read'], '900')
  assert.equal(attrs['adhoc.cost_usd'], '0.3')
  assert.equal(attrs['adhoc.session_file'], '/rev')
})
