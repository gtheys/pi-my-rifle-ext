// AIDEV-NOTE: PMR-DRKH — worktree bind self-heal seam tests. Covers the
// bindFlow null-ref branch deriving candidates via deps.deriveFlowRefs:
// single candidate → adopt + bind; multiple → refusal listing /flow <ref>
// per candidate; seam absent (or empty) → the unchanged refusal text.
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { type DurableRefDeps, deriveFlowRefs } from '../flow/durable-refs.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
} from '../flow/worktree-context.ts'
import { readRunEvents } from '../run-state.ts'
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

test('bind heal: a refused bind after adoption leaves the active ref unchanged', async () => {
  // PMR-NN5A regression: adoption is applied only after target and branch
  // verification — a branch-mismatch refusal must NOT leak an orphaned
  // active ref.
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/actual' }], {
    deps: {
      deriveFlowRefs: async () => ['PMR-HEAL9'],
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-5',
    { action: 'bind', path: dir, branch: 'fix/claimed' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.match(text, /on branch fix\/actual, not fix\/claimed/)
  assert.equal(getActiveFlowRef(), null, 'no adoption on a refused bind')
  assert.equal(getFlowWorktree(), null)
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

// AIDEV-NOTE: PMR-RRW9 — end-to-end bind regression for the owner-scoped
// adoption filter: the seam below is the REAL deriveFlowRefs over a fake
// pending record owned by a LIVE foreign session (the PMR-B033 incident
// shape), not a mocked empty list — so the zero-survivor refusal is reached
// through the new filtering, and nothing is adopted.
function foreignLiveOwnerDeps(): DurableRefDeps {
  const events = [
    {
      kind: 'run-start',
      at: '2026-11-28T00:00:00Z',
      ref: 'PMR-R77R',
      mode: 'work',
    },
    {
      kind: 'run-input',
      at: '2026-11-28T00:01:00Z',
      ref: 'PMR-R77R',
      input: { mode: 'work', gitRoot: '/repo', workRoots: [] },
    },
    {
      kind: 'phase-start',
      at: '2026-11-28T00:02:00Z',
      ref: 'PMR-R77R',
      phase: 'validate',
    },
    {
      kind: 'loop-state',
      at: '2026-11-28T00:03:00Z',
      ref: 'PMR-R77R',
      loop: {
        phase: 'validate',
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: '2026-11-28T00:00:00Z',
        status: 'running',
      },
    },
    {
      kind: 'owner-session',
      at: '2026-11-28T00:04:00Z',
      ref: 'PMR-R77R',
      sessionFile: '/agent/sessions/other.jsonl',
      pid: 4242,
    },
  ]
  return {
    pendingDir: '/agent/pi-flow/pending',
    agentDir: '/agent',
    gitRoot: '/repo',
    callerSessionFile: '/agent/sessions/main.jsonl',
    pidAlive: () => true,
    io: {
      readdir: async () => ['PMR-R77R.json'],
      readFile: async (p) => {
        if (!p.endsWith('/PMR-R77R.journal.jsonl')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
      },
    },
    readRunEvents,
  }
}

test('bind heal: a foreign live-owner record is not adopted; refusal is the zero-candidate one', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: () => deriveFlowRefs(foreignLiveOwnerDeps()),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-6',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.ok(text.startsWith('No active flow ref'), text)
  assert.ok(!text.includes('PMR-R77R'), text)
  assert.equal(getActiveFlowRef(), null, 'foreign live flow never adopted')
  assert.equal(getFlowWorktree(), null)
})
