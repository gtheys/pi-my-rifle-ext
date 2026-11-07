import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readConfigFile } from '../config.ts'
import {
  flowAttributes,
  generationSpanAttributes,
  parseTraceparent,
  randomSpanId,
  randomTraceId,
  toolSpanAttributes,
} from '../telemetry/attributes.ts'
import { buildOtlpBody, exportSpans } from '../telemetry/exporter.ts'
import { registerTelemetry, sessionSpanName } from '../telemetry/index.ts'

type Handler = (event: never, ctx: { cwd: string }) => unknown

class FakePi {
  handlers = new Map<string, Handler[]>()

  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      void handler((payload ?? {}) as never, { cwd: '/repo' })
    }
  }

  subscribedEvents(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

function fakePiCast(pi: FakePi): ExtensionAPI {
  return pi as unknown as ExtensionAPI
}

const seqRng = {
  bytes: (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) out[i] = (i + 1) % 256
    return out
  },
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('flowAttributes maps env vars and drops empty values', () => {
  const attrs = flowAttributes({
    PI_FLOW_REF: 'PMR-A1',
    PI_FLOW_PHASE: 'implement',
    PI_SUBAGENT_NAME: 'worker-1',
    PI_FLOW_SUBTASK: 'PMR-B2',
    PI_SUBAGENT_PARENT_SESSION: '/sessions/parent.jsonl',
    PI_FLOW_TRACEPARENT: '00-ignored-not-mapped-here',
  })
  assert.deepEqual(attrs, {
    'flow.ref': 'PMR-A1',
    phase: 'implement',
    'agent.name': 'worker-1',
    subtask: 'PMR-B2',
    'parent.session': '/sessions/parent.jsonl',
  })
  assert.deepEqual(flowAttributes({ PI_FLOW_REF: '' }), {})
})

test('parseTraceparent accepts only well-formed values', () => {
  assert.deepEqual(
    parseTraceparent('00-0123456789abcdef0123456789abcdef-fedcba9876543210-01'),
    {
      traceId: '0123456789abcdef0123456789abcdef',
      parentId: 'fedcba9876543210',
    },
  )
  assert.equal(parseTraceparent(undefined), null)
  assert.equal(parseTraceparent('not-a-traceparent'), null)
  assert.equal(
    parseTraceparent('00-0123456789ABCDEF0123456789abcdef-fedcba9876543210-01'),
    null,
  )
})

test('random id helpers produce hex of the right length', () => {
  assert.equal(randomTraceId(seqRng).length, 32)
  assert.equal(randomSpanId(seqRng).length, 16)
  assert.match(randomTraceId(seqRng), /^[0-9a-f]{32}$/)
  assert.match(randomSpanId(seqRng), /^[0-9a-f]{16}$/)
})

test('span attribute builders follow the gen_ai conventions', () => {
  const flow = flowAttributes({ PI_FLOW_REF: 'PMR-A1' })
  const tool = toolSpanAttributes(flow, { toolName: 'bash', isError: true })
  assert.equal(tool['gen_ai.tool.name'], 'bash')
  assert.equal(tool['tool.error'], 'true')
  assert.equal(tool['flow.ref'], 'PMR-A1')

  const gen = generationSpanAttributes(flow, {
    model: 'claude-4',
    inputTokens: 100,
    outputTokens: 7,
  })
  assert.equal(gen['gen_ai.operation.name'], 'generate_content')
  assert.equal(gen['gen_ai.request.model'], 'claude-4')
  assert.equal(gen['gen_ai.usage.input_tokens'], '100')
  assert.equal(gen['gen_ai.usage.output_tokens'], '7')
})

test('buildOtlpBody wraps spans in the OTLP JSON envelope', () => {
  const body = JSON.parse(
    buildOtlpBody({ 'service.name': 'pi-flow' }, [
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        parentSpanId: 'c'.repeat(16),
        name: 'tool bash',
        kind: 1,
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        attributes: { 'flow.ref': 'PMR-A1' },
        statusCode: 2,
        statusMessage: 'bash failed',
      },
    ]),
  )
  const rs = body.resourceSpans[0]
  assert.deepEqual(rs.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'pi-flow' } },
  ])
  assert.equal(rs.scopeSpans[0].scope.name, 'pi-flow-telemetry')
  const span = rs.scopeSpans[0].spans[0]
  assert.equal(span.traceId, 'a'.repeat(32))
  assert.equal(span.parentSpanId, 'c'.repeat(16))
  assert.deepEqual(span.status, { code: 2, message: 'bash failed' })
})

test('exportSpans maps outcomes and skips empty batches', async () => {
  const calls: Array<{ url: string; body: string }> = []
  let status = 200
  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body })
    return { status }
  }
  const spans = [
    {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'x',
      kind: 1,
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {},
      statusCode: 0,
    },
  ]
  status = 200
  assert.deepEqual(
    await exportSpans('https://t:8478', {}, {}, spans, fetchImpl as never),
    { ok: true },
  )
  assert.equal(calls[0].url, 'https://t:8478/v1/traces')

  status = 503
  const fail = await exportSpans(
    'https://t:8478',
    {},
    {},
    spans,
    fetchImpl as never,
  )
  assert.equal(fail.ok, false)
  assert.match(fail.error ?? '', /503/)

  // empty batch: no call at all
  calls.length = 0
  assert.deepEqual(
    await exportSpans('https://t:8478', {}, {}, [], fetchImpl as never),
    { ok: true },
  )
  assert.equal(calls.length, 0)
})

test('exportSpans surfaces network errors as {ok:false}', async () => {
  const outcome = await exportSpans(
    'https://t:8478',
    {},
    {},
    [
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'x',
        kind: 1,
        startTimeUnixNano: '1',
        endTimeUnixNano: '2',
        attributes: {},
        statusCode: 0,
      },
    ],
    async () => {
      throw new Error('ECONNREFUSED')
    },
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /ECONNREFUSED/)
})

interface Wiring {
  pi: FakePi
  bodies: string[]
  failures: string[]
  respondStatus: number
}

async function wired(
  settings: { endpoint: string } | null,
  env: Record<string, string | undefined> = {},
): Promise<Wiring> {
  const w: Wiring = {
    pi: new FakePi(),
    bodies: [],
    failures: [],
    respondStatus: 200,
  }
  registerTelemetry(fakePiCast(w.pi), {
    loadSettings: async () => {
      if (settings === null) return null
      return { endpoint: settings.endpoint, headers: {} }
    },
    env,
    rng: seqRng,
    fetchImpl: (async (url: string, init: { body: string }) => {
      void url
      w.bodies.push(init.body)
      if (w.respondStatus !== 200) {
        throw new Error(`backend down ${w.respondStatus}`)
      }
      return { status: 200 }
    }) as never,
    now: () => 1_700_000_000_000,
    onExportFailure: (error) => {
      w.failures.push(error)
    },
  })
  return w
}

test('telemetry disabled: session_start subscribes to nothing else', async () => {
  const w = await wired(null)
  assert.deepEqual(w.pi.subscribedEvents(), ['session_start'])
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  assert.deepEqual(w.pi.subscribedEvents(), ['session_start'])
  // events that would have been telemetry inputs do nothing
  w.pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  assert.equal(w.bodies.length, 0)
  assert.equal(w.failures.length, 0)
})

test('telemetry enabled: tool + generation spans flush on shutdown', async () => {
  const w = await wired(
    { endpoint: 'https://t:8478' },
    {
      PI_FLOW_REF: 'PMR-A1',
      PI_FLOW_PHASE: 'implement',
      PI_FLOW_TRACEPARENT:
        '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
    },
  )
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  assert.deepEqual(w.pi.subscribedEvents(), [
    'session_shutdown',
    'session_start',
    'tool_execution_end',
    'tool_execution_start',
    'turn_end',
  ])

  w.pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  w.pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: {},
    isError: true,
  })
  w.pi.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 0,
    message: {
      role: 'assistant',
      model: 'claude-4',
      usage: { input: 100, output: 7 },
    },
    toolResults: [],
    messageEntryId: 'm1',
    toolResultEntryIds: [],
  })
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  assert.equal(w.bodies.length, 1)
  const body = JSON.parse(w.bodies[0])
  const spans = body.resourceSpans[0].scopeSpans[0].spans
  // tool + generation + the flow root span the main process now exports
  assert.equal(spans.length, 3)
  const toolSpan = spans.find((s: { name: string }) => s.name === 'tool bash')
  const genSpan = spans.find((s: { name: string }) => s.name === 'gen claude-4')
  assert.ok(toolSpan !== undefined)
  assert.ok(genSpan !== undefined)
  // trace context from PI_FLOW_TRACEPARENT (M1 stamp)
  assert.equal(toolSpan.traceId, '0123456789abcdef0123456789abcdef')
  assert.equal(toolSpan.parentSpanId, 'fedcba9876543210')
  assert.equal(genSpan.traceId, '0123456789abcdef0123456789abcdef')
  assert.deepEqual(toolSpan.status, {
    code: 2,
    message: 'bash failed',
  })
  const attrs = new Map(
    toolSpan.attributes.map(
      (a: { key: string; value: { stringValue: string } }) => [
        a.key,
        a.value.stringValue,
      ],
    ),
  )
  assert.equal(attrs.get('flow.ref'), 'PMR-A1')
  assert.equal(attrs.get('phase'), 'implement')
  assert.equal(attrs.get('gen_ai.tool.name'), 'bash')
  // metadata only: no prompt/completion content ever rides along
  assert.equal(attrs.get('prompt'), undefined)
})

test('export failure notes at most once, then drops silently', async () => {
  const w = await wired({ endpoint: 'https://t:8478' })
  w.respondStatus = 500
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  w.pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  w.pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: {},
    isError: false,
  })
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  assert.equal(w.failures.length, 1)
  // second failing session: still silent
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  w.pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: {},
  })
  w.pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't2',
    toolName: 'edit',
    result: {},
    isError: false,
  })
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  assert.equal(w.failures.length, 1)
})

test('config accepts a valid telemetry block and rejects a malformed one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'piflow-telemetry-'))
  try {
    const good = path.join(dir, 'good.json')
    writeFileSync(
      good,
      JSON.stringify({
        workRoots: [],
        telemetry: {
          enabled: true,
          otlpEndpoint: 'https://chicken.example:8478',
          headers: { 'x-static': 'yes' },
        },
      }),
    )
    const config = await readConfigFile(good)
    assert.equal(config.telemetry?.enabled, true)
    assert.equal(config.telemetry?.otlpEndpoint, 'https://chicken.example:8478')

    const bad = path.join(dir, 'bad.json')
    writeFileSync(
      bad,
      JSON.stringify({ workRoots: [], telemetry: { enabled: true } }),
    )
    await assert.rejects(() => readConfigFile(bad), /invalid: /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flow env stamped AFTER session_start is picked up, and cleared afterwards', async () => {
  const env: Record<string, string | undefined> = {}
  const w = await wired({ endpoint: 'https://t:4478' }, env)
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  const runTool = (id: string) => {
    w.pi.emit('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: 'bash',
      args: {},
    })
    w.pi.emit('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'bash',
      result: {},
      isError: false,
    })
  }

  // flow loop stamps the env after the session already started
  env.PI_FLOW_REF = 'PMR-LATE'
  env.PI_FLOW_PHASE = 'plan'
  env.PI_FLOW_TRACEPARENT =
    '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01'
  runTool('t1')
  // terminal transition clears the stamp
  delete env.PI_FLOW_REF
  delete env.PI_FLOW_PHASE
  delete env.PI_FLOW_TRACEPARENT
  runTool('t2')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  const all = JSON.parse(w.bodies[0]).resourceSpans[0].scopeSpans[0].spans
  const spans = all.filter((s: { name: string }) => s.name === 'tool bash')
  assert.equal(spans.length, 2)
  const refOf = (span: {
    attributes: Array<{ key: string; value: { stringValue: string } }>
  }) => span.attributes.find((a) => a.key === 'flow.ref')?.value.stringValue
  assert.equal(refOf(spans[0]), 'PMR-LATE')
  assert.equal(spans[0].traceId, '0123456789abcdef0123456789abcdef')
  assert.equal(refOf(spans[1]), undefined)
  assert.notEqual(spans[1].traceId, '0123456789abcdef0123456789abcdef')
})

test('main process exports the flow root span once; workers do not', async () => {
  const stamp = {
    PI_FLOW_REF: 'PMR-ROOT',
    PI_FLOW_PHASE: 'implement',
    PI_FLOW_TRACEPARENT:
      '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
  }
  const run = async (env: Record<string, string | undefined>) => {
    const w = await wired({ endpoint: 'https://t:4478' }, env)
    w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
    await tick()
    for (const id of ['a', 'b']) {
      w.pi.emit('tool_execution_start', {
        type: 'tool_execution_start',
        toolCallId: id,
        toolName: 'bash',
        args: {},
      })
      w.pi.emit('tool_execution_end', {
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: 'bash',
        result: {},
        isError: false,
      })
    }
    w.pi.emit('session_shutdown', { type: 'session_shutdown' })
    await tick()
    return JSON.parse(w.bodies[0]).resourceSpans[0].scopeSpans[0]
      .spans as Array<{
      name: string
      spanId: string
      parentSpanId?: string
    }>
  }

  const main = await run({ ...stamp })
  const roots = main.filter((s) => s.name === 'flow PMR-ROOT')
  assert.equal(roots.length, 1)
  assert.equal(roots[0].spanId, 'fedcba9876543210')
  assert.equal(roots[0].parentSpanId, undefined)
  const tools = main.filter((s) => s.name === 'tool bash')
  assert.equal(tools.length, 2)
  assert.ok(tools.every((s) => s.parentSpanId === 'fedcba9876543210'))

  const worker = await run({ ...stamp, PI_SUBAGENT_NAME: 'worker' })
  assert.equal(worker.filter((s) => s.name.startsWith('flow')).length, 0)
})

test('worker exports one session span under the flow root; tool/gen spans nest under it', async () => {
  const w = await wired(
    { endpoint: 'https://t:4478' },
    {
      PI_FLOW_REF: 'PMR-TREE',
      PI_FLOW_PHASE: 'implement',
      PI_SUBAGENT_NAME: 'worker',
      PI_FLOW_TRACEPARENT:
        '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
    },
  )
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  w.pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
  })
  w.pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: {},
    isError: false,
  })
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  const spans = JSON.parse(w.bodies[0]).resourceSpans[0].scopeSpans[0]
    .spans as Array<{ name: string; spanId: string; parentSpanId?: string }>
  const session = spans.find((s) => s.name === 'PMR-TREE - worker')
  assert.ok(session !== undefined)
  assert.equal(session.parentSpanId, 'fedcba9876543210')
  const tool = spans.find((s) => s.name === 'tool bash')
  assert.ok(tool !== undefined)
  assert.equal(tool.parentSpanId, session.spanId)
  assert.equal(spans.filter((s) => s.name.startsWith('flow')).length, 0)
})

test('crashed worker (no session_shutdown) still exported its session span with the first flush', async () => {
  const w = await wired(
    { endpoint: 'https://t:4478' },
    {
      PI_FLOW_REF: 'PMR-CRASH',
      PI_FLOW_PHASE: 'implement',
      PI_SUBAGENT_NAME: 'worker',
      PI_FLOW_TRACEPARENT:
        '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
    },
  )
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  // enough tool spans to hit the flush threshold; shutdown never fires
  for (let i = 0; i < 20; i++) {
    w.pi.emit('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: `t${i}`,
      toolName: 'bash',
      args: {},
    })
    w.pi.emit('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: `t${i}`,
      toolName: 'bash',
      result: {},
      isError: false,
    })
  }
  await tick()

  assert.ok(w.bodies.length >= 1)
  const spans = JSON.parse(w.bodies[0]).resourceSpans[0].scopeSpans[0]
    .spans as Array<{ name: string; spanId: string; parentSpanId?: string }>
  const session = spans.find((s) => s.name === 'PMR-CRASH - worker')
  assert.ok(session !== undefined)
  const tool = spans.find((s) => s.name === 'tool bash')
  assert.equal(tool?.parentSpanId, session.spanId)
})

test('sessionSpanName: "<ref> - <role>" from the agent name before the colon', () => {
  assert.equal(
    sessionSpanName({
      'flow.ref': 'PMR-1',
      'agent.name': "Review: changes against 'f2512623e9c4'",
    }),
    'PMR-1 - review',
  )
  assert.equal(
    sessionSpanName({
      'flow.ref': 'PMR-1',
      'agent.name': 'Deviation check: PMR-1',
    }),
    'PMR-1 - deviation check',
  )
  assert.equal(sessionSpanName({ 'flow.ref': 'PMR-1' }), 'PMR-1 - worker')
  assert.equal(sessionSpanName({ 'agent.name': 'Scout' }), 'scout')
})
