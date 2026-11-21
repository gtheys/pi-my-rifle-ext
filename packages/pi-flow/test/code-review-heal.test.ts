// AIDEV-NOTE: PMR-DRKH — heal-first wiring tests for code_review and
// deviation_review (subtask 2.1). The module binding dies on a pi reload
// (PMR-PJM0); the tools must re-arm it transparently via healFlowBinding
// (resolveReviewWorktree underneath) and keep the existing refusal prefixes
// byte-for-byte, appending only the /flow recovery line.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  clearFlowWorktree,
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
} from '../flow/worktree-context.ts'
import { registerCodeReviewTool } from '../tools/code-review.ts'
import type { ReviewDeps } from '../tools/code-review-parse.ts'
import {
  type DeviationReviewToolParams,
  registerDeviationReviewTool,
  resolveDeviationCwd,
} from '../tools/deviation.ts'

// productionReviewDeps wires exists to real existsSync, so the herdr fixture
// must point at a real temp dir (same pattern as test/code-review.test.ts).
const HEAL_WT_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-heal-wt-'))

const AVEN_FAKE_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-heal-bin-'))
writeFileSync(path.join(AVEN_FAKE_DIR, 'aven'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(AVEN_FAKE_DIR, 'aven'), 0o755)

async function withFakeAvenPath(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${AVEN_FAKE_DIR}:${previousPath}`
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
  }
}

function resetBinding(): void {
  setActiveFlowRef(null)
  clearFlowWorktree()
}

type MockExec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>

function herdrFixtureExec(branch: string): MockExec {
  return async (cmd, args) => {
    if (cmd === 'aven') {
      return {
        code: 0,
        stdout: `PMR-HEAL1 status=todo title="heal gate"\n`,
        stderr: '',
      }
    }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            worktrees: [
              {
                branch,
                path: HEAL_WT_DIR,
                label: 'heal',
                open_workspace_id: 'w1',
                is_linked_worktree: true,
              },
            ],
          },
        }),
        stderr: '',
      }
    }
    if (cmd === 'git' && args.includes('--git-common-dir')) {
      return { code: 0, stdout: '/repo/.git\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('--abbrev-ref')) {
      return { code: 0, stdout: `${branch}\n`, stderr: '' }
    }
    if (cmd === 'git' && args.includes('merge-base')) {
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    if (cmd === 'herdr' && args[0] === 'tab') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }),
        stderr: '',
      }
    }
    if (cmd === 'tuicr' && args[1] === 'list') {
      return { code: 0, stdout: '[]', stderr: '' }
    }
    if (cmd === 'tuicr' && args[1] === 'comments') {
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

type CodeReviewExecute = (
  toolCallId: string,
  params: { ref: string },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: {
    cwd: string
    tools: Array<{ name: string }>
    ui: { notify: (m: string, l: string) => void }
    executeTool: (
      name: string,
      args: unknown,
    ) => Promise<{ result: { content: Array<{ type: string; text: string }> } }>
  },
) => Promise<{
  isError?: boolean
  content: Array<{ type: string; text: string }>
}>

function codeReviewExecute(exec: MockExec): { execute: CodeReviewExecute } {
  let execute: CodeReviewExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: CodeReviewExecute }) => {
      execute = options.execute
    },
    exec,
  }
  const landingState = { authorized: null, humanReviewPassed: null }
  registerCodeReviewTool(
    mockPi as unknown as Parameters<typeof registerCodeReviewTool>[0],
    landingState,
  )
  if (!execute) throw new Error('code_review tool not registered')
  return { execute }
}

type ToolCtx = Parameters<CodeReviewExecute>[4]

function askPassCtx(): ToolCtx {
  return {
    cwd: '/repo',
    tools: [{ name: 'ask_user_question' }],
    ui: { notify: () => {} },
    executeTool: async () => ({
      result: {
        content: [{ type: 'text', text: 'User selected: pass (Recommended)' }],
      },
    }),
  }
}

test('code_review: lost module binding is healed via herdr fixture and tool succeeds', async () => {
  await withFakeAvenPath(async () => {
    resetBinding()
    assert.equal(getActiveFlowRef(), null)
    assert.equal(getFlowWorktree(), null)
    const { execute } = codeReviewExecute(herdrFixtureExec('feat/heal-gate'))
    const result = await execute(
      't1',
      { ref: 'PMR-HEAL1' },
      new AbortController().signal,
      undefined,
      askPassCtx(),
    )
    assert.notEqual(result.isError, true)
    // AIDEV-NOTE: PMR-DRKH — the heal must have re-armed the module binding
    // as a side effect of the resolve, not just returned a worktree.
    assert.deepEqual(getFlowWorktree(), {
      ref: 'PMR-HEAL1',
      path: HEAL_WT_DIR,
      branch: 'feat/heal-gate',
    })
    assert.equal(getActiveFlowRef(), 'PMR-HEAL1')
    resetBinding()
  })
})

test('code_review: unresolved worktree keeps the refusal prefix and appends the recovery line', async () => {
  const exec: MockExec = async (cmd, args) => {
    if (cmd === 'aven') {
      return { code: 0, stdout: 'PMR-HEAL4 status=todo\n', stderr: '' }
    }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { worktrees: [] } }),
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const { execute } = codeReviewExecute(exec)
  const result = await execute(
    't2',
    { ref: 'PMR-HEAL4' },
    new AbortController().signal,
    undefined,
    askPassCtx(),
  )
  assert.equal(result.isError, true)
  const text = result.content.map((c) => c.text).join('\n')
  assert.ok(text.startsWith('code_review refused: '))
  assert.match(text, /no worktree found for PMR-HEAL4/)
  assert.match(
    text,
    /Recovery: run \/flow PMR-HEAL4 to re-arm the flow binding, then re-call\./,
  )
})

test('resolveDeviationCwd: lost module binding is healed via aven-note fixture', async () => {
  resetBinding()
  assert.equal(getFlowWorktree(), null)
  const deps: ReviewDeps = {
    getFlowWorktree,
    avenShowFull: async () =>
      [
        'notes for PMR-HEAL2',
        '',
        'note id=n1 author=pi at=2026-01-01',
        'body<<EOF',
        'worktree: /repo/.worktrees/feat-heal',
        'branch: feat/heal',
        'EOF',
        '',
      ].join('\n'),
    herdrWorktreeList: async () => [],
    exec: async (_cmd, args) => {
      if (args.includes('--git-common-dir')) {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' }
      }
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: 'feat/heal\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: () => true,
    repoRoot: '/repo',
  }
  const resolution = await resolveDeviationCwd('PMR-HEAL2', deps)
  assert.equal(resolution.ok, true)
  if (resolution.ok) {
    assert.equal(resolution.cwd, '/repo/.worktrees/feat-heal')
  }
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-HEAL2',
    path: '/repo/.worktrees/feat-heal',
    branch: 'feat/heal',
  })
  resetBinding()
})

test('deviation_review: unresolved worktree keeps the refusal text and appends the recovery line', async () => {
  const tools: Array<{ name: string }> = []
  const mockPi = {
    registerTool: (options: unknown) => {
      tools.push(options as { name: string })
    },
    on: () => () => {},
    exec: async () => ({ code: 1, stdout: '', stderr: 'no exec in test' }),
  } as unknown as ExtensionAPI
  registerDeviationReviewTool(mockPi)
  const options = tools[0] as unknown as {
    execute: (
      id: string,
      params: DeviationReviewToolParams,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: { cwd: string },
    ) => Promise<{
      isError?: boolean
      content: { type: string; text?: string }[]
    }>
  }
  const result = await options.execute(
    't3',
    {
      mode: 'personal',
      ref: 'PMR-HEAL3',
      spec: 'The feature must persist user settings across restarts.',
      avenNotes: '',
    },
    new AbortController().signal,
    undefined,
    { cwd: '/session' },
  )
  assert.equal(result.isError, true)
  const text = result.content[0]?.text ?? ''
  assert.match(text, /cannot resolve the flow worktree/)
  assert.match(text, /checkout mismatch/)
  assert.match(text, /NEVER treat this as 0 deviations/)
  assert.match(
    text,
    /Recovery: run \/flow PMR-HEAL3 to re-arm the flow binding, then re-call\./,
  )
})
