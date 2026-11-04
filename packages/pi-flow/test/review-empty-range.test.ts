import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import reviewExtension, { isEmptyBranchRange } from '../review/review.ts'

type ExecResult = {
  code: number
  stdout: string
  stderr: string
  killed: boolean
  signal: null
}

function execResult(code: number, stdout: string): ExecResult {
  return { code, stdout, stderr: '', killed: false, signal: null }
}

// AIDEV-NOTE: scripted git mock — answers keyed on the argv tail so tests
// never touch a real repo. mergeBase/head control the guard outcome.
function makeGitMockPi(script: { mergeBase?: string; head?: string }) {
  const tools: {
    name: string
    execute: (
      toolCallId: string,
      params: { target: { type: string; branch?: string } },
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => Promise<{
      content: { type: string; text: string }[]
      isError?: boolean
      details?: unknown
    }>
  }[] = []
  const mockPi = {
    registerCommand: () => {},
    registerTool: (options: unknown) => {
      tools.push(options as (typeof tools)[number])
    },
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    exec: async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return execResult(1, '') // no upstream — force the branch fallback
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        if (script.head === undefined) return execResult(1, '')
        return execResult(0, `${script.head}\n`)
      }
      if (args[0] === 'merge-base') {
        if (script.mergeBase === undefined) return execResult(1, '')
        return execResult(0, `${script.mergeBase}\n`)
      }
      return execResult(1, '')
    },
    on: () => () => {},
    appendEntry: async () => {},
    getActiveTools: () => [],
  } as unknown as ExtensionAPI
  return { tools, mockPi }
}

test('isEmptyBranchRange: merge base == HEAD is an empty range', async () => {
  const { mockPi } = makeGitMockPi({ mergeBase: 'abc123', head: 'abc123' })
  assert.equal(await isEmptyBranchRange(mockPi, 'main', '/tmp/x'), true)
})

test('isEmptyBranchRange: distinct head is a non-empty range', async () => {
  const { mockPi } = makeGitMockPi({ mergeBase: 'abc123', head: 'def456' })
  assert.equal(await isEmptyBranchRange(mockPi, 'main', '/tmp/x'), false)
})

test('isEmptyBranchRange: unresolvable merge base stays unguarded', async () => {
  const { mockPi } = makeGitMockPi({})
  assert.equal(await isEmptyBranchRange(mockPi, 'main', '/tmp/x'), false)
})

test('review tool: branch target with an empty resolved range fails loudly', async () => {
  const { tools, mockPi } = makeGitMockPi({
    mergeBase: 'abc123',
    head: 'abc123',
  })
  reviewExtension(mockPi)
  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')

  const result = await tool.execute(
    'call-1',
    { target: { type: 'branch', branch: 'main' } },
    new AbortController().signal,
    undefined,
    {
      cwd: '/tmp/main-checkout',
      hasUI: false,
      mode: 'tui',
      ui: { notify: () => {} },
      sessionManager: {},
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0]?.text ?? '', /empty/i)
  assert.match(result.content[0]?.text ?? '', /main/)
})

test('review tool: branch target with a non-empty range proceeds past the guard', async () => {
  const { isMuxAvailable } = await import('@gtheys/pi-interactive-subagents')
  if (isMuxAvailable()) {
    // A herdr mux is running — past the guard the tool would spawn real
    // subagents. Skip rather than spawn from a test.
    return
  }
  const { tools, mockPi } = makeGitMockPi({
    mergeBase: 'abc123',
    head: 'def456',
  })
  reviewExtension(mockPi)
  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')

  const result = await tool.execute(
    'call-1',
    { target: { type: 'branch', branch: 'main' } },
    new AbortController().signal,
    undefined,
    {
      cwd: '/tmp/main-checkout',
      hasUI: false,
      mode: 'tui',
      ui: { notify: () => {} },
      sessionManager: {},
    },
  )

  // Guard passed — the outcome is now mux-dependent (spawn or mux error),
  // but never the empty-range error.
  assert.doesNotMatch(result.content[0]?.text ?? '', /empty/i)
})

test('flow worktree context: binds only while a flow ref is active', async () => {
  setActiveFlowRef(null)
  setFlowWorktree('/tmp/wt', 'fix/x')
  assert.equal(getFlowWorktree(), null, 'no active ref — no binding')

  setActiveFlowRef('PMR-TEST')
  setFlowWorktree('/tmp/wt', 'fix/x')
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-TEST',
    path: '/tmp/wt',
    branch: 'fix/x',
  })

  setActiveFlowRef(null)
  assert.equal(getFlowWorktree(), null, 'clearing the ref clears the binding')
})
