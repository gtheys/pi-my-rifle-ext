import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isMuxAvailable } from '@gtheys/pi-interactive-subagents'
import reviewExtension, { buildFullReviewPrompt } from './review.ts'

type CapturedCommand = { name: string; options: unknown }

type CapturedTool = {
  name: string
  options: {
    execute: (
      toolCallId: string,
      params: { target: { type: string; [k: string]: unknown } },
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => Promise<{
      content: { type: string; text: string }[]
      isError?: boolean
      details?: unknown
    }>
  }
}

function makeMockPi() {
  const commands: CapturedCommand[] = []
  const tools: CapturedTool[] = []
  const mockPi = {
    registerCommand: (name: string, options: unknown) => {
      commands.push({ name, options })
    },
    registerTool: (options: unknown) => {
      tools.push(options as CapturedTool)
    },
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    exec: async () => ({
      code: 1,
      stdout: '',
      stderr: '',
      killed: false,
      signal: null,
    }),
    on: () => () => {},
    appendEntry: async () => {},
    getActiveTools: () => [],
  } as unknown as ExtensionAPI
  return { commands, tools, mockPi }
}

test('registers the review tool and the human commands', () => {
  const { commands, tools, mockPi } = makeMockPi()
  reviewExtension(mockPi)

  const toolNames = tools.map((t) => t.name)
  assert.ok(toolNames.includes('review'), 'review tool registered')

  const commandNames = commands.map((c) => c.name)
  assert.ok(commandNames.includes('review'), '/review command registered')
  assert.ok(
    commandNames.includes('end-review'),
    '/end-review command registered',
  )
})

test('tool execute returns a clean error without a mux', async () => {
  if (isMuxAvailable()) {
    // A herdr mux is running in this environment — the no-mux path is not
    // reachable headless. Skip rather than spawn real subagents from a test.
    return
  }
  const { tools, mockPi } = makeMockPi()
  reviewExtension(mockPi)

  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')

  const notifications: string[] = []
  const result = await tool.options.execute(
    'call-1',
    { target: { type: 'uncommitted' } },
    new AbortController().signal,
    undefined,
    {
      cwd: os.tmpdir(),
      hasUI: false,
      mode: 'tui',
      ui: { notify: (msg: string) => notifications.push(msg) },
      sessionManager: {},
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /mux/)
})

test('buildFullReviewPrompt composes rubric + target prompt + guidelines', async () => {
  const { mockPi } = makeMockPi()

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-prompt-'))
  await fs.mkdir(path.join(tmp, '.pi'), { recursive: true })
  await fs.writeFile(
    path.join(tmp, 'REVIEW_GUIDELINES.md'),
    'Always check for SQL injection in the auth module.',
    'utf8',
  )

  try {
    const prompt = await buildFullReviewPrompt(
      mockPi,
      { type: 'uncommitted' },
      tmp,
    )
    assert.match(prompt, /# Review Guidelines/)
    assert.match(
      prompt,
      /Review the current code changes \(staged, unstaged, and untracked files\)/,
    )
    assert.match(prompt, /Always check for SQL injection in the auth module\./)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
