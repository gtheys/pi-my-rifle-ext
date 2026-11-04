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

function extractResult(root: unknown): unknown {
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

/**
 * Preflight: `herdr worktree list` exit 0 proves binary exists, socket
 * reachable, and HERDR_ENV guardrail passes. Failure surfaces stderr
 * verbatim (covers missing binary AND outside-Herdr refusal).
 */
export async function herdrAvailable(
  pi: ExtensionAPI,
  cwd: string,
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
  cwd: string,
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

export async function worktreeCreate(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
  label: string,
): Promise<{ path: string; workspaceId: string }> {
  const result = await pi.exec(
    'herdr',
    ['worktree', 'create', '--cwd', cwd, '--branch', branch, '--label', label],
    { cwd },
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
  cwd: string,
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
  cwd: string,
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
