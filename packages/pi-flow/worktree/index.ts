/**
 * Worktree module — `worktree` tool wrapping Herdr worktree workspaces.
 * Actions: create / list / bind / remove. See plan 2026-09-07-pi-worktree-extension.
 * AIDEV-NOTE: PMR-K0ZV — absorbed from the retired pi-worktree package into
 * pi-flow; registered exactly once from pi-flow/index.ts.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  getActiveFlowRef,
  getFlowWorktree,
  NO_ACTIVE_FLOW_WARNING,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import {
  clearFlowBase,
  currentBranch,
  recordFlowBase,
  resolveBaseSha,
} from '../shared/flow-base.ts'
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
  describePruneFailure,
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

  // AIDEV-NOTE: PMR-R4AP — capture the main checkout's branch as the flow's
  // diff base BEFORE creating the worktree; refuse on detached HEAD.
  const execFn = (c: string, a: string[], o?: { cwd?: string }) =>
    pi.exec(c, a, o)
  let mainPath: string
  try {
    mainPath = await mainCheckout(pi, cwd)
  } catch (error) {
    return errorResult((error as Error).message)
  }
  const base = await currentBranch(execFn, mainPath)
  if (!base.ok) {
    return errorResult(`Cannot record flow base: ${base.reason}`)
  }

  const baseShaResult = await resolveBaseSha(execFn, mainPath, base.branch)
  if (!baseShaResult.ok) {
    return errorResult(`Cannot record flow base: ${baseShaResult.reason}`)
  }
  const baseSha = baseShaResult.branch

  // Record BEFORE creating: no half-created worktree if recording fails
  // (git config is repo-shared and works for a not-yet-existing branch).
  const preRecorded = await recordFlowBase(
    execFn,
    mainPath,
    derived.branch,
    base.branch,
    baseSha,
  )
  if (!preRecorded.ok) {
    return errorResult(`Cannot record flow base: ${preRecorded.reason}`)
  }

  report(
    `Creating worktree ${derived.branch} from ${base.branch}@${baseSha.slice(0, 9)}...`,
  )
  let created: { path: string; workspaceId: string }
  try {
    created = await worktreeCreate(pi, cwd, derived.branch, label, baseSha)
  } catch (error) {
    await clearFlowBase(execFn, mainPath, derived.branch)
    return errorResult((error as Error).message)
  }
  if (created.path === '') {
    return errorResult(
      `herdr worktree create succeeded but returned no worktree path. Raw output tail: ${JSON.stringify(created)}`,
    )
  }
  const { path, workspaceId } = created

  // Verify herdr really branched from the recorded SHA.
  const head = await execFn('git', ['rev-parse', 'HEAD'], { cwd: path })
  if (head.code !== 0 || head.stdout.trim() !== baseSha) {
    return errorResult(
      `Worktree created at ${path} but its HEAD (${head.stdout.trim()}) is not the recorded base ${base.branch}@${baseSha} — herdr did not honour --base. Remove the worktree and report this.`,
    )
  }

  // AIDEV-NOTE: PMR-1CCT — bind the created worktree to the active flow (if
  // any) so the review tool resolves its diff here instead of the session
  // checkout. Skipped (with a loud warning in the result) outside a flow run.
  const flowBound = setFlowWorktree(path, derived.branch)

  report(`Bootstrapping dependencies in ${path}...`)
  const bootstrap = await runBootstrap(pi, path, signal, report)

  const main = mainPath

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

  const lines = [
    `Worktree ready: ${derived.branch}`,
    `Path: ${path}`,
    `Flow base: ${base.branch} @ ${baseSha}`,
    `Workspace: ${workspaceId || '(unknown)'}`,
    `Bootstrap:\n${bootstrapLines}`,
    `Env files copied: ${envLine}`,
    `Next: cd ${path} && pi -c  (or spawn a subagent with cwd ${path})`,
  ]
  if (!flowBound) {
    lines.push(NO_ACTIVE_FLOW_WARNING)
  }
  const text = lines.join('\n')

  return textResult(text, {
    branch: derived.branch,
    path,
    workspaceId,
    bootstrap,
    envCopied,
    flowBound,
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

// AIDEV-NOTE: PMR-8JVY — re-bind an existing worktree to the active flow.
// Resume path: the implement skill reuses the worktree from the ticket's
// `worktree:` note without calling create, so nothing bound it and the
// review tool resolved its diff against the session checkout (empty range).
// AIDEV-NOTE: PMR-MQT2 — path is resolved against the session cwd (not the
// extension host's process.cwd()) and validated against herdr state, like
// removeFlow's "No Herdr worktree found" guard.
async function bindFlow(
  pi: ExtensionAPI,
  cwd: string,
  params: {
    path?: string
    branch?: string
  },
): Promise<ToolResult> {
  if (!params.path || !params.branch) {
    return errorResult("bind requires 'path' and 'branch'")
  }
  const wtPath = path.resolve(cwd, params.path)
  const stat = await fs.stat(wtPath).catch(() => null)
  if (!stat?.isDirectory()) {
    return errorResult(`No directory at ${wtPath}`)
  }
  const ref = getActiveFlowRef()
  if (ref === null) {
    return errorResult(
      `No active flow ref — nothing to bind to. ${NO_ACTIVE_FLOW_WARNING}`,
    )
  }
  let worktrees: HerdrWorktree[]
  try {
    worktrees = await worktreeList(pi, cwd)
  } catch (error) {
    return errorResult((error as Error).message)
  }
  const target = worktrees.find((wt) => wt.path === wtPath)
  if (!target) {
    return errorResult(`No Herdr worktree found at path ${wtPath}`)
  }
  if (target.branch !== params.branch) {
    return errorResult(
      `Herdr worktree at ${wtPath} is on branch ${target.branch}, not ${params.branch}`,
    )
  }
  const previous = getFlowWorktree()
  setFlowWorktree(wtPath, params.branch)
  let replaced = ''
  if (previous) {
    replaced = ` (replacing previous binding ${previous.path})`
  }
  return textResult(
    `Bound worktree ${wtPath} (${params.branch}) to flow ${ref}${replaced}`,
  )
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
    pruneNote = describePruneFailure(prune.stderr || prune.stdout)
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
      'Create, list, bind, or remove git worktrees managed as Herdr workspaces. Create derives a branch (from a Jira issue, a conventional name+type, or a literal), creates the Herdr worktree, bootstraps dependencies from the detected lockfile, copies missing .env* files from the main checkout. List shows a worktree/agent dashboard. Bind re-attaches an existing worktree to the active flow (resume path) so the review tool diffs it; remove guards against dirty worktrees.',
    promptSnippet:
      'Create/list/bind/remove git worktrees as Herdr workspaces for parallel work',
    promptGuidelines: [
      'Use worktree when implementing multiple features of the same repo in parallel — create a worktree before spawning a subagent with cwd set to the new worktree path.',
      'Use worktree list as a dashboard of worktrees and their running pi agent states.',
      'Create supports exactly one of jira_id, name (+type), or branch.',
      'Use bind when resuming a flow with an existing worktree (from the ticket worktree: note) — create binds automatically, resume must bind explicitly.',
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('create'),
          Type.Literal('list'),
          Type.Literal('bind'),
          Type.Literal('remove'),
        ],
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
          description:
            'Create mode 3: literal branch name; bind: branch the worktree is on (required)',
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
      path: Type.Optional(
        Type.String({
          description: 'bind: worktree path to bind to the active flow',
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
        action: 'create' | 'list' | 'bind' | 'remove'
        jira_id?: string
        name?: string
        type?: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor'
        branch?: string
        label?: string
        cwd?: string
        path?: string
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
      if (params.action === 'bind') {
        return bindFlow(pi, cwd, params)
      }
      return removeFlow(pi, cwd, params)
    },
  })
}
