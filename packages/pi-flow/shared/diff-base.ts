// AIDEV-NOTE: PMR-R4AP — ONE upstream-aware merge-base resolver shared by the
// review gate (review/review.ts) and the deviation gate (tools/deviation.ts),
// so the two gates can never disagree on the diff range (PMR-KKDC). Takes a
// narrow `exec` seam (pi.exec is compatible) so it is testable without Pi.

export interface ExecResult {
  stdout: string
  stderr?: string
  code: number
}

export type Exec = (
  cmd: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<ExecResult>

export interface FlowRange {
  baseBranch: string
  baseSha: string
  headSha: string
  /** `<baseSha>..HEAD` */
  range: string
  commitCount: number
}

export type FlowRangeResult =
  | { ok: true; value: FlowRange }
  | { ok: false; reason: string }

/**
 * Merge base between HEAD and a branch: prefers `<branch>@{upstream}`, falls
 * back to the local branch. Null when neither resolves.
 */
export async function getMergeBase(
  exec: Exec,
  branch: string,
  cwd?: string,
): Promise<string | null> {
  try {
    const upstream = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
      { cwd },
    )
    if (upstream.code === 0 && upstream.stdout.trim()) {
      const mb = await exec(
        'git',
        ['merge-base', 'HEAD', upstream.stdout.trim()],
        { cwd },
      )
      if (mb.code === 0 && mb.stdout.trim()) {
        return mb.stdout.trim()
      }
    }
    const mb = await exec('git', ['merge-base', 'HEAD', branch], { cwd })
    if (mb.code === 0 && mb.stdout.trim()) {
      return mb.stdout.trim()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve the review range for a flow worktree. Errors (never an empty
 * result) when the base is unresolvable or HEAD == merge-base.
 */
export async function resolveFlowRange(
  exec: Exec,
  cwd: string,
  baseBranch: string,
): Promise<FlowRangeResult> {
  const baseSha = await getMergeBase(exec, baseBranch, cwd)
  if (baseSha === null) {
    return {
      ok: false,
      reason: `cannot resolve merge-base of HEAD and '${baseBranch}' in ${cwd}`,
    }
  }
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd })
  const headSha = head.stdout.trim()
  if (head.code !== 0 || headSha === '') {
    return { ok: false, reason: `git rev-parse HEAD failed in ${cwd}` }
  }
  if (headSha === baseSha) {
    return {
      ok: false,
      reason: `empty range: HEAD == merge-base with '${baseBranch}' (${baseSha.slice(0, 9)}) in ${cwd}`,
    }
  }
  const range = `${baseSha}..HEAD`
  const count = await exec('git', ['rev-list', '--count', range], { cwd })
  const commitCount = Number.parseInt(count.stdout.trim(), 10)
  if (count.code !== 0 || Number.isNaN(commitCount)) {
    return { ok: false, reason: `git rev-list failed for ${range} in ${cwd}` }
  }
  return {
    ok: true,
    value: { baseBranch, baseSha, headSha, range, commitCount },
  }
}

export async function diffForRange(
  exec: Exec,
  cwd: string,
  range: string,
): Promise<string> {
  const r = await exec('git', ['diff', range], { cwd })
  if (r.code !== 0) {
    throw new Error(`git diff ${range} failed in ${cwd}: ${r.stderr ?? ''}`)
  }
  return r.stdout
}

export async function commitMessagesForRange(
  exec: Exec,
  cwd: string,
  range: string,
): Promise<string> {
  const r = await exec('git', ['log', range], { cwd })
  if (r.code !== 0) {
    throw new Error(`git log ${range} failed in ${cwd}: ${r.stderr ?? ''}`)
  }
  return r.stdout
}
