// AIDEV-NOTE: PMR-R4AP — the flow's diff base is the branch the MAIN checkout
// was on when the worktree was created (main/develop/staging/...). It is
// stored as git config `branch.<feature>.flowbase` (repo-shared config, so
// the worktree can read it). No recorded base => callers error, never guess.
import type { Exec } from './diff-base.ts'

export type BaseResult =
  | { ok: true; branch: string }
  | { ok: false; reason: string }

/** Current branch of `cwd`; error on detached HEAD. */
export async function currentBranch(
  exec: Exec,
  cwd: string,
): Promise<BaseResult> {
  const r = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
  const branch = r.stdout.trim()
  if (r.code !== 0 || branch === '') {
    return { ok: false, reason: `git rev-parse failed in ${cwd}` }
  }
  if (branch === 'HEAD') {
    return {
      ok: false,
      reason: `detached HEAD in ${cwd} — check out the base branch (main/develop/...) first`,
    }
  }
  return { ok: true, branch }
}

export async function recordFlowBase(
  exec: Exec,
  cwd: string,
  featureBranch: string,
  baseBranch: string,
): Promise<BaseResult> {
  const r = await exec(
    'git',
    ['config', `branch.${featureBranch}.flowbase`, baseBranch],
    { cwd },
  )
  if (r.code !== 0) {
    return {
      ok: false,
      reason: `git config branch.${featureBranch}.flowbase failed: ${r.stderr ?? ''}`,
    }
  }
  return { ok: true, branch: baseBranch }
}

/** Read the recorded base of the branch checked out in `cwd`. */
export async function readFlowBase(
  exec: Exec,
  cwd: string,
): Promise<BaseResult> {
  const cur = await currentBranch(exec, cwd)
  if (!cur.ok) return cur
  const r = await exec('git', ['config', `branch.${cur.branch}.flowbase`], {
    cwd,
  })
  const base = r.stdout.trim()
  if (r.code !== 0 || base === '') {
    return {
      ok: false,
      reason: `no recorded flow base for '${cur.branch}' (branch.${cur.branch}.flowbase unset) — worktree predates PMR-R4AP; record it with: git config branch.${cur.branch}.flowbase <base-branch>`,
    }
  }
  return { ok: true, branch: base }
}
