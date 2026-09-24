/**
 * Worktree Extension — `worktree` tool wrapping Herdr worktree workspaces.
 * Actions: create / list / remove. See plan 2026-09-07-pi-worktree-extension.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { copyEnvFiles, runBootstrap } from './bootstrap.ts'
import { deriveBranch, parseBranchInput, slugify } from './branch.ts'
import {
  agentList,
  filterLinked,
  type HerdrAgent,
  type HerdrWorktree,
  herdrAvailable,
  parseJson,
  pickString,
  worktreeCreate,
  worktreeList,
  worktreeRemove,
} from './herdr.ts'
import {
  type BranchDeleteDecision,
  decideBranchDelete,
  type PrState,
} from './remove-guards.ts'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown> | undefined
}

function textResult(
  text: string,
  details?: Record<string, unknown>,
): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }], details }
  return result
}

/** Update callback shape pi hands to execute: partial AgentToolResult. */
type OnUpdate =
  | ((update: {
      content: Array<{ type: 'text'; text: string }>
      details: Record<string, unknown> | undefined
    }) => void)
  | undefined

function errorResult(text: string): ToolResult {
  return textResult(text)
}

/** First `worktree <path>` entry of `git worktree list --porcelain`. */
async function mainCheckout(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec('git', ['worktree', 'list', '--porcelain'], {
    cwd,
  })
  if (result.code !== 0) {
    throw new Error(
      `git worktree list failed: ${result.stderr || result.stdout}`,
    )
  }
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      return line.slice('worktree '.length)
    }
  }
  throw new Error('git worktree list returned no worktree entries')
}

async function createFlow(
  pi: ExtensionAPI,
  cwd: string,
  params: {
    jira_id?: string
    name?: string
    type?: string
    branch?: string
    label?: string
  },
  signal: AbortSignal | undefined,
  onUpdate: OnUpdate,
): Promise<ToolResult> {
  const report = (text: string) => {
    if (onUpdate) {
      onUpdate({ content: [{ type: 'text', text }], details: undefined })
    }
  }

  let input: ReturnType<typeof parseBranchInput>
  try {
    input = parseBranchInput({
      jira_id: params.jira_id,
      name: params.name,
      type: params.type,
      branch: params.branch,
    })
  } catch (error) {
    return errorResult((error as Error).message)
  }

  let derived: Awaited<ReturnType<typeof deriveBranch>>
  try {
    derived = await deriveBranch(pi, input)
  } catch (error) {
    return errorResult(
      `Branch derivation failed for input ${JSON.stringify({
        jira_id: params.jira_id,
        name: params.name,
        branch: params.branch,
      })}: ${(error as Error).message}`,
    )
  }

  const preflight = await herdrAvailable(pi, cwd)
  if (!preflight.ok) {
    return errorResult(
      `${preflight.error}\nThe worktree tool must run inside a Herdr session with herdr on PATH.`,
    )
  }

  let label: string
  if (params.label) {
    label = params.label
  } else {
    label = slugify(derived.branch)
  }

  report(`Creating worktree ${derived.branch}...`)
  let created: { path: string; workspaceId: string }
  try {
    created = await worktreeCreate(pi, cwd, derived.branch, label)
  } catch (error) {
    return errorResult((error as Error).message)
  }
  if (created.path === '') {
    return errorResult(
      `herdr worktree create succeeded but returned no worktree path. Raw output tail: ${JSON.stringify(created)}`,
    )
  }
  const { path, workspaceId } = created

  report(`Bootstrapping dependencies in ${path}...`)
  const bootstrap = await runBootstrap(pi, path, signal, report)

  const main = await mainCheckout(pi, cwd)

  report('Copying env files...')
  const envCopied = await copyEnvFiles(pi, main, path)

  const bootstrapLines = bootstrap
    .map((step) => {
      let line = `FAIL ${step.label} — ${step.output}`
      if (step.ok) {
        line = `ok   ${step.label}`
      }
      return line
    })
    .join('\n')
  let envLine = 'none (all present or none found)'
  if (envCopied.length > 0) {
    envLine = envCopied.join(', ')
  }

  const text = [
    `Worktree ready: ${derived.branch}`,
    `Path: ${path}`,
    `Workspace: ${workspaceId || '(unknown)'}`,
    `Bootstrap:\n${bootstrapLines}`,
    `Env files copied: ${envLine}`,
    `Next: cd ${path} && pi -c  (or spawn a subagent with cwd ${path})`,
  ].join('\n')

  return textResult(text, {
    branch: derived.branch,
    path,
    workspaceId,
    bootstrap,
    envCopied,
  })
}

// AIDEV-NOTE: join-key logic — workspace id when the agent entry carries
// one, else worktree-path prefix match against agent cwd. Minimal join;
// dashboard polish (main-checkout filter, branch sort) landed in 3.1.
function joinAgents(
  worktrees: HerdrWorktree[],
  agents: HerdrAgent[],
): Map<HerdrWorktree, HerdrAgent | undefined> {
  const joined = new Map<HerdrWorktree, HerdrAgent | undefined>()
  for (const wt of worktrees) {
    let match: HerdrAgent | undefined
    if (wt.workspaceId !== '') {
      match = agents.find((a) => a.workspaceId === wt.workspaceId)
    }
    if (!match) {
      match = agents.find((a) => a.cwd?.startsWith(wt.path))
    }
    joined.set(wt, match)
  }
  return joined
}

async function listFlow(pi: ExtensionAPI, cwd: string): Promise<ToolResult> {
  const preflight = await herdrAvailable(pi, cwd)
  if (!preflight.ok) {
    return errorResult(
      `${preflight.error}\nThe worktree tool must run inside a Herdr session with herdr on PATH.`,
    )
  }

  let worktrees: HerdrWorktree[]
  try {
    worktrees = await worktreeList(pi, cwd)
  } catch (error) {
    return errorResult((error as Error).message)
  }

  // AIDEV-NOTE: dashboard = parallel workspaces only; herdr also returns
  // the main checkout row (isLinked === false) which is filtered out.
  const linked = filterLinked(worktrees)
  if (linked.length === 0) {
    return textResult('No worktrees (only the main checkout exists)', {
      worktrees,
      agentsDegraded: false,
    })
  }
  const sorted = [...linked].sort((a, b) => a.branch.localeCompare(b.branch))

  let agents: HerdrAgent[] = []
  let degraded = false
  try {
    agents = await agentList(pi, cwd)
  } catch {
    degraded = true
  }

  const joined = joinAgents(sorted, agents)
  const rows = sorted.map((wt) => {
    const agent = joined.get(wt)
    let state = '—'
    let pane = '—'
    if (agent) {
      state = agent.state
      pane = agent.pane
    }
    return { branch: wt.branch, state, pane, path: wt.path }
  })

  const width = (key: 'branch' | 'state' | 'pane') =>
    Math.max(key.length, ...rows.map((r) => r[key].length))
  const wBranch = width('branch')
  const wState = width('state')
  const wPane = width('pane')
  const lines = [
    `${'branch'.padEnd(wBranch)}  ${'state'.padEnd(wState)}  ${'pane'.padEnd(wPane)}  path`,
    `${'-'.repeat(wBranch)}  ${'-'.repeat(wState)}  ${'-'.repeat(wPane)}  ${'-'.repeat(4)}`,
    ...rows.map(
      (r) =>
        `${r.branch.padEnd(wBranch)}  ${r.state.padEnd(wState)}  ${r.pane.padEnd(wPane)}  ${r.path}`,
    ),
  ]
  if (degraded) {
    lines.push('(agent list unavailable — agent state shown as —)')
  }
  return textResult(lines.join('\n'), { worktrees, agentsDegraded: degraded })
}

// AIDEV-NOTE: remove guards order per spec — branch captured BEFORE
// removal (branch ref only exists while the worktree checkout does);
// PR merge state via gh checked BEFORE herdr removal so a refused branch
// delete leaves the worktree untouched. `git branch -D` (not -d) because
// squash merges look unmerged to git's ancestry check.
async function ghPrState(
  pi: ExtensionAPI,
  main: string,
  branch: string,
): Promise<PrState> {
  const result = await pi.exec(
    'gh',
    ['pr', 'view', branch, '--json', 'state'],
    { cwd: main },
  )
  if (result.code !== 0) {
    const err = `${result.stderr}${result.stdout}`
    if (/command not found/.test(err)) {
      return 'GH_MISSING'
    }
    return 'NO_PR'
  }
  const payload = parseJson(result.stdout)
  const state = pickString(payload, ['state'])
  if (state === 'MERGED' || state === 'OPEN' || state === 'CLOSED') {
    return state
  }
  return 'NO_PR'
}

async function removeFlow(
  pi: ExtensionAPI,
  cwd: string,
  params: {
    cwd?: string
    force?: boolean
    delete_branch?: boolean
  },
): Promise<ToolResult> {
  if (!params.cwd) {
    return errorResult("remove requires 'cwd' — the worktree path to remove")
  }

  // Branch must be captured before removal — after `herdr worktree remove`
  // the checkout (and its HEAD) is gone, but the branch ref remains.
  const branchResult = await pi.exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: params.cwd },
  )
  if (branchResult.code !== 0) {
    return errorResult(
      `git rev-parse failed in ${params.cwd}: ${branchResult.stderr || branchResult.stdout}`,
    )
  }
  const branch = branchResult.stdout.trim()

  const force = params.force === true
  const status = await pi.exec('git', ['status', '--porcelain'], {
    cwd: params.cwd,
  })
  if (status.code !== 0) {
    return errorResult(
      `git status failed in ${params.cwd}: ${status.stderr || status.stdout}`,
    )
  }
  const dirtyCount = status.stdout
    .split('\n')
    .filter((line) => line.trim() !== '').length
  if (dirtyCount > 0 && !force) {
    return errorResult(
      `${params.cwd} is dirty (${dirtyCount} changed files) — pass force: true to remove anyway`,
    )
  }

  const preflight = await herdrAvailable(pi, cwd)
  if (!preflight.ok) {
    return errorResult(
      `${preflight.error}\nThe worktree tool must run inside a Herdr session with herdr on PATH.`,
    )
  }

  let worktrees: HerdrWorktree[]
  try {
    worktrees = await worktreeList(pi, cwd)
  } catch (error) {
    return errorResult((error as Error).message)
  }
  const target = worktrees.find((wt) => wt.path === params.cwd)
  if (!target) {
    return errorResult(`No Herdr worktree found at path ${params.cwd}`)
  }

  const main = await mainCheckout(pi, cwd)

  // PR state resolved BEFORE removal so a refused branch delete aborts
  // with the worktree intact.
  let decision: BranchDeleteDecision = {
    action: 'skip',
    reason: 'delete_branch not requested',
  }
  let prState: PrState | undefined
  if (params.delete_branch === true) {
    prState = await ghPrState(pi, main, branch)
    decision = decideBranchDelete({
      deleteBranchRequested: true,
      prState,
      force,
    })
    if (decision.action === 'refuse') {
      return errorResult(
        `Refusing to remove: branch ${branch} not deletable — ${decision.reason}.\nPass force: true to remove anyway.`,
      )
    }
  }

  try {
    await worktreeRemove(pi, cwd, target.workspaceId, force)
  } catch (error) {
    return errorResult((error as Error).message)
  }

  let branchDeleted = false
  let branchNote = `branch ${branch} kept`
  if (decision.action === 'delete') {
    const del = await pi.exec('git', ['branch', '-D', branch], {
      cwd: main,
    })
    if (del.code === 0) {
      branchDeleted = true
      branchNote = `branch ${branch} deleted`
    } else {
      branchNote = `branch ${branch} delete failed: ${del.stderr || del.stdout}`
    }
  } else if (decision.action === 'skip') {
    branchNote = `branch ${branch} kept (${decision.reason})`
  }

  // Best-effort prune — never fails the remove.
  let pruneNote = 'prune ok'
  const prune = await pi.exec('git', ['fetch', '--prune'], { cwd: main })
  if (prune.code !== 0) {
    pruneNote = `git fetch --prune failed (non-fatal): ${prune.stderr || prune.stdout}`
  }

  const text = [
    `Removed worktree at ${params.cwd}.`,
    branchNote,
    pruneNote,
  ].join('\n')
  return textResult(text, {
    removed: params.cwd,
    branch,
    branchDeleted,
    prState,
    force,
  })
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'worktree',
    label: 'Worktree',
    description:
      'Create, list, or remove git worktrees managed as Herdr workspaces. Create derives a branch (from a Jira issue, a conventional name+type, or a literal), creates the Herdr worktree, bootstraps dependencies from the detected lockfile, copies missing .env* files from the main checkout. List shows a worktree/agent dashboard; remove guards against dirty worktrees.',
    promptSnippet:
      'Create/list/remove git worktrees as Herdr workspaces for parallel work',
    promptGuidelines: [
      'Use worktree when implementing multiple features of the same repo in parallel — create a worktree before spawning a subagent with cwd set to the new worktree path.',
      'Use worktree list as a dashboard of worktrees and their running pi agent states.',
      'Create supports exactly one of jira_id, name (+type), or branch.',
    ],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal('create'), Type.Literal('list'), Type.Literal('remove')],
        { description: 'Action to perform' },
      ),
      jira_id: Type.Optional(
        Type.String({
          description: 'Create mode 1: Jira ticket ID, e.g. DP-121 (uses acli)',
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            'Create mode 2: feature name, slugified into <type>/<slug>',
        }),
      ),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal('feat'),
            Type.Literal('fix'),
            Type.Literal('chore'),
            Type.Literal('docs'),
            Type.Literal('refactor'),
          ],
          { description: 'Branch type for name mode (default: feat)' },
        ),
      ),
      branch: Type.Optional(
        Type.String({
          description: 'Create mode 3: literal branch name',
        }),
      ),
      label: Type.Optional(
        Type.String({
          description: 'Herdr workspace label (default: branch slug)',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: 'remove: worktree path to remove (required for remove)',
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: 'remove: skip dirty guard / unmerged-branch guard',
        }),
      ),
      delete_branch: Type.Optional(
        Type.Boolean({
          description: 'remove: delete branch after removal (merge-checked)',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action: 'create' | 'list' | 'remove'
        jira_id?: string
        name?: string
        type?: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor'
        branch?: string
        label?: string
        cwd?: string
        force?: boolean
        delete_branch?: boolean
      },
      signal: AbortSignal | undefined,
      onUpdate: OnUpdate,
      ctx: ExtensionContext,
    ): Promise<ToolResult> {
      const cwd = ctx?.cwd ?? process.cwd()
      void _toolCallId
      if (params.action === 'create') {
        return createFlow(pi, cwd, params, signal, onUpdate)
      }
      if (params.action === 'list') {
        return listFlow(pi, cwd)
      }
      return removeFlow(pi, cwd, params)
    },
  })
}
