// AIDEV-NOTE: PMR-DRKH — worktree bind self-heal seam tests. Covers the
// bindFlow null-ref branch deriving candidates via deps.deriveFlowRefs:
// single candidate → adopt + bind; multiple → refusal listing /flow <ref>
// per candidate; seam absent (or empty) → the unchanged refusal text.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
} from '../flow/worktree-context.ts'
import worktreeExtension from '../worktree/index.ts'
import { mkTmpDir } from './tmpdir.ts'

type BindExecute = (
  id: string,
  params: {
    action: string
    path?: string
    branch?: string
  },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: { cwd: string },
) => Promise<{ content: { type: string; text: string }[] }>

function makeWorktreeTool(
  herdrWorktrees: { path: string; branch: string }[] = [],
  opts?: {
    deps?: { effects?: unknown; deriveFlowRefs?: () => Promise<string[]> }
  },
): BindExecute {
  const tools: { name: string; execute: BindExecute }[] = []
  const mockPi = {
    exec: async () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({
        result: {
          worktrees: herdrWorktrees.map((w) => ({
            ...w,
            is_linked: true,
          })),
        },
      }),
    }),
    registerTool: (options: unknown) => {
      tools.push(options as { name: string; execute: BindExecute })
    },
  } as unknown as ExtensionAPI
  const ext = worktreeExtension as unknown as (
    pi: ExtensionAPI,
    deps?: unknown,
  ) => void
  ext(mockPi, opts?.deps)
  const tool = tools.find((t) => t.name === 'worktree')
  assert.ok(tool, 'worktree tool registered')
  return tool.execute
}

// Module-global flow state: reset after every test so a failure cannot leak.
afterEach(() => {
  setActiveFlowRef(null)
})

const bindCtx = { cwd: '/tmp/main-checkout' }

test('bind heal: single candidate is adopted and bound', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: async () => ['PMR-HEAL1'],
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-1',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.match(text, /Bound worktree/)
  assert.match(text, /PMR-HEAL1/)
  assert.match(text, /adopt/i)
  assert.equal(getActiveFlowRef(), 'PMR-HEAL1')
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-HEAL1',
    path: dir,
    branch: 'fix/x',
  })
})

test('bind heal: multiple candidates refuse with per-ref /flow commands', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: async () => ['PMR-HEALA', 'PMR-HEALB'],
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-2',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.match(text, /No active flow ref/)
  assert.match(text, /\/flow PMR-HEALA/)
  assert.match(text, /\/flow PMR-HEALB/)
  assert.equal(getActiveFlowRef(), null, 'no adoption on ambiguity')
  assert.equal(getFlowWorktree(), null)
})

test('bind heal: absent seam falls back to the unchanged refusal', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }])
  setActiveFlowRef(null)
  const result = await execute(
    'heal-3',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.ok(text.startsWith('No active flow ref'), text)
  assert.equal(getActiveFlowRef(), null)
  assert.equal(getFlowWorktree(), null)
})

test('bind heal: empty candidate list falls back to the unchanged refusal', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: async () => [],
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-4',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.ok(text.startsWith('No active flow ref'), text)
  assert.equal(getActiveFlowRef(), null)
  assert.equal(getFlowWorktree(), null)
})
