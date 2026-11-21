// PMR-DMZR — worktree prune action: close only PROVEN-dangling herdr
// workspaces. Tests live in their own file; existing worktree.test.ts tests
// encode prior intent and are not modified.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { DEFAULT_RECIPES } from '../flow/effect-gate.ts'
import { setActiveFlowRef } from '../flow/worktree-context.ts'
import {
  EFFECT_KINDS,
  type EffectDeclarationRecord,
  type EffectJournal,
} from '../run-state.ts'
import { parseWorkspaces } from '../worktree/herdr.ts'
import worktreeExtension from '../worktree/index.ts'

// --- parseWorkspaces (herdr.ts defensive parsing) ---

// AIDEV-NOTE: fixture mirrors live `herdr workspace list` output captured on
// herdr 0.8.2 — trimmed to load-bearing fields; do not "fix" field names.
const LIVE_WORKSPACES = [
  {
    active_tab_id: 'w2T:t1',
    agent_status: 'unknown',
    focused: false,
    label: 'dir: homelab',
    number: 1,
    pane_count: 1,
    tab_count: 1,
    workspace_id: 'w2T',
  },
  {
    agent_status: 'done',
    focused: true,
    label: 'dir: pi-my-rifle-ext',
    number: 3,
    workspace_id: 'w14',
    worktree: {
      checkout_path: '/home/geert/Code/personal/pi-my-rifle-ext',
      is_linked_worktree: false,
      repo_key: '/home/geert/Code/personal/pi-my-rifle-ext/.git',
      repo_name: 'pi-my-rifle-ext',
      repo_root: '/home/geert/Code/personal/pi-my-rifle-ext',
    },
  },
  {
    agent_status: 'unknown',
    label: 'featuredp-252-fix-sendotpsmswithpersistence-to',
    number: 7,
    workspace_id: 'w28',
    worktree: {
      checkout_path:
        '/home/geert/.herdr/worktrees/account-api/feature-dp-252-fix-sendotpsmswithpersistence-to-hold-no',
      is_linked_worktree: true,
      repo_key: '/home/geert/Code/salaryhero/account-api/.git',
      repo_name: 'account-api',
      repo_root: '/home/geert/Code/salaryhero/account-api',
    },
  },
]

test('parseWorkspaces: real herdr 0.8.2 workspace list payload', () => {
  const payload = {
    id: 'cli:workspace:list',
    result: { type: 'workspace_list', workspaces: LIVE_WORKSPACES },
  }
  const parsed = parseWorkspaces(payload)
  assert.equal(parsed.length, 3)

  // Plain directory workspace — no worktree provenance.
  assert.equal(parsed[0].workspaceId, 'w2T')
  assert.equal(parsed[0].label, 'dir: homelab')
  assert.equal(parsed[0].agentStatus, 'unknown')
  assert.equal(parsed[0].checkoutPath, '')
  assert.equal(parsed[0].isLinkedWorktree, false)

  // Main-checkout row: provenance present, is_linked_worktree false.
  assert.equal(parsed[1].workspaceId, 'w14')
  assert.equal(
    parsed[1].checkoutPath,
    '/home/geert/Code/personal/pi-my-rifle-ext',
  )
  assert.equal(parsed[1].isLinkedWorktree, false)
  assert.equal(
    parsed[1].repoKey,
    '/home/geert/Code/personal/pi-my-rifle-ext/.git',
  )
  assert.equal(parsed[1].repoName, 'pi-my-rifle-ext')
  assert.equal(parsed[1].repoRoot, '/home/geert/Code/personal/pi-my-rifle-ext')

  // Linked-worktree row.
  assert.equal(parsed[2].workspaceId, 'w28')
  assert.equal(parsed[2].isLinkedWorktree, true)
  assert.equal(
    parsed[2].checkoutPath,
    '/home/geert/.herdr/worktrees/account-api/feature-dp-252-fix-sendotpsmswithpersistence-to-hold-no',
  )
})

test('parseWorkspaces: absent is_linked_worktree defaults to linked', () => {
  const payload = {
    result: {
      workspaces: [{ workspace_id: 'w5', worktree: { checkout_path: '/wt' } }],
    },
  }
  const parsed = parseWorkspaces(payload)
  assert.equal(parsed[0].isLinkedWorktree, true)
  assert.equal(parsed[0].checkoutPath, '/wt')
  assert.equal(parsed[0].repoKey, '')
})

test('parseWorkspaces: variant field names tolerated', () => {
  const payload = {
    result: {
      workspaces: [
        {
          workspace: { id: 'w9v' },
          name: 'alt-label',
          status: 'idle',
          work_tree: { checkout_path: '/gone/alt', repo_name: 'repo-x' },
        },
      ],
    },
  }
  const parsed = parseWorkspaces(payload)
  assert.equal(parsed[0].workspaceId, 'w9v')
  assert.equal(parsed[0].label, 'alt-label')
  assert.equal(parsed[0].agentStatus, 'idle')
  assert.equal(parsed[0].checkoutPath, '/gone/alt')
  assert.equal(parsed[0].repoName, 'repo-x')
})

test('parseWorkspaces: null and malformed payloads degrade to an empty list', () => {
  assert.deepEqual(parseWorkspaces(null), [])
  assert.deepEqual(parseWorkspaces('nope'), [])
  assert.deepEqual(parseWorkspaces({}), [])
  assert.deepEqual(
    parseWorkspaces({ result: { workspaces: 'not-an-array' } }),
    [],
  )
})

// --- worktree tool: prune action ---

type PruneExecute = (
  toolCallId: string,
  params: { action: string },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: Record<string, unknown>,
) => Promise<{
  content: { type: string; text: string }[]
  details: Record<string, unknown> | undefined
}>

interface CapturedDeclaration {
  ref: string
  effect: string
  command: string
  recipe: string[]
}

// AIDEV-NOTE: fake journal — same shape as worktree.test.ts's
// makeFakeEffects; redeclared here so this file stays self-contained
// (importing the other test file would register its tests into this run).
function makeFakeEffects(declareOk: boolean): EffectJournal & {
  declarations: CapturedDeclaration[]
} {
  const declarations: CapturedDeclaration[] = []
  const journal = {
    declarations,
    declare: async (input: {
      ref: string
      effect: string
      command: string
      recipe: string[]
    }) => {
      declarations.push({
        ref: input.ref,
        effect: input.effect,
        command: input.command,
        recipe: input.recipe,
      })
      if (!declareOk) {
        return { ok: false as const, reason: 'journal offline' }
      }
      return { ok: true as const, effectId: 'deadbeef1234' }
    },
    find: async (): Promise<EffectDeclarationRecord | null> => null,
  }
  return journal as EffectJournal & { declarations: CapturedDeclaration[] }
}

interface PruneExecOpts {
  workspaces?: unknown[]
  worktrees?: Array<{ path: string; branch: string }>
  agents?: Array<{
    agent: string
    agent_status?: string
    workspace_id?: string
    cwd?: string
    pane_id?: string
  }>
  workspaceListFails?: boolean
  worktreeListFails?: boolean
  agentListFails?: boolean
  closeFails?: boolean
}

// AIDEV-NOTE: routed exec fake serving every command the prune action
// issues: herdr worktree list (preflight + proven check), herdr agent list
// (attach check), herdr workspace list, herdr workspace close (recorded in
// herdrCalls so tests can prove a close happened or never ran).
function makePruneTool(
  opts: PruneExecOpts = {},
  effects: EffectJournal = makeFakeEffects(true),
): {
  execute: PruneExecute
  herdrCalls: string[]
  effects: EffectJournal & { declarations: CapturedDeclaration[] }
} {
  const herdrCalls: string[] = []
  const fake = effects as EffectJournal & {
    declarations: CapturedDeclaration[]
  }
  const exec = async (
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (command === 'herdr' && args[0] === 'worktree' && args[1] === 'list') {
      if (opts.worktreeListFails === true) {
        return { code: 1, stdout: '', stderr: 'herdr worktree list exploded' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          result: { worktrees: opts.worktrees ?? [] },
        }),
      }
    }
    if (command === 'herdr' && args[0] === 'agent' && args[1] === 'list') {
      if (opts.agentListFails === true) {
        return { code: 1, stdout: '', stderr: 'herdr agent list exploded' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { agents: opts.agents ?? [] } }),
      }
    }
    if (command === 'herdr' && args[0] === 'workspace' && args[1] === 'list') {
      if (opts.workspaceListFails === true) {
        return { code: 1, stdout: '', stderr: 'herdr workspace list exploded' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 'cli:workspace:list',
          result: { type: 'workspace_list', workspaces: opts.workspaces ?? [] },
        }),
      }
    }
    if (command === 'herdr' && args[0] === 'workspace' && args[1] === 'close') {
      herdrCalls.push(`herdr ${args.join(' ')}`)
      if (opts.closeFails === true) {
        return { code: 1, stdout: '', stderr: 'herdr workspace close exploded' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const tools: { name: string; execute: PruneExecute }[] = []
  const mockPi = {
    exec,
    registerTool: (options: unknown) => {
      tools.push(options as { name: string; execute: PruneExecute })
    },
  } as unknown as ExtensionAPI
  const ext = worktreeExtension as unknown as (
    pi: ExtensionAPI,
    deps?: unknown,
  ) => void
  ext(mockPi, { effects: fake })
  const tool = tools.find((t) => t.name === 'worktree')
  assert.ok(tool, 'worktree tool registered')
  return { execute: tool.execute, herdrCalls, effects: fake }
}

// A dangling fixture needs a checkout_path that genuinely does not exist on
// disk (the prune action stats it): mkdtemp gives a guaranteed-fresh base,
// so anything under it named 'gone' does not exist.
async function makeDanglingBase(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'wt-prune-'))
}

function danglingWorkspace(checkoutPath: string, workspaceId = 'wPR'): unknown {
  return {
    workspace_id: workspaceId,
    label: 'feat-dangling',
    agent_status: 'unknown',
    worktree: {
      checkout_path: checkoutPath,
      is_linked_worktree: true,
      repo_key: '/repo/.git',
      repo_name: 'repo',
      repo_root: '/repo',
    },
  }
}

const pruneCtx = { cwd: '/tmp/main-checkout', hasUI: false, mode: 'tui' }

interface PruneEntryView {
  workspaceId: string
  label: string
  checkoutPath: string
  outcome: string
  reason: string
}

function pruneEntries(
  details: Record<string, unknown> | undefined,
): PruneEntryView[] {
  const entries = (details as { entries: unknown } | undefined)?.entries
  assert.ok(Array.isArray(entries), 'details.entries must be an array')
  return entries as PruneEntryView[]
}

afterEach(() => {
  setActiveFlowRef(null)
})

test('worktree prune: proven-dangling workspace is closed with a declared effect', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    worktrees: [],
    agents: [],
  })
  setActiveFlowRef('PMR-PRUNE')
  const result = await execute(
    'call-p1',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, ['herdr workspace close wPR'])
  assert.equal(effects.declarations.length, 1)
  const decl = effects.declarations[0]
  assert.equal(decl.ref, 'PMR-PRUNE')
  assert.equal(decl.effect, 'workspace-close')
  assert.equal(decl.command, 'herdr workspace close wPR')
  const entries = pruneEntries(result.details)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].outcome, 'closed')
  assert.equal(entries[0].checkoutPath, gone)
  assert.match(result.content[0]?.text ?? '', /1 closed/)
  assert.match(result.content[0]?.text ?? '', /0 skipped/)
})

test('worktree prune: declaration falls back to worktree-ops outside a flow', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
  })
  setActiveFlowRef(null)
  const result = await execute(
    'call-p2',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, ['herdr workspace close wPR'])
  assert.equal(effects.declarations[0]?.ref, 'worktree-ops')
  assert.equal(entriesClosed(pruneEntries(result.details)), 1)
})

function entriesClosed(entries: PruneEntryView[]): number {
  let closed = 0
  for (const entry of entries) {
    if (entry.outcome === 'closed') {
      closed = closed + 1
    }
  }
  return closed
}

test('worktree prune: workspace whose checkout path exists is skipped', async () => {
  const base = await makeDanglingBase()
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(base)],
  })
  const result = await execute(
    'call-p3',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [], 'live checkout must never be closed')
  assert.equal(effects.declarations.length, 0)
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /checkout path exists/)
})

test('worktree prune: workspace without worktree provenance is skipped', async () => {
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [{ workspace_id: 'wDIR', label: 'dir: homelab' }],
  })
  const result = await execute(
    'call-p4',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [])
  assert.equal(effects.declarations.length, 0)
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /no worktree provenance/)
})

test('worktree prune: checkout still present in herdr worktree list is skipped', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    worktrees: [{ path: gone, branch: 'feat/dangling' }],
  })
  const result = await execute(
    'call-p5',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [])
  assert.equal(effects.declarations.length, 0)
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /herdr worktree list/)
})

test('worktree prune: attached agent defers by workspace id (unknown-means-live)', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    agents: [
      {
        agent: 'worker',
        agent_status: 'mysterious-zombie',
        workspace_id: 'wPR',
      },
    ],
  })
  const result = await execute(
    'call-p6',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [], 'unknown agent state must defer the close')
  assert.equal(effects.declarations.length, 0)
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /agent 'worker'/)
  assert.match(entries[0].reason, /state: mysterious-zombie/)
})

test('worktree prune: attached agent defers by cwd prefix', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    agents: [
      {
        agent: 'worker',
        agent_status: 'working',
        workspace_id: 'wOTHER',
        cwd: path.join(gone, 'nested'),
      },
    ],
  })
  const result = await execute(
    'call-p7',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [])
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /agent 'worker'/)
})

test('worktree prune: own pane (HERDR_PANE_ID) is excluded from the attach check', async () => {
  // PMR-F5HB policy, mirrored for prune: the session's OWN agent row must
  // not pin its workspace forever.
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    agents: [
      {
        agent: 'pi',
        agent_status: 'working',
        workspace_id: 'wPR',
        cwd: gone,
        pane_id: 'pane-self',
      },
    ],
  })
  const previous = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = 'wPR:pane-self'
  try {
    const result = await execute(
      'call-p8',
      { action: 'prune' },
      new AbortController().signal,
      undefined,
      pruneCtx,
    )
    assert.deepEqual(herdrCalls, ['herdr workspace close wPR'])
    assert.equal(entriesClosed(pruneEntries(result.details)), 1)
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = previous
  }
})

test('worktree prune: a different pane still defers', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    agents: [
      {
        agent: 'worker',
        agent_status: 'working',
        workspace_id: 'wPR',
        cwd: gone,
        pane_id: 'pane-child',
      },
    ],
  })
  const previous = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = 'wPR:pane-self'
  try {
    const result = await execute(
      'call-p9',
      { action: 'prune' },
      new AbortController().signal,
      undefined,
      pruneCtx,
    )
    assert.deepEqual(herdrCalls, [])
    const entries = pruneEntries(result.details)
    assert.equal(entries[0].outcome, 'skipped')
    assert.match(entries[0].reason, /agent 'worker'/)
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = previous
  }
})

test('worktree prune: workspace list failure aborts the run fail-closed', async () => {
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaceListFails: true,
    workspaces: [danglingWorkspace('/gone/never-statted')],
  })
  const result = await execute(
    'call-p10',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.match(result.content[0]?.text ?? '', /herdr workspace list failed/)
  assert.deepEqual(herdrCalls, [], 'no close when the workspace list fails')
  assert.equal(effects.declarations.length, 0)
})

test('worktree prune: agent list failure aborts the run fail-closed', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    agentListFails: true,
  })
  const result = await execute(
    'call-p11',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.match(result.content[0]?.text ?? '', /herdr agent list failed/)
  assert.deepEqual(herdrCalls, [], 'no close when agents cannot be listed')
  assert.equal(effects.declarations.length, 0)
})

test('worktree prune: worktree list failure aborts the run fail-closed (preflight)', async () => {
  const { execute, herdrCalls, effects } = makePruneTool({
    worktreeListFails: true,
    workspaces: [danglingWorkspace('/gone/never-statted')],
  })
  const result = await execute(
    'call-p12',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.match(result.content[0]?.text ?? '', /preflight failed/)
  assert.deepEqual(herdrCalls, [])
  assert.equal(effects.declarations.length, 0)
})

test('worktree prune: declaration failure skips the close (declare-before-act)', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool(
    { workspaces: [danglingWorkspace(gone)] },
    makeFakeEffects(false),
  )
  const result = await execute(
    'call-p13',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(
    herdrCalls,
    [],
    'a failed declaration must prevent the close',
  )
  assert.equal(effects.declarations.length, 1, 'declaration was attempted')
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /effect declaration failed/)
})

test('worktree prune: failing close command is reported skipped-with-reason', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [danglingWorkspace(gone)],
    closeFails: true,
  })
  const result = await execute(
    'call-p14',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, ['herdr workspace close wPR'])
  assert.equal(effects.declarations.length, 1, 'declared before acting')
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /herdr workspace close wPR failed/)
})

test('worktree prune: mixed batch closes only the proven-dangling entry', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls } = makePruneTool({
    workspaces: [
      { workspace_id: 'wDIR', label: 'dir: homelab' },
      danglingWorkspace(base, 'wLIVE'),
      danglingWorkspace(gone, 'wGONE'),
    ],
  })
  const result = await execute(
    'call-p15',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, ['herdr workspace close wGONE'])
  const entries = pruneEntries(result.details)
  assert.equal(entries.length, 3)
  assert.equal(entriesClosed(entries), 1)
  assert.match(result.content[0]?.text ?? '', /1 closed/)
  assert.match(result.content[0]?.text ?? '', /2 skipped/)
})

test('worktree prune: no workspaces at all is a clean no-op', async () => {
  const { execute, herdrCalls, effects } = makePruneTool({ workspaces: [] })
  const result = await execute(
    'call-p16',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [])
  assert.equal(effects.declarations.length, 0)
  assert.match(result.content[0]?.text ?? '', /0 closed, 0 skipped/)
})

test('worktree prune: provenance without a workspace id cannot be closed', async () => {
  const base = await makeDanglingBase()
  const gone = path.join(base, 'gone')
  const { execute, herdrCalls, effects } = makePruneTool({
    workspaces: [{ label: 'no-id', worktree: { checkout_path: gone } }],
  })
  const result = await execute(
    'call-p17',
    { action: 'prune' },
    new AbortController().signal,
    undefined,
    pruneCtx,
  )
  assert.deepEqual(herdrCalls, [])
  assert.equal(effects.declarations.length, 0)
  const entries = pruneEntries(result.details)
  assert.equal(entries[0].outcome, 'skipped')
  assert.match(entries[0].reason, /workspace id missing/)
})

test('workspace-close effect kind is registered with a recipe', () => {
  assert.ok(EFFECT_KINDS.includes('workspace-close'))
  assert.ok(DEFAULT_RECIPES['workspace-close'].length >= 1)
})
