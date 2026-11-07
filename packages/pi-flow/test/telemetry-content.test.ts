import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readConfigFile } from '../config.ts'
import {
  type ContentLevel,
  DEFAULT_MAX_CONTENT_CHARS,
  extractAssistantContent,
  generationContentAttributes,
  levelIncludes,
  toolInputText,
  toolOutputText,
  truncate,
} from '../telemetry/content.ts'
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
    for (const handler of this.handlers.get(event) ?? []) {
      void handler((payload ?? {}) as never, { cwd: '/repo' })
    }
  }
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const MESSAGE = {
  role: 'assistant',
  model: 'claude-4',
  usage: { input: 10, output: 5 },
  content: [
    { type: 'thinking', thinking: 'plan: run ls first' },
    { type: 'text', text: 'Listing the directory.' },
    { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
  ],
}

test('levelIncludes is cumulative', () => {
  assert.equal(levelIncludes('off', 'text'), false)
  assert.equal(levelIncludes('text', 'text'), true)
  assert.equal(levelIncludes('text', 'tools'), false)
  assert.equal(levelIncludes('tools', 'text'), true)
  assert.equal(levelIncludes('all', 'tools'), true)
})

test('truncate keeps short text and marks long text with the dropped count', () => {
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(truncate('abcdef', 4), 'abcd…[truncated 2 chars]')
})

test('extractAssistantContent reads text, thinking, tool calls; skips redacted thinking', () => {
  const c = extractAssistantContent(MESSAGE)
  assert.equal(c.text, 'Listing the directory.')
  assert.equal(c.reasoning, 'plan: run ls first')
  assert.deepEqual(c.toolCalls, [
    { name: 'bash', arguments: { command: 'ls' } },
  ])
  const redacted = extractAssistantContent({
    content: [{ type: 'thinking', thinking: 'secret', redacted: true }],
  })
  assert.equal(redacted.reasoning, '')
  assert.equal(extractAssistantContent(null).text, '')
  assert.equal(extractAssistantContent({ content: 'plain' }).text, 'plain')
})

test('generationContentAttributes: each level adds exactly its layer', () => {
  const at = (level: ContentLevel) =>
    Object.keys(generationContentAttributes(level, 2000, MESSAGE)).sort()
  assert.deepEqual(at('off'), [])
  assert.deepEqual(at('text'), ['gen_ai.completion'])
  assert.deepEqual(at('tools'), ['gen_ai.completion', 'gen_ai.tool_calls'])
  assert.deepEqual(at('all'), [
    'gen_ai.completion',
    'gen_ai.reasoning',
    'gen_ai.tool_calls',
  ])
})

test('tool input/output text: JSON args, text-part results, JSON fallback, truncation', () => {
  assert.equal(toolInputText({ command: 'ls' }, 100), '{"command":"ls"}')
  assert.equal(toolInputText(undefined, 100), '')
  assert.equal(
    toolOutputText({ content: [{ type: 'text', text: 'a.txt' }] }, 100),
    'a.txt',
  )
  assert.equal(toolOutputText('plain', 100), 'plain')
  assert.equal(toolOutputText({ ok: true }, 100), '{"ok":true}')
  assert.match(toolOutputText('x'.repeat(50), 10), /truncated 40 chars/)
})

type SpanOut = {
  name: string
  attributes: Array<{ key: string; value: { stringValue: string } }>
}

async function runAt(
  level: ContentLevel | undefined,
  maxContentChars?: number,
): Promise<Map<string, Map<string, string>>> {
  const pi = new FakePi()
  const bodies: string[] = []
  registerTelemetry(pi as unknown as ExtensionAPI, {
    loadSettings: async () => ({
      endpoint: 'https://t:4478',
      headers: {},
      captureContent: level,
      maxContentChars,
    }),
    env: {},
    rng: { bytes: (n: number) => new Uint8Array(n).fill(7) },
    fetchImpl: (async (_u: string, init: { body: string }) => {
      bodies.push(init.body)
      return { status: 200 }
    }) as never,
    now: () => 1_700_000_000_000,
    onExportFailure: () => {},
  })
  pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'bash',
    args: { command: 'ls' },
  })
  pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'a.txt b.txt' }] },
    isError: false,
  })
  pi.emit('turn_end', {
    type: 'turn_end',
    turnIndex: 0,
    message: MESSAGE,
    toolResults: [],
  })
  pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  const spans = JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0]
    .spans as SpanOut[]
  const out = new Map<string, Map<string, string>>()
  for (const span of spans) {
    out.set(
      span.name,
      new Map(span.attributes.map((a) => [a.key, a.value.stringValue])),
    )
  }
  return out
}

test('wired: default (no captureContent) and "off" export metadata only', async () => {
  for (const level of [undefined, 'off' as const]) {
    const spans = await runAt(level)
    const tool = spans.get('tool bash')
    const gen = spans.get('gen claude-4')
    assert.ok(tool !== undefined && gen !== undefined)
    assert.equal(tool.has('tool.input'), false)
    assert.equal(tool.has('tool.output'), false)
    assert.equal(gen.has('gen_ai.completion'), false)
    assert.equal(gen.has('gen_ai.tool_calls'), false)
    assert.equal(gen.has('gen_ai.reasoning'), false)
  }
})

test('wired: text level adds only assistant text', async () => {
  const spans = await runAt('text')
  const gen = spans.get('gen claude-4')
  const tool = spans.get('tool bash')
  assert.ok(gen !== undefined && tool !== undefined)
  assert.equal(gen.get('gen_ai.completion'), 'Listing the directory.')
  assert.equal(gen.has('gen_ai.tool_calls'), false)
  assert.equal(gen.has('gen_ai.reasoning'), false)
  assert.equal(tool.has('tool.input'), false)
})

test('wired: tools level adds tool calls and tool input/output', async () => {
  const spans = await runAt('tools')
  const gen = spans.get('gen claude-4')
  const tool = spans.get('tool bash')
  assert.ok(gen !== undefined && tool !== undefined)
  assert.equal(gen.get('gen_ai.completion'), 'Listing the directory.')
  assert.equal(
    gen.get('gen_ai.tool_calls'),
    '[{"name":"bash","arguments":{"command":"ls"}}]',
  )
  assert.equal(gen.has('gen_ai.reasoning'), false)
  assert.equal(tool.get('tool.input'), '{"command":"ls"}')
  assert.equal(tool.get('tool.output'), 'a.txt b.txt')
})

test('wired: all level also adds reasoning; maxContentChars truncates', async () => {
  const spans = await runAt('all', 100)
  assert.equal(
    spans.get('gen claude-4')?.get('gen_ai.reasoning'),
    'plan: run ls first',
  )
  const cut = await runAt('text', 7)
  assert.equal(
    cut.get('gen claude-4')?.get('gen_ai.completion'),
    'Listing…[truncated 15 chars]',
  )
})

test('default cap stays under Tempo 2048-byte attribute limit', () => {
  assert.ok(DEFAULT_MAX_CONTENT_CHARS < 2048)
})

test('config: captureContent/maxContentChars accepted, bad values rejected', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-cc-'))
  try {
    const good = path.join(dir, 'good.json')
    writeFileSync(
      good,
      JSON.stringify({
        workRoots: [],
        telemetry: {
          enabled: true,
          otlpEndpoint: 'https://t:4478',
          captureContent: 'tools',
          maxContentChars: 1500,
        },
      }),
    )
    const cfg = await readConfigFile(good)
    assert.equal(cfg.telemetry?.captureContent, 'tools')
    assert.equal(cfg.telemetry?.maxContentChars, 1500)

    const bad = path.join(dir, 'bad.json')
    writeFileSync(
      bad,
      JSON.stringify({
        workRoots: [],
        telemetry: {
          enabled: true,
          otlpEndpoint: 'https://t:4478',
          captureContent: 'everything',
        },
      }),
    )
    await assert.rejects(readConfigFile(bad))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
