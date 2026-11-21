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
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { recoveryCommand } from '../flow/binding-heal.ts'
import { DEFAULT_RECIPES } from '../flow/effect-gate.ts'
import {
  type FlowWorktree,
  getActiveFlowRef,
  getFlowWorktree,
  NO_ACTIVE_FLOW_WARNING,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import { createEffectJournal, type EffectJournal } from '../run-state.ts'
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
  type HerdrWorkspace,
  type HerdrWorktree,
  herdrAvailable,
  parseJson,
  pickString,
  workspaceClose,
  workspaceList,
  worktreeCreate,
  worktreeList,
  worktreeRemove,
} from './herdr.ts'
import {
  type BranchDeleteDecision,
  decideAutoBranchDelete,
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

// AIDEV-NOTE: PMR-VDVJ phase 5 — declare-before-act for worktree
// create/remove. The journal is resolved LAZILY: list/bind (and tests that
// don't opt in) never construct it, so no filesystem access happens on those
// paths. Fail-closed: a failed declaration refuses the action — for create
// the pre-recorded flow base is cleared (the existing create-failure revert),
// for remove the worktree is simply left intact (nothing to revert).
function resolveEffects(deps?: WorktreeDeps): EffectJournal {
  if (deps?.effects) {
    return deps.effects
  }
  return createEffectJournal(getAgentDir())
}

async function declareWorktreeEffect(
  effects: EffectJournal,
  ref: string,
  effect: 'worktree-create' | 'worktree-remove' | 'workspace-close',
  command: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const declared = await effects.declare({
    ref,
    effect,
    command,
    recipe: DEFAULT_RECIPES[effect],
  })
  if (!declared.ok) {
    return { ok: false, reason: declared.reason }
  }
  return { ok: true }
}

/** First `worktree <path>` entry of `git worktree list --porcelain`. */
async function mainCheckout(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<string> {
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
  effects: EffectJournal,
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

  // AIDEV-NOTE: PMR-VDVJ — declare the exact herdr argv BEFORE creating the
  // worktree (fail-closed): on declare failure the pre-recorded flow base is
  // cleared via the same revert the create-failure path uses, and no herdr
  // create call is made.
  const command = `herdr worktree create --cwd ${cwd} --branch ${derived.branch} --label ${label} --base ${baseSha}`
  const declared = await declareWorktreeEffect(
    effects,
    getActiveFlowRef() ?? 'worktree-ops',
    'worktree-create',
    command,
  )
  if (!declared.ok) {
    await clearFlowBase(execFn, mainPath, derived.branch)
    return errorResult(
      `worktree create refused: effect declaration failed (${declared.reason}) — fail-closed: the worktree was NOT created and the pre-recorded flow base was cleared`,
    )
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
  deps?: WorktreeDeps,
): Promise<ToolResult> {
  if (!params.path || !params.branch) {
    return errorResult("bind requires 'path' and 'branch'")
  }
  const wtPath = path.resolve(cwd, params.path)
  const stat = await fs.stat(wtPath).catch(() => null)
  if (!stat?.isDirectory()) {
    return errorResult(`No directory at ${wtPath}`)
  }
  let ref = getActiveFlowRef()
  let adopted = false
  if (ref === null) {
    // AIDEV-NOTE: PMR-DRKH — binding self-heal: with no active flow ref
    // (module state lost on pi reload), derive candidate refs from durable
    // pending records via the injected seam. Adoption only on exactly one
    // survivor (SINGLE-CANDIDATE-ONLY rule in flow/durable-refs.ts);
    // zero/absent seam keeps the original refusal byte-for-byte (worktree
    // tests assert it), multiple lists a per-ref recovery command.
    let candidates: string[] = []
    if (deps?.deriveFlowRefs) {
      candidates = await deps.deriveFlowRefs()
    }
    if (candidates.length === 0) {
      return errorResult(
        `No active flow ref — nothing to bind to. ${NO_ACTIVE_FLOW_WARNING}`,
      )
    }
    if (candidates.length > 1) {
      const lines = candidates.map((candidate) => {
        return `  ${recoveryCommand(candidate)} — ${candidate}`
      })
      return errorResult(
        `No active flow ref — multiple candidate flows found:\n${lines.join('\n')}\nRecover exactly one explicitly before binding.`,
      )
    }
    const candidate = candidates[0]
    if (candidate === undefined) {
      return errorResult(
        `No active flow ref — nothing to bind to. ${NO_ACTIVE_FLOW_WARNING}`,
      )
    }
    ref = candidate
    adopted = true
    setActiveFlowRef(ref)
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
  let adoptedNote = ''
  if (adopted) {
    adoptedNote = ' (ref adopted from pending flow state)'
  }
  return textResult(
    `Bound worktree ${wtPath} (${params.branch}) to flow ${ref}${replaced}${adoptedNote}`,
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

// AIDEV-NOTE: remove guards order per spec (now in removeWorktreeCore) —
// branch captured BEFORE removal (branch ref only exists while the worktree
// checkout does); PR merge state via gh checked BEFORE herdr removal so a
// refused branch delete leaves the worktree untouched. `git branch -D`
// (not -d) because squash merges look unmerged to git's ancestry check.
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

// AIDEV-NOTE: PMR-K0ZV/PMR-VDVJ phase 5 — the removal core takes an EXPLICIT
// ref for the effect declaration: the auto path clears the active flow ref
// before cleanup runs, so the caller passes the captured ref; the manual
// wrapper passes getActiveFlowRef() ?? 'worktree-ops'.
// Decision injection (PMR-81SX fix round): opts.branchDecision, when
// present, replaces the ghPrState + decideBranchDelete re-derivation —
// manual removeFlow passes no decision (re-derive as always); the auto
// cleanup path injects ONLY a 'delete' verdict (its keep verdicts never
// reach the core — deleteBranch stays false so the default skip note
// reproduces byte-identically). AutoBranchDeleteDecision has no 'refuse'
// variant, so the manual path's refuse handling stays where the refuse
// decisions actually originate: the re-derivation branch.
export type RemoveWorktreeOpts = {
  path: string
  force: boolean
  deleteBranch: boolean
  ref: string
  // AIDEV-NOTE: PMR-81SX fix round — pre-made branch-delete decision for the
  // AUTO path. Only the 'delete' verdict is injectable: keep verdicts never
  // reach the core (cleanupFlowWorktree skips injection for keep-branch/
  // keep-all), and AutoBranchDeleteDecision has no 'refuse' variant, so a
  // refuse can only arise on the manual re-derivation path below.
  branchDecision?: { action: 'delete' }
}

export type RemoveWorktreeResult = {
  removed: string
  branch: string
  branchDeleted: boolean
  branchNote: string
  pruneNote: string
  prState: PrState | undefined
  force: boolean
}

export async function removeWorktreeCore(
  pi: ExtensionAPI,
  effects: EffectJournal,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
  opts: RemoveWorktreeOpts,
): Promise<RemoveWorktreeResult | { error: string }> {
  const path = opts.path
  // Branch must be captured before removal — after `herdr worktree remove`
  // the checkout (and its HEAD) is gone, but the branch ref remains.
  const branchResult = await pi.exec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: path },
  )
  if (branchResult.code !== 0) {
    return {
      error: `git rev-parse failed in ${path}: ${branchResult.stderr || branchResult.stdout}`,
    }
  }
  const branch = branchResult.stdout.trim()

  const force = opts.force
  const status = await pi.exec('git', ['status', '--porcelain'], {
    cwd: path,
  })
  if (status.code !== 0) {
    return {
      error: `git status failed in ${path}: ${status.stderr || status.stdout}`,
    }
  }
  const dirtyCount = status.stdout
    .split('\n')
    .filter((line) => line.trim() !== '').length
  if (dirtyCount > 0 && !force) {
    return {
      error: `${path} is dirty (${dirtyCount} changed files) — pass force: true to remove anyway`,
    }
  }

  const preflight = await herdrAvailable(pi, cwd)
  if (!preflight.ok) {
    return {
      error: `${preflight.error}\nThe worktree tool must run inside a Herdr session with herdr on PATH.`,
    }
  }

  let worktrees: HerdrWorktree[]
  try {
    worktrees = await worktreeList(pi, cwd)
  } catch (error) {
    return { error: (error as Error).message }
  }
  const target = worktrees.find((wt) => wt.path === path)
  if (!target) {
    return { error: `No Herdr worktree found at path ${path}` }
  }

  const main = await mainCheckout(pi, cwd)

  // PR state resolved BEFORE removal so a refused branch delete aborts
  // with the worktree intact.
  let decision: BranchDeleteDecision = {
    action: 'skip',
    reason: 'delete_branch not requested',
  }
  let prState: PrState | undefined
  if (opts.branchDecision !== undefined) {
    // Auto path: caller already decided — never re-derive via gh/decideBranchDelete.
    // Only a 'delete' verdict is injectable (AutoBranchDeleteDecision has no
    // 'refuse' variant and keep verdicts never reach the core), so there is
    // no refuse handling here: a manual-tool 'Pass force: true' suggestion
    // would be wrong vocabulary on the auto path anyway.
    decision = opts.branchDecision
  } else if (opts.deleteBranch) {
    // Manual path: re-derive PR state and consult the manual guard.
    prState = await ghPrState(pi, main, branch)
    decision = decideBranchDelete({
      deleteBranchRequested: true,
      prState,
      force,
    })
    if (decision.action === 'refuse') {
      return {
        error: `Refusing to remove: branch ${branch} not deletable — ${decision.reason}.\nPass force: true to remove anyway.`,
      }
    }
  }

  // AIDEV-NOTE: PMR-VDVJ — declare the exact herdr argv BEFORE removing
  // (fail-closed): on declare failure the worktree is left intact — nothing
  // to revert, the PR-state guard already ran before this point.
  let removeCommand = `herdr worktree remove --workspace ${target.workspaceId}`
  if (force) {
    removeCommand = `${removeCommand} --force`
  }
  const declared = await declareWorktreeEffect(
    effects,
    opts.ref,
    'worktree-remove',
    removeCommand,
  )
  if (!declared.ok) {
    return {
      error: `worktree remove refused: effect declaration failed (${declared.reason}) — fail-closed: the worktree was left intact`,
    }
  }

  try {
    await worktreeRemove(pi, cwd, target.workspaceId, force)
  } catch (error) {
    return { error: (error as Error).message }
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

  return {
    removed: path,
    branch,
    branchDeleted,
    branchNote,
    pruneNote,
    prState,
    force,
  }
}

// AIDEV-NOTE: PMR-81SX — auto-cleanup at flow done (phase 5 of PMR-81SX).
// Contract: NEVER throws (each fallible step is locally caught; callers also
// catch as belt-and-braces). Fail-closed defer semantics: dirty worktree,
// any matched in-flight agent (including unknown agent_status — herdr's state
// strings are not enumerated in code, so ANY matched agent defers), or an
// agentList failure all keep the worktree untouched. Halt/pause never reach
// this code — only the done path calls it. Merged-proof is RE-DERIVED here
// (git merge-base --is-ancestor in the main checkout) because the loop's
// mergeAuthorized proves authorization only, not that the merge actually
// executed on the main checkout.
export type CleanupFlowWorktreeInput = {
  ref: string
  mode: 'work' | 'personal'
  worktree: FlowWorktree | undefined
  // PMR-YG2N fix round — session cwd when invoked from the /flow done
  // branch; undefined (process cwd) on the loop done path.
  cwd: string | undefined
  annotate?: (ref: string, body: string) => Promise<void>
}

export type CleanupFlowWorktreeSummary = {
  action: 'noop' | 'deferred' | 'kept-all' | 'removed'
  reason: string
}

export async function cleanupFlowWorktree(
  pi: ExtensionAPI,
  effects: EffectJournal,
  input: CleanupFlowWorktreeInput,
): Promise<CleanupFlowWorktreeSummary> {
  // AIDEV-NOTE (PMR-W6C4): every non-removed outcome is made human-visible
  // via a best-effort annotation naming the path and reason — otherwise a
  // superseded stale worktree is kept with no trace at all, undermining the
  // no-lingering-worktrees goal. The ONE exception is the trivial
  // 'no flow worktree bound' noop: nothing exists, and annotating every
  // worktree-less flow done would spam the ticket.
  const annotateOutcome = async (
    action: CleanupFlowWorktreeSummary['action'],
    reason: string,
    pathForNote: string | undefined,
  ): Promise<CleanupFlowWorktreeSummary> => {
    if (input.annotate) {
      try {
        const pathText = pathForNote ?? 'unknown path'
        await input.annotate(
          input.ref,
          `worktree cleanup ${action} (${pathText}): ${reason}`,
        )
      } catch {
        // best-effort
      }
    }
    return { action, reason }
  }
  try {
    if (input.worktree === undefined) {
      return { action: 'noop', reason: 'no flow worktree bound' }
    }
    // Fail-closed binding invariant (PMR-81SX fix round): after a /flow
    // supersede, a stale binding from the prior flow can still be attached —
    // never remove another flow's worktree or branch -D its branch under
    // this flow's effect-journal ref / annotation.
    if (input.worktree.ref !== input.ref) {
      return annotateOutcome(
        'noop',
        `worktree binding belongs to flow ${input.worktree.ref}, not ${input.ref} — not cleaning up`,
        input.worktree.path,
      )
    }
    const wtPath = input.worktree.path
    const wtBranch = input.worktree.branch

    // Step 2: dirty guard (cheap short-circuit before the in-flight check;
    // the removal core has its own guard, this skip happens even earlier).
    const status = await pi.exec('git', ['status', '--porcelain'], {
      cwd: wtPath,
    })
    if (status.stdout.trim() !== '') {
      return annotateOutcome('deferred', `worktree ${wtPath} is dirty`, wtPath)
    }

    // Step 3: in-flight guard — fail-closed. Any matched agent defers,
    // regardless of its agent_status string (unknown-means-live policy).
    let agents: HerdrAgent[]
    try {
      agents = await agentList(pi, input.cwd)
    } catch {
      return annotateOutcome(
        'deferred',
        'herdr agent list unavailable — cannot prove no agent is in-flight',
        wtPath,
      )
    }
    let worktrees: HerdrWorktree[]
    try {
      worktrees = await worktreeList(pi, input.cwd)
    } catch (error) {
      return annotateOutcome(
        'deferred',
        `herdr worktree list failed: ${(error as Error).message}`,
        wtPath,
      )
    }
    const target = worktrees.find((wt) => wt.path === wtPath)
    if (!target) {
      return annotateOutcome(
        'deferred',
        `no Herdr worktree found at ${wtPath}`,
        wtPath,
      )
    }
    const joined = joinAgents([target], agents)
    let agent = joined.get(target)
    // AIDEV-NOTE (PMR-F5HB): the flow session's OWN herdr agent must not
    // self-match the in-flight guard — when the session runs INSIDE the flow
    // worktree, its own agent row carries the worktree cwd/workspace and
    // would defer cleanup forever. Identify self by pane id: herdr exposes
    // the current pane via HERDR_PANE_ID ('<workspaceId>:<paneId>') and
    // agentList carries pane_id per agent. Subagent children live on their
    // own panes and still match (and defer) as before.
    const herdrPane = process.env.HERDR_PANE_ID?.trim()
    let ownPaneId = ''
    if (herdrPane?.includes(':') === true) {
      ownPaneId = herdrPane.slice(herdrPane.indexOf(':') + 1)
    }
    if (agent !== undefined && ownPaneId !== '' && agent.pane === ownPaneId) {
      agent = undefined
    }
    if (agent) {
      let agentState = agent.state
      if (agentState === '') {
        agentState = 'unknown'
      }
      return annotateOutcome(
        'deferred',
        `agent '${agent.name}' (state: ${agentState}) may still be in-flight in ${wtPath}`,
        wtPath,
      )
    }

    // Step 4: main checkout + merge proof / PR state.
    let main: string
    try {
      main = await mainCheckout(pi, input.cwd)
    } catch (error) {
      return annotateOutcome(
        'deferred',
        `cannot resolve main checkout: ${(error as Error).message}`,
        wtPath,
      )
    }
    let prState: PrState = 'NO_PR'
    let localMergedProof = false
    if (input.mode === 'personal') {
      const proof = await pi.exec(
        'git',
        ['merge-base', '--is-ancestor', wtBranch, 'main'],
        { cwd: main },
      )
      if (proof.code === 0) {
        localMergedProof = true
      }
    } else {
      prState = await ghPrState(pi, main, wtBranch)
    }

    // Step 5: auto branch-delete decision (phase 3 helper).
    const decision = decideAutoBranchDelete({
      mode: input.mode,
      prState,
      localMergedProof,
    })
    if (decision.action === 'keep-all') {
      let reviewedAt = ''
      try {
        const head = await pi.exec('git', ['rev-parse', 'HEAD'], {
          cwd: wtPath,
        })
        if (head.code === 0) {
          reviewedAt = head.stdout.trim()
        }
      } catch {
        // best-effort: sha omitted when rev-parse fails
      }
      let note = `worktree kept (${wtPath}): ${decision.reason}`
      if (reviewedAt !== '') {
        note = `${note} — merged-proof/PR state unproven, reviewed-at: ${reviewedAt}`
      }
      if (input.annotate) {
        try {
          await input.annotate(input.ref, note)
        } catch {
          // best-effort
        }
      }
      return { action: 'kept-all', reason: decision.reason }
    }

    // Step 6: removal via the phase-3 core, with the EXPLICIT flow ref for
    // the worktree-remove declaration (never the 'worktree-ops' fallback).
    // AIDEV-NOTE: decision injection — the AUTO decision computed in step 5
    // is passed verbatim (branchDecision) so the core's manual NO_PR/
    // GH_MISSING re-derivation never vetoes a personal delete (personal
    // flows never have PRs). For 'keep-branch' no decision is injected:
    // deleteBranch is false, so the core's default skip ('delete_branch not
    // requested') reproduces the previous note byte-identically.
    let branchDecision: { action: 'delete' } | undefined
    if (decision.action === 'delete') {
      branchDecision = { action: 'delete' }
    }
    const removed = await removeWorktreeCore(pi, effects, input.cwd, {
      path: wtPath,
      force: false,
      deleteBranch: decision.action === 'delete',
      ref: input.ref,
      branchDecision,
    })
    if ('error' in removed) {
      return annotateOutcome(
        'deferred',
        `worktree removal failed: ${removed.error}`,
        wtPath,
      )
    }

    // Step 7: post-removal chores — clear the stale flow-base config from the
    // MAIN checkout (PMR-182S gap), then annotate the outcome.
    const execFn = (c: string, a: string[], o?: { cwd?: string }) =>
      pi.exec(c, a, o)
    try {
      await clearFlowBase(execFn, main, wtBranch)
    } catch {
      // best-effort: stale config keys are harmless
    }
    let branchWord = 'kept'
    if (removed.branchDeleted) {
      branchWord = 'deleted'
    }
    let outcomeReason = 'work mode'
    if (input.mode === 'personal') {
      outcomeReason = 'personal mode'
    }
    if (decision.action === 'keep-branch') {
      outcomeReason = decision.reason
    }
    if (input.annotate) {
      try {
        await input.annotate(
          input.ref,
          `worktree removed (${wtPath}), branch ${branchWord}: ${wtBranch} (${outcomeReason})`,
        )
      } catch {
        // best-effort
      }
    }

    return {
      action: 'removed',
      reason: `removed ${wtPath}; ${removed.branchNote}; ${removed.pruneNote}`,
    }
  } catch (error) {
    // Never throw — the loop's own catch is belt-and-braces.
    return annotateOutcome(
      'deferred',
      `cleanup error (non-fatal): ${(error as Error).message}`,
      input.worktree?.path,
    )
  }
}

async function removeFlow(
  pi: ExtensionAPI,
  effects: EffectJournal,
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
  const result = await removeWorktreeCore(pi, effects, cwd, {
    path: params.cwd,
    force: params.force === true,
    deleteBranch: params.delete_branch === true,
    ref: getActiveFlowRef() ?? 'worktree-ops',
  })
  if ('error' in result) {
    return errorResult(result.error)
  }
  const text = [
    `Removed worktree at ${result.removed}.`,
    result.branchNote,
    result.pruneNote,
  ].join('\n')
  return textResult(text, {
    removed: result.removed,
    branch: result.branch,
    branchDeleted: result.branchDeleted,
    prState: result.prState,
    force: result.force,
  })
}

// AIDEV-NOTE: PMR-DMZR — one entry per workspace in the prune result:
// 'closed' workspaces were proven dangling and closed; every 'skipped'
// entry carries the failing check verbatim (fail-closed visibility —
// anything not closed must say why).
export type PruneEntry = {
  workspaceId: string
  label: string
  checkoutPath: string
  outcome: 'closed' | 'skipped'
  reason: string
}

// AIDEV-NOTE: PMR-DMZR — prune closes only PROVEN-dangling herdr workspaces
// (herdr's workspace registry never learns that pi-flow's sweep removed the
// git worktree underneath it). A workspace is closed ONLY when ALL hold:
// (a) worktree provenance with a checkout_path, (b) checkout_path missing on
// disk, (c) path absent from `herdr worktree list`, (d) no agent attached —
// same fail-closed unknown-means-live policy as cleanupFlowWorktree's
// in-flight guard, including the PMR-F5HB self-pane exclusion
// (HERDR_PANE_ID). ANY failure to list workspaces/agents/worktrees aborts
// the whole run before a single close (fail-closed). Declare-before-act
// (PMR-VDVJ): the exact `herdr workspace close <id>` argv is journaled
// under the 'workspace-close' effect kind before each close.
async function pruneFlow(
  pi: ExtensionAPI,
  effects: EffectJournal,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<ToolResult> {
  const preflight = await herdrAvailable(pi, cwd)
  if (!preflight.ok) {
    return errorResult(
      `${preflight.error}\nThe worktree tool must run inside a Herdr session with herdr on PATH.`,
    )
  }

  // Fail-closed: every list must succeed or NOTHING is closed.
  let workspaces: HerdrWorkspace[]
  try {
    workspaces = await workspaceList(pi, cwd)
  } catch (error) {
    return errorResult(`prune aborted: ${(error as Error).message}`)
  }
  let worktrees: HerdrWorktree[]
  try {
    worktrees = await worktreeList(pi, cwd)
  } catch (error) {
    return errorResult(`prune aborted: ${(error as Error).message}`)
  }
  let agents: HerdrAgent[]
  try {
    agents = await agentList(pi, cwd)
  } catch (error) {
    return errorResult(`prune aborted: ${(error as Error).message}`)
  }

  // AIDEV-NOTE (PMR-F5HB): same self-pane identification as
  // cleanupFlowWorktree — HERDR_PANE_ID is '<workspaceId>:<paneId>' and
  // agentList carries pane_id per agent; the session's own agent row must
  // not pin its workspace via the attach check.
  const herdrPane = process.env.HERDR_PANE_ID?.trim()
  let ownPaneId = ''
  if (herdrPane?.includes(':') === true) {
    ownPaneId = herdrPane.slice(herdrPane.indexOf(':') + 1)
  }

  const wtPaths = new Set(worktrees.map((wt) => wt.path))
  const ref = getActiveFlowRef() ?? 'worktree-ops'
  const entries: PruneEntry[] = []

  for (const ws of workspaces) {
    const entry: PruneEntry = {
      workspaceId: ws.workspaceId,
      label: ws.label,
      checkoutPath: ws.checkoutPath,
      outcome: 'skipped',
      reason: '',
    }
    // (a) provenance: only worktree-backed records are candidates.
    if (ws.checkoutPath === '') {
      entry.reason = 'no worktree provenance (not worktree-backed)'
      entries.push(entry)
      continue
    }
    // herdr workspace close needs a target id; a provenance record without
    // one cannot be closed (defensive-parse '' degrades to a skip).
    if (ws.workspaceId === '') {
      entry.reason = 'workspace id missing — cannot close'
      entries.push(entry)
      continue
    }
    // (b) the checkout must be gone from disk. AIDEV-NOTE: PMR-SK1W —
    // only ENOENT proves the checkout is missing; EACCES/ELOOP/transient
    // stat errors mean it MAY still exist, so skip with the error named
    // (fail-closed: unknown-means-live, never close an unstatable path).
    let checkoutMissing = false
    try {
      await fs.stat(ws.checkoutPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        checkoutMissing = true
      } else {
        entry.reason = `cannot stat checkout path (${(error as Error).message}) — treating as live`
        entries.push(entry)
        continue
      }
    }
    if (!checkoutMissing) {
      entry.reason = 'checkout path exists on disk'
      entries.push(entry)
      continue
    }
    // (c) herdr must not still track the worktree for this path.
    if (wtPaths.has(ws.checkoutPath)) {
      entry.reason = 'checkout path still present in herdr worktree list'
      entries.push(entry)
      continue
    }
    // (d) no agent attached (self-pane rows excluded first; ANY matched
    // agent defers regardless of its agent_status — unknown-means-live).
    let attached: HerdrAgent | undefined
    for (const agent of agents) {
      if (ownPaneId !== '' && agent.pane === ownPaneId) {
        continue
      }
      if (agent.workspaceId !== '' && agent.workspaceId === ws.workspaceId) {
        attached = agent
        break
      }
      if (
        agent.cwd !== undefined &&
        agent.cwd.startsWith(ws.checkoutPath) === true
      ) {
        attached = agent
        break
      }
    }
    if (attached !== undefined) {
      let agentState = attached.state
      if (agentState === '') {
        agentState = 'unknown'
      }
      entry.reason = `agent '${attached.name}' (state: ${agentState}) may still be in-flight`
      entries.push(entry)
      continue
    }
    // Declare the exact argv BEFORE acting (fail-closed per workspace).
    const command = `herdr workspace close ${ws.workspaceId}`
    const declared = await declareWorktreeEffect(
      effects,
      ref,
      'workspace-close',
      command,
    )
    if (!declared.ok) {
      entry.reason = `effect declaration failed (${declared.reason}) — workspace left untouched`
      entries.push(entry)
      continue
    }
    try {
      await workspaceClose(pi, cwd, ws.workspaceId)
    } catch (error) {
      entry.reason = (error as Error).message
      entries.push(entry)
      continue
    }
    entry.outcome = 'closed'
    entry.reason = `closed dangling workspace (checkout ${ws.checkoutPath} missing on disk, absent from herdr worktree list, no agents attached)`
    entries.push(entry)
  }

  const closed = entries.filter((e) => e.outcome === 'closed')
  const skipped = entries.filter((e) => e.outcome === 'skipped')
  const lines = [
    `Prune complete: ${closed.length} closed, ${skipped.length} skipped.`,
  ]
  if (closed.length > 0) {
    lines.push('', 'closed:')
    for (const e of closed) {
      lines.push(`  ${e.workspaceId} ${e.label} — ${e.reason}`)
    }
  }
  if (skipped.length > 0) {
    lines.push('', 'skipped:')
    for (const e of skipped) {
      lines.push(`  ${e.workspaceId} ${e.label} — ${e.reason}`)
    }
  }
  return textResult(lines.join('\n'), {
    entries,
    closed: closed.length,
    skipped: skipped.length,
  })
}

// AIDEV-NOTE: PMR-DRKH — optional deriveFlowRefs seam for bind-time
// self-heal; inject a scanner here from pi-flow/index.ts (real) or tests
// (fake). Absent seam = zero candidates = original refusal.
export interface WorktreeDeps {
  effects?: EffectJournal
  deriveFlowRefs?: () => Promise<string[]>
}

export default function (pi: ExtensionAPI, deps?: WorktreeDeps) {
  pi.registerTool({
    name: 'worktree',
    label: 'Worktree',
    description:
      'Create, list, bind, or remove git worktrees managed as Herdr workspaces. Create derives a branch (from a Jira issue, a conventional name+type, or a literal), creates the Herdr worktree, bootstraps dependencies from the detected lockfile, copies missing .env* files from the main checkout. List shows a worktree/agent dashboard. Bind re-attaches an existing worktree to the active flow (resume path) so the review tool diffs it; remove guards against dirty worktrees. Prune closes herdr workspaces proven dangling (checkout removed outside herdr); each close is declared in the effect journal before acting.',
    promptSnippet:
      'Create/list/bind/remove/prune git worktrees as Herdr workspaces for parallel work',
    promptGuidelines: [
      'Use worktree when implementing multiple features of the same repo in parallel — create a worktree before spawning a subagent with cwd set to the new worktree path.',
      'Use worktree list as a dashboard of worktrees and their running pi agent states.',
      'Create supports exactly one of jira_id, name (+type), or branch.',
      'Use bind when resuming a flow with an existing worktree (from the ticket worktree: note) — create binds automatically, resume must bind explicitly.',
      'Use prune at the end of a flow to close herdr workspaces whose checkout directories were already removed — only proven-dangling workspaces are closed, everything else is skipped with a reason.',
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('create'),
          Type.Literal('list'),
          Type.Literal('bind'),
          Type.Literal('remove'),
          Type.Literal('prune'),
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
        action: 'create' | 'list' | 'bind' | 'remove' | 'prune'
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
        return createFlow(
          pi,
          resolveEffects(deps),
          cwd,
          params,
          signal,
          onUpdate,
        )
      }
      if (params.action === 'list') {
        return listFlow(pi, cwd)
      }
      if (params.action === 'bind') {
        return bindFlow(pi, cwd, params, deps)
      }
      if (params.action === 'prune') {
        return pruneFlow(pi, resolveEffects(deps), cwd)
      }
      return removeFlow(pi, resolveEffects(deps), cwd, params)
    },
  })
}
