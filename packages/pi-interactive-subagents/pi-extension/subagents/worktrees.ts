import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// AIDEV-NOTE: Worktree placement for `subagent({worktree: true})` (PMR-11TD).
// Direct `git worktree add` — NO pi-worktree import (cross-package runtime
// deps are repo-verboten), NO `herdr worktree` coupling. Creation is
// blocking+sync and runs BEFORE the tab spawn: a failed `git worktree add`
// means no tab, no partial state. Worktrees outlive their children — removal
// is manual (no auto-delete ever, per plan).

/** `worktree` param shape on the subagent tool: true or `{base?: string}`. */
export type WorktreeOption = boolean | { base?: string }

export interface CreatedWorktree {
  path: string
  branch: string
}

/** Error from a failed git invocation during worktree setup. */
export class WorktreeError extends Error {
  readonly stderr: string

  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'WorktreeError'
    this.stderr = stderr
  }
}

// AIDEV-NOTE: PMR-S6W3 — inside a git hook (e.g. lefthook pre-push) git
// exports repo-pointing vars (GIT_DIR, GIT_WORK_TREE, ...). This code
// resolves repos from explicit cwds via `git -C`, so those vars must never
// leak into child git calls — they override repo discovery and make every
// cwd look like a repo. Identity vars (GIT_AUTHOR_NAME etc.) are kept.
const GIT_REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const

export function childGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of GIT_REPO_ENV_VARS) {
    delete env[name]
  }
  return env
}

/** Lowercase dash-slug; mirrors pi-worktree's slugify rules (unexported). */
export function slugifyWorktree(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Branch name for a worktree spawn: `subagent/<name-slug>-<ts>-<childId>`.
 * The childId suffix guarantees uniqueness for same-second same-name spawns.
 */
export function deriveWorktreeBranch(
  name: string,
  childId: string,
  now: Date = new Date(),
): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  const slug = slugifyWorktree(name).slice(0, 40) || 'agent'
  return `subagent/${slug}-${ts}-${childId}`
}

/**
 * Worktree path convention: `$HOME/.herdr/worktrees/<repo-slug>/<branch-slug>`
 * — the same layout herdr uses for its own workspaces, so manual cleanup and
 * the pi-worktree dashboard stay coherent. Branch slashes become dashes.
 */
export function worktreePathFor(mainRepoRoot: string, branch: string): string {
  const repoSlug = basename(mainRepoRoot)
  const branchSlug = branch.replace(/\//g, '-')
  return join(homedir(), '.herdr', 'worktrees', repoSlug, branchSlug)
}

/**
 * Absolute path of the MAIN checkout (not a linked worktree). Works when the
 * caller itself runs inside a linked worktree: `--git-common-dir` always
 * resolves to the main repo's `.git`.
 */
export function findMainRepoRoot(cwd: string): string {
  let out: string
  try {
    out = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', env: childGitEnv() },
    ).trim()
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message: string }
    const stderr = e.stderr ? String(e.stderr).trim() : ''
    throw new WorktreeError(
      `not a git repository (cwd: ${cwd}): ${stderr || e.message}`,
      stderr,
    )
  }
  return dirname(out)
}

/**
 * Create a linked worktree + branch off the main checkout. Throws
 * WorktreeError on any git failure — callers must treat this as fatal for
 * the spawn (no tab, no partial state).
 */
export function createSubagentWorktree(options: {
  cwd: string
  branch: string
  base?: string
}): CreatedWorktree {
  const mainRoot = findMainRepoRoot(options.cwd)
  const path = worktreePathFor(mainRoot, options.branch)
  mkdirSync(dirname(path), { recursive: true })
  const args = ['-C', mainRoot, 'worktree', 'add', '-b', options.branch, path]
  if (options.base) {
    args.push(options.base)
  }
  try {
    execFileSync('git', args, { encoding: 'utf8', env: childGitEnv() })
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message: string }
    const stderr = e.stderr ? String(e.stderr).trim() : ''
    throw new WorktreeError(
      `git worktree add failed (branch ${options.branch}, path ${path}): ` +
        (stderr || e.message),
      stderr,
    )
  }
  return { path, branch: options.branch }
}
