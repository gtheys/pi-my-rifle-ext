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

export interface FlowBase {
  branch: string
  /** Exact commit the worktree branch started from; null for legacy worktrees. */
  sha: string | null
}

export type FlowBaseResult =
  | { ok: true; value: FlowBase }
  | { ok: false; reason: string }

/** Resolve a branch to its exact commit SHA in `cwd`. */
export async function resolveBaseSha(
  exec: Exec,
  cwd: string,
  branch: string,
): Promise<BaseResult> {
  const r = await exec('git', ['rev-parse', '--verify', `${branch}^{commit}`], {
    cwd,
  })
  const sha = r.stdout.trim()
  if (r.code !== 0 || sha === '') {
    return { ok: false, reason: `cannot resolve '${branch}' in ${cwd}` }
  }
  return { ok: true, branch: sha }
}

/** Record base branch + exact SHA as branch.<feature>.flowbase / .flowbasesha. */
export async function recordFlowBase(
  exec: Exec,
  cwd: string,
  featureBranch: string,
  baseBranch: string,
  baseSha: string,
): Promise<BaseResult> {
  for (const [key, value] of [
    ['flowbase', baseBranch],
    ['flowbasesha', baseSha],
  ]) {
    const r = await exec(
      'git',
      ['config', `branch.${featureBranch}.${key}`, value as string],
      { cwd },
    )
    if (r.code !== 0) {
      return {
        ok: false,
        reason: `git config branch.${featureBranch}.${key} failed: ${r.stderr ?? ''}`,
      }
    }
  }
  return { ok: true, branch: baseBranch }
}

export async function clearFlowBase(
  exec: Exec,
  cwd: string,
  featureBranch: string,
): Promise<void> {
  for (const key of ['flowbase', 'flowbasesha']) {
    await exec('git', ['config', '--unset', `branch.${featureBranch}.${key}`], {
      cwd,
    })
  }
}

/** Read the recorded base of the branch checked out in `cwd`. */
export async function readFlowBase(
  exec: Exec,
  cwd: string,
): Promise<FlowBaseResult> {
  const cur = await currentBranch(exec, cwd)
  if (!cur.ok) return cur
  const b = await exec('git', ['config', `branch.${cur.branch}.flowbase`], {
    cwd,
  })
  const branch = b.stdout.trim()
  if (b.code !== 0 || branch === '') {
    return {
      ok: false,
      reason: `no recorded flow base for '${cur.branch}' (branch.${cur.branch}.flowbase unset) — worktree predates PMR-R4AP; record it with: git config branch.${cur.branch}.flowbase <base-branch>`,
    }
  }
  const s = await exec('git', ['config', `branch.${cur.branch}.flowbasesha`], {
    cwd,
  })
  const sha = s.stdout.trim()
  return {
    ok: true,
    value: { branch, sha: s.code === 0 && sha !== '' ? sha : null },
  }
}
