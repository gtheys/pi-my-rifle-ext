// AIDEV-NOTE: PMR-DRKH — worktree bind self-heal seam tests. Covers the
// bindFlow null-ref branch deriving candidates via deps.deriveFlowRefs:
// single candidate → adopt + bind; multiple → refusal listing /flow <ref>
// per candidate; seam absent (or empty) → the unchanged refusal text.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  type DurableRefDeps,
  deriveFlowRefs,
  deriveFlowRefsDetailed,
  type FlowRefDerivation,
} from '../flow/durable-refs.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  NO_ACTIVE_FLOW_WARNING,
  setActiveFlowRef,
} from '../flow/worktree-context.ts'
import flowExtension from '../index.ts'
import { readRunEvents } from '../run-state.ts'
import { PENDING_SCHEMA } from '../server/pending.ts'
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
    deps?: {
      effects?: unknown
      deriveFlowRefs?: () => Promise<string[]>
      deriveFlowRefsDetailed?: () => Promise<FlowRefDerivation>
    }
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

// AIDEV-NOTE: PMR-3N9N — end-to-end bind seam for the self-owned headless
// exemption: the seam below is the REAL deriveFlowRefs over a fake pending
// record whose journaled owner is a LIVE headless run (sessionFile null).
// Same pid as the caller (a reload in the same process) must be adopted;
// a different live pid must hit the unchanged zero-candidate refusal.
function headlessOwnerDeps(
  ref: string,
  ownerPid: number,
  callerPid: number,
): DurableRefDeps {
  const events = [
    {
      kind: 'run-start',
      at: '2026-11-28T00:00:00Z',
      ref,
      mode: 'work',
    },
    {
      kind: 'run-input',
      at: '2026-11-28T00:01:00Z',
      ref,
      input: { mode: 'work', gitRoot: '/repo', workRoots: [] },
    },
    {
      kind: 'phase-start',
      at: '2026-11-28T00:02:00Z',
      ref,
      phase: 'validate',
    },
    {
      kind: 'loop-state',
      at: '2026-11-28T00:03:00Z',
      ref,
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
      ref,
      sessionFile: null,
      pid: ownerPid,
    },
  ]
  return {
    pendingDir: '/agent/pi-flow/pending',
    agentDir: '/agent',
    gitRoot: '/repo',
    callerSessionFile: null,
    callerPid,
    pidAlive: () => true,
    io: {
      readdir: async () => [`${ref}.json`],
      readFile: async (p) => {
        if (!p.endsWith(`/${ref}.journal.jsonl`)) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
      },
    },
    readRunEvents,
  }
}

test('bind heal: a live self-owned headless run (same pid, null sessionFile) is adopted', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: () =>
        deriveFlowRefs(headlessOwnerDeps('PMR-3N9A', 4242, 4242)),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-7',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.match(text, /Bound worktree/)
  assert.match(text, /PMR-3N9A/)
  assert.match(text, /adopt/i)
  assert.equal(getActiveFlowRef(), 'PMR-3N9A')
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-3N9A',
    path: dir,
    branch: 'fix/x',
  })
})

test('bind heal: a live headless run owned by a different pid stays refused', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefs: () =>
        deriveFlowRefs(headlessOwnerDeps('PMR-3N9B', 9999, 4242)),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-8',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.ok(text.startsWith('No active flow ref'), text)
  assert.ok(!text.includes('PMR-3N9B'), text)
  assert.equal(getActiveFlowRef(), null, 'foreign live flow never adopted')
  assert.equal(getFlowWorktree(), null)
})

// AIDEV-NOTE: PMR-YN61 — the owner filter can remove the ONLY candidate,
// leaving bind with zero survivors while a live foreign run exists. The
// refusal must then name each foreign-skipped ref and its `/flow <ref>`
// recovery command (without adopting anything), while a TRUE zero-candidate
// refusal stays byte-for-byte unchanged. Carried by the additive
// deriveFlowRefsDetailed seam; the legacy deriveFlowRefs string[] seam keeps
// the plain zero-candidate refusal (pinned by the PMR-RRW9 test above).
test('bind heal: foreign-live-only refusal names each skipped ref and its /flow command', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefsDetailed: () =>
        deriveFlowRefsDetailed(foreignLiveOwnerDeps()),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-9',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.ok(text.startsWith('No active flow ref'), text)
  assert.ok(text.includes('PMR-R77R'), text)
  assert.ok(text.includes('/flow PMR-R77R'), text)
  assert.ok(text.includes(NO_ACTIVE_FLOW_WARNING), text)
  assert.equal(getActiveFlowRef(), null, 'foreign live flow never adopted')
  assert.equal(getFlowWorktree(), null)
})

test('bind heal: true zero-candidate refusal via the detailed seam is byte-for-byte unchanged', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefsDetailed: async () => ({ refs: [], foreignSkipped: [] }),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-10',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.equal(
    text,
    `No active flow ref — nothing to bind to. ${NO_ACTIVE_FLOW_WARNING}`,
  )
  assert.equal(getActiveFlowRef(), null)
  assert.equal(getFlowWorktree(), null)
})

test('bind heal: detailed seam adopts the single survivor and never the foreign-skipped ref', async () => {
  const dir = mkTmpDir('wt-heal-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }], {
    deps: {
      deriveFlowRefsDetailed: async () => ({
        refs: ['PMR-HEAL1'],
        foreignSkipped: ['PMR-FOREIGN'],
      }),
    },
  })
  setActiveFlowRef(null)
  const result = await execute(
    'heal-11',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  const text = result.content[0]?.text ?? ''
  assert.match(text, /Bound worktree/)
  assert.match(text, /PMR-HEAL1/)
  assert.ok(!text.includes('PMR-FOREIGN'), text)
  assert.equal(getActiveFlowRef(), 'PMR-HEAL1')
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-HEAL1',
    path: dir,
    branch: 'fix/x',
  })
})

// AIDEV-NOTE: PMR-YN61 production-wiring regression — the tests above inject
// the detailed seam directly, which would stay green even if pi-flow/index.ts
// never wired it. This test drives the REAL extension factory (flowExtension)
// against a temp PI_CODING_AGENT_DIR seeded with a genuine pending record +
// journal owned by a LIVE foreign session (pid = this process, foreign
// sessionFile), then invokes the 'worktree' tool the factory registered. The
// refusal must name the foreign ref and its `/flow <ref>` command — proof the
// production makeDeriveRefs site injects deriveFlowRefsDetailed with the real
// callerSessionFile/callerPid/pidAlive inputs.
function seedForeignLiveRun(
  agentDir: string,
  ref: string,
  gitRoot: string,
): void {
  const runsDir = join(agentDir, 'pi-flow', 'runs')
  const pendingDir = join(agentDir, 'pi-flow', 'pending')
  mkdirSync(runsDir, { recursive: true })
  mkdirSync(pendingDir, { recursive: true })
  const events = [
    { kind: 'run-start', at: '2026-11-28T00:00:00Z', ref, mode: 'work' },
    {
      kind: 'run-input',
      at: '2026-11-28T00:01:00Z',
      ref,
      input: { mode: 'work', gitRoot, workRoots: [] },
    },
    { kind: 'phase-start', at: '2026-11-28T00:02:00Z', ref, phase: 'validate' },
    {
      kind: 'loop-state',
      at: '2026-11-28T00:03:00Z',
      ref,
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
      ref,
      // Live pid (this very process) but a foreign session file: the real
      // ownerPidAlive probe reports alive and the sessionFile comparison
      // classifies the record as foreign — never adoptable.
      sessionFile: '/agent/sessions/other.jsonl',
      pid: process.pid,
    },
  ]
  writeFileSync(
    join(runsDir, `${ref}.journal.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  )
  const record = {
    schema: PENDING_SCHEMA,
    ref,
    phase: 'validate',
    createdAt: '2026-11-28T00:04:00Z',
    sourceAt: '2026-11-28T00:04:00Z',
  }
  writeFileSync(join(pendingDir, `${ref}.json`), `${JSON.stringify(record)}\n`)
}

function makeProductionPi(gitRoot: string): {
  pi: ExtensionAPI
  tools: { name: string; execute: BindExecute }[]
} {
  const tools: { name: string; execute: BindExecute }[] = []
  const base = {
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: (options: unknown) => {
      tools.push(options as { name: string; execute: BindExecute })
    },
    sendUserMessage: () => {},
    exec: async (_cmd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        return { code: 0, stdout: `${gitRoot}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    on: () => {},
    appendEntry: () => {},
  }
  const pi = new Proxy(base, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target]
      }
      return () => {}
    },
  }) as unknown as ExtensionAPI
  return { pi, tools }
}

test('bind heal: production factory wiring surfaces the foreign-live ref in the bind refusal', async () => {
  const root = mkTmpDir('wt-wire-')
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    seedForeignLiveRun(agentDir, 'PMR-WIRE1', '/repo')
    const { pi, tools } = makeProductionPi('/repo')
    flowExtension(pi)
    const tool = tools.find((t) => t.name === 'worktree')
    assert.ok(tool, 'worktree tool registered by the production factory')
    const dir = mkTmpDir('wt-wire-target-')
    setActiveFlowRef(null)
    const result = await tool.execute(
      'wire-1',
      { action: 'bind', path: dir, branch: 'fix/x' },
      new AbortController().signal,
      undefined,
      { cwd: root },
    )
    const text = result.content[0]?.text ?? ''
    assert.ok(text.startsWith('No active flow ref'), text)
    assert.ok(text.includes('/flow PMR-WIRE1'), text)
    assert.ok(text.includes(NO_ACTIVE_FLOW_WARNING), text)
    assert.equal(getActiveFlowRef(), null, 'foreign live flow never adopted')
    assert.equal(getFlowWorktree(), null)
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
  }
})
