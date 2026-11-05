// AIDEV-NOTE: PMR-44XX — spec_publish tool wiring tests. Covers tool
// registration via registerSpecCommands and the result mapping (only the
// worker's PUBLISH OK marker is a success; everything else is a loud tool
// error). No real worker, git, or aven side effects: the exec mock rejects
// so the shared runSpecPublish path exits at the git-repo check.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  registerSpecCommands,
  type SpecPublishOutcome,
  specPublishToolResult,
} from '../spec-review/commands.ts'
import { buildSpawnFailureText } from '../spec-review/publish.ts'

type CapturedCommand = { name: string; options: unknown }

type ToolResultShape = {
  content: { type: string; text: string }[]
  isError?: boolean
  details?: { ok: boolean; reason: string }
}

type CapturedTool = {
  name: string
  execute: (
    toolCallId: string,
    params: { ref: string; workspace?: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Record<string, unknown>,
  ) => Promise<ToolResultShape>
}

function makeMockPi(execImpl?: () => Promise<never>) {
  const commands: CapturedCommand[] = []
  const tools: CapturedTool[] = []
  const mockPi = {
    registerCommand: (name: string, options: unknown) => {
      commands.push({ name, options })
    },
    registerTool: (options: unknown) => {
      tools.push(options as CapturedTool)
    },
    sendUserMessage: async () => {},
    exec:
      execImpl ??
      (async () => {
        throw new Error('no git here')
      }),
    on: () => () => {},
  } as unknown as ExtensionAPI
  return { commands, tools, mockPi }
}

test('registerSpecCommands registers the spec_publish tool and keeps /spec-publish', () => {
  const { commands, tools, mockPi } = makeMockPi()
  registerSpecCommands(mockPi)

  const toolNames = tools.map((t) => t.name)
  assert.ok(toolNames.includes('spec_publish'), 'spec_publish tool registered')

  const commandNames = commands.map((c) => c.name)
  assert.ok(
    commandNames.includes('spec-publish'),
    '/spec-publish command still registered',
  )

  const specPublish = tools.find((t) => t.name === 'spec_publish')
  assert.ok(specPublish !== undefined)
  assert.equal(typeof specPublish.execute, 'function')
})

test('specPublishToolResult: PUBLISH OK outcome maps to a success result', () => {
  const outcome: SpecPublishOutcome = {
    ok: true,
    text: 'step ok\nstep ok\nPUBLISH OK',
  }
  const result = specPublishToolResult(outcome)
  assert.equal(result.isError, undefined)
  assert.match(
    (result.content[0] as { type: string; text: string }).text,
    /PUBLISH OK/,
  )
  assert.deepEqual(result.details, { ok: true, reason: '' })
})

test('specPublishToolResult: outcome without the marker maps to a loud error', () => {
  const outcome: SpecPublishOutcome = {
    ok: false,
    text: 'worker exited with code 0 but no PUBLISH OK marker',
  }
  const result = specPublishToolResult(outcome)
  assert.equal(result.isError, true)
  assert.match(
    (result.content[0] as { type: string; text: string }).text,
    /worker exited/,
  )
  assert.equal(result.details.ok, false)
  assert.equal(
    result.details.reason,
    'worker exited with code 0 but no PUBLISH OK marker',
  )
})

test('specPublishToolResult: validation failure keeps the full detail', () => {
  const result = specPublishToolResult({
    ok: false,
    text: 'PMR-AB12 has no plan-path metadata',
  })
  assert.equal(result.isError, true)
  assert.match(
    (result.content[0] as { type: string; text: string }).text,
    /no plan-path metadata/,
  )
})

test('spec_publish execute surfaces git-repo failure as a tool error', async () => {
  const { tools, mockPi } = makeMockPi(async () => {
    throw new Error('fatal: not a git repository')
  })
  registerSpecCommands(mockPi)
  const specPublish = tools.find((t) => t.name === 'spec_publish')
  assert.ok(specPublish !== undefined)
  const result = await specPublish.execute(
    'call-1',
    { ref: 'PMR-TEST' },
    undefined,
    undefined,
    {},
  )
  assert.equal(result.isError, true)
  assert.match(
    (result.content[0] as { type: string; text: string }).text,
    /spec_publish/,
  )
  assert.match(
    (result.content[0] as { type: string; text: string }).text,
    /not a git repository/,
  )
})

const SPAWN_INPUT = {
  task: 't',
  name: 'n',
  cwd: '/c',
  ref: 'PMR-AB12',
  repo: 'r',
  root: '/root',
  planFile: '/root/r/plan.md',
}

test('buildSpawnFailureText: tool caller is told not to run the git block', () => {
  const text = buildSpawnFailureText(
    { ...SPAWN_INPUT, prefix: 'spec_publish' },
    'no mux',
  )
  assert.match(text, /^spec_publish: could not spawn publish worker \(no mux\)/)
  assert.match(text, /Ask the user to publish manually/)
  assert.doesNotMatch(text, /\/spec-publish/)
})

test('buildSpawnFailureText: command text is unchanged', () => {
  const text = buildSpawnFailureText(SPAWN_INPUT, 'no mux')
  assert.match(text, /^\/spec-publish: could not spawn/)
  assert.match(text, /\nPublish manually:\n/)
})
