/**
 * Exec wrappers around the Herdr CLI (`herdr worktree` / `herdr agent`).
 *
 * AIDEV-NOTE: herdr JSON shapes are defensive-parse territory (plan risk
 * section). Field-name variants observed on herdr 0.8.2 are documented at
 * each pick site; every field is optional during narrowing so a minor
 * herdr release that renames a field degrades to "" instead of crashing.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface HerdrWorktree {
  path: string
  branch: string
  label: string
  workspaceId: string
  isLinked: boolean
}

export interface HerdrAgent {
  name: string
  state: string
  pane: string
  workspaceId?: string
  cwd?: string
}

/** Workspace record from `herdr workspace list` (PMR-DMZR). */
export interface HerdrWorkspace {
  workspaceId: string
  label: string
  agentStatus: string
  // Worktree provenance — '' when the workspace is not worktree-backed.
  checkoutPath: string
  isLinkedWorktree: boolean
  repoKey: string
  repoName: string
  repoRoot: string
}

/** JSON.parse with a never-throw contract; returns null on non-JSON. */
export function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    return null
  }
}

/**
 * First truthy string among candidate keys (optionally nested one level,
 * e.g. "workspace.id"). NO any — obj stays unknown throughout.
 */
export function pickString(obj: unknown, keys: string[]): string {
  if (typeof obj !== 'object' || obj === null) {
    return ''
  }
  const record = obj as Record<string, unknown>
  for (const key of keys) {
    let value: unknown = record[key]
    if (key.includes('.')) {
      const [outer, inner] = key.split('.')
      const nested = record[outer]
      if (typeof nested !== 'object' || nested === null) {
        continue
      }
      value = (nested as Record<string, unknown>)[inner]
    }
    if (typeof value === 'string' && value !== '') {
      return value
    }
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * AIDEV-NOTE: is_linked_worktree defaults to TRUE when absent — herdr
 * 0.8.2 always emits it, but if a future herdr drops the field the
 * dashboard should still list worktrees (someone created them via this
 * tool) rather than silently hiding everything. Explicit false (the main
 * checkout row) is the only thing filtered out.
 */
function pickLinked(entry: unknown): boolean {
  if (isRecord(entry) && entry.is_linked_worktree === false) {
    return false
  }
  return true
}

/** Keep only linked worktrees (drops the main checkout row). */
export function filterLinked(worktrees: HerdrWorktree[]): HerdrWorktree[] {
  return worktrees.filter((wt) => wt.isLinked)
}

/** Extract the `{result: ...}` envelope; the payload itself when absent. */
export function extractResult(root: unknown): unknown {
  if (isRecord(root) && isRecord(root.result)) {
    return root.result
  }
  return root
}

/** Extract the payload array from `{result: {<key>: [...]}}`-style output. */
function pickArray(root: unknown, key: string): unknown[] {
  const result = isRecord(root) ? root.result : null
  if (!isRecord(result)) {
    return []
  }
  const arr = result[key]
  if (!Array.isArray(arr)) {
    return []
  }
  return arr
}

// AIDEV-NOTE: PMR-PMPF — distinguishes "herdr reported zero workspaces"
// (explicit empty array) from "payload has no workspaces array at all"
// (envelope renamed upstream). pickArray alone conflates the two into [].
function hasWorkspacesArray(root: unknown): boolean {
  const result = isRecord(root) ? root.result : null
  if (!isRecord(result)) {
    return false
  }
  return Array.isArray(result.workspaces)
}

/**
 * Preflight: `herdr worktree list` exit 0 proves binary exists, socket
 * reachable, and HERDR_ENV guardrail passes. Failure surfaces stderr
 * verbatim (covers missing binary AND outside-Herdr refusal).
 */
export async function herdrAvailable(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await pi.exec('herdr', ['worktree', 'list'], { cwd })
  if (result.code === 0) {
    return { ok: true }
  }
  const detail = result.stderr || result.stdout || `exit code ${result.code}`
  return { ok: false, error: `herdr preflight failed: ${detail}` }
}

/** Map a parsed `herdr worktree list` payload onto HerdrWorktree[]. */
export function parseWorktrees(root: unknown): HerdrWorktree[] {
  // AIDEV-NOTE: herdr 0.8.2 emits {result:{worktrees:[{branch,path,label,
  // open_workspace_id,is_linked_worktree,...}]}}. Variants tolerated:
  // workspace_id, id, and nested workspace.id for the workspace key.
  return pickArray(root, 'worktrees').map((entry) => ({
    path: pickString(entry, ['path', 'worktree_path', 'checkout_path']),
    branch: pickString(entry, ['branch', 'head', 'ref']),
    label: pickString(entry, ['label', 'name']),
    workspaceId: pickString(entry, [
      'open_workspace_id',
      'workspace_id',
      'id',
      'workspace.id',
    ]),
    isLinked: pickLinked(entry),
  }))
}

export async function worktreeList(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<HerdrWorktree[]> {
  const result = await pi.exec('herdr', ['worktree', 'list'], { cwd })
  if (result.code !== 0) {
    throw new Error(
      `herdr worktree list failed: ${result.stderr || result.stdout}`,
    )
  }
  const parsed = parseJson(result.stdout)
  if (parsed === null) {
    throw new Error(
      `herdr worktree list returned non-JSON: ${result.stdout.slice(-200)}`,
    )
  }
  return parseWorktrees(parsed)
}

/** Parse `herdr worktree create` stdout — pure, fixture-tested. */
export function parseCreateResult(stdout: string): {
  path: string
  workspaceId: string
} {
  // AIDEV-NOTE: live shape captured on herdr 0.8.2 (smoke test 4.2):
  // {result:{worktree:{path,branch,open_workspace_id,...},workspace:{...}}}.
  // Flat fallback keys kept for tolerance.
  const payload: unknown = extractResult(parseJson(stdout))
  return {
    path: pickString(payload, [
      'worktree.path',
      'path',
      'worktree_path',
      'checkout_path',
    ]),
    workspaceId: pickString(payload, [
      'worktree.open_workspace_id',
      'workspace_id',
      'open_workspace_id',
      'id',
      'workspace.id',
    ]),
  }
}

// AIDEV-NOTE: PMR-R4AP — always pass --base <sha>: without it herdr branches
// from the HEAD of --cwd, which is NOT necessarily the main checkout's branch
// (e.g. session running inside another worktree).
export function worktreeCreateArgs(
  cwd: string,
  branch: string,
  label: string,
  baseSha?: string,
): string[] {
  const args = [
    'worktree',
    'create',
    '--cwd',
    cwd,
    '--branch',
    branch,
    '--label',
    label,
  ]
  if (baseSha !== undefined) {
    args.push('--base', baseSha)
  }
  return args
}

export async function worktreeCreate(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
  label: string,
  baseSha?: string,
): Promise<{ path: string; workspaceId: string }> {
  const result = await pi.exec(
    'herdr',
    worktreeCreateArgs(cwd, branch, label, baseSha),
    {
      cwd,
    },
  )
  if (result.code !== 0) {
    throw new Error(
      `herdr worktree create failed: ${result.stderr || result.stdout}`,
    )
  }
  return parseCreateResult(result.stdout)
}

export async function worktreeRemove(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
  workspaceId: string,
  force: boolean,
): Promise<void> {
  const args = ['worktree', 'remove', '--workspace', workspaceId]
  if (force) {
    args.push('--force')
  }
  const result = await pi.exec('herdr', args, { cwd })
  if (result.code !== 0) {
    throw new Error(
      `herdr worktree remove failed: ${result.stderr || result.stdout}`,
    )
  }
}

export async function agentList(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<HerdrAgent[]> {
  const result = await pi.exec('herdr', ['agent', 'list'], { cwd })
  if (result.code !== 0) {
    throw new Error(
      `herdr agent list failed: ${result.stderr || result.stdout}`,
    )
  }
  const parsed = parseJson(result.stdout)
  if (parsed === null) {
    throw new Error(
      `herdr agent list returned non-JSON: ${result.stdout.slice(-200)}`,
    )
  }
  // AIDEV-NOTE: herdr 0.8.2 emits {result:{agents:[{agent,agent_status,
  // pane_id,workspace_id,cwd,...}]}}. Variants tolerated: name, state, pane.
  return pickArray(parsed, 'agents')
    .map((entry) => {
      const workspaceId = pickString(entry, ['workspace_id', 'workspace.id'])
      const cwdField = pickString(entry, ['cwd', 'working_dir'])
      const agent: HerdrAgent = {
        name: pickString(entry, ['agent', 'name']),
        state: pickString(entry, ['agent_status', 'state', 'status']),
        pane: pickString(entry, ['pane_id', 'pane']),
      }
      if (workspaceId !== '') {
        agent.workspaceId = workspaceId
      }
      if (cwdField !== '') {
        agent.cwd = cwdField
      }
      return agent
    })
    .filter((agent) => agent.name !== '')
}

/**
 * AIDEV-NOTE: PMR-DMZR — worktree provenance block nested on worktree-backed
 * workspace records (live shape on herdr 0.8.2: worktree.checkout_path,
 * worktree.is_linked_worktree, worktree.repo_key, worktree.repo_name,
 * worktree.repo_root). Variants tolerated: work_tree for the block key.
 * Returns null for plain-directory workspaces — the prune action's
 * provenance check then fails closed (never closes a dir: workspace).
 */
function pickWorktreeProvenance(
  entry: unknown,
): Record<string, unknown> | null {
  if (!isRecord(entry)) {
    return null
  }
  for (const key of ['worktree', 'work_tree']) {
    const nested = entry[key]
    if (isRecord(nested)) {
      return nested
    }
  }
  return null
}

/** Map a parsed `herdr workspace list` payload onto HerdrWorkspace[]. */
export function parseWorkspaces(root: unknown): HerdrWorkspace[] {
  // AIDEV-NOTE: PMR-DMZR — herdr 0.8.2 emits {result:{type:'workspace_list',
  // workspaces:[{workspace_id,label,agent_status,...,worktree?:{...}}]}}.
  // Variants tolerated: id / workspace.id for the workspace key, name for
  // the label, status/state for the agent status. Without a provenance
  // block, checkoutPath stays '' and isLinkedWorktree stays false.
  return pickArray(root, 'workspaces').map((entry) => {
    const workspace: HerdrWorkspace = {
      workspaceId: pickString(entry, ['workspace_id', 'id', 'workspace.id']),
      label: pickString(entry, ['label', 'name']),
      agentStatus: pickString(entry, ['agent_status', 'status', 'state']),
      checkoutPath: '',
      isLinkedWorktree: false,
      repoKey: '',
      repoName: '',
      repoRoot: '',
    }
    const provenance = pickWorktreeProvenance(entry)
    if (provenance !== null) {
      workspace.checkoutPath = pickString(provenance, ['checkout_path', 'path'])
      workspace.isLinkedWorktree = pickLinked(provenance)
      workspace.repoKey = pickString(provenance, ['repo_key', 'key'])
      workspace.repoName = pickString(provenance, ['repo_name', 'name'])
      workspace.repoRoot = pickString(provenance, ['repo_root', 'root'])
    }
    return workspace
  })
}

export async function workspaceList(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
): Promise<HerdrWorkspace[]> {
  const result = await pi.exec('herdr', ['workspace', 'list'], { cwd })
  if (result.code !== 0) {
    throw new Error(
      `herdr workspace list failed: ${result.stderr || result.stdout}`,
    )
  }
  const parsed = parseJson(result.stdout)
  if (parsed === null) {
    throw new Error(
      `herdr workspace list returned non-JSON: ${result.stdout.slice(-200)}`,
    )
  }
  const workspaces = parseWorkspaces(parsed)
  // AIDEV-NOTE: PMR-PMPF — zero parsed workspaces is only acceptable when
  // the payload carries a recognizable workspaces array (an explicit empty
  // list). If a future herdr renames the result.workspaces envelope, parsing
  // would silently yield [] and prune would report a clean 0-closed/0-skipped
  // no-op, resurrecting the PMR-DMZR silent-dangling bug. Fail loudly.
  if (workspaces.length === 0 && !hasWorkspacesArray(parsed)) {
    throw new Error(
      `herdr workspace list payload has no recognizable workspaces array — refusing to treat it as zero workspaces: ${result.stdout.slice(-200)}`,
    )
  }
  return workspaces
}

export async function workspaceClose(
  pi: ExtensionAPI,
  // PMR-YG2N fix round — undefined = process cwd (loop done path).
  cwd: string | undefined,
  workspaceId: string,
): Promise<void> {
  const result = await pi.exec('herdr', ['workspace', 'close', workspaceId], {
    cwd,
  })
  if (result.code !== 0) {
    throw new Error(
      `herdr workspace close ${workspaceId} failed: ${result.stderr || result.stdout}`,
    )
  }
}
