// AIDEV-NOTE: PMR-R4AP — REAL git, no fakes. Scenario from the field: the main
// checkout is on `develop`, origin/develop is BEHIND local develop (unpushed
// local merges), the feature worktree branches from local develop. The flow
// range must contain ONLY the feature commits.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  commitMessagesForRange,
  diffForRange,
  type Exec,
  resolveFlowRange,
} from '../shared/diff-base.ts'
import {
  currentBranch,
  readFlowBase,
  recordFlowBase,
  resolveBaseSha,
} from '../shared/flow-base.ts'
import { worktreeCreateArgs } from '../worktree/herdr.ts'

const exec: Exec = async (cmd, args, options) => {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: options?.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: 1 }
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, file: string, msg: string): void {
  execFileSync('sh', ['-c', `echo "${msg}" >> ${file}`], { cwd })
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

for (const baseBranch of ['main', 'develop', 'staging']) {
  test(`real git: range == feature commits only (base ${baseBranch}, origin behind local)`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fb-'))
    const origin = path.join(root, 'origin.git')
    const repo = path.join(root, 'repo')
    git(root, 'init', '-q', '--bare', origin)
    git(root, 'clone', '-q', origin, repo)
    git(repo, 'checkout', '-q', '-b', baseBranch)
    commit(repo, 'a.txt', 'initial')
    git(repo, 'push', '-q', 'origin', baseBranch)
    git(repo, 'branch', '-q', '--set-upstream-to', `origin/${baseBranch}`)
    // unpushed local merges on the base — NOT part of the feature
    commit(repo, 'other.txt', 'unrelated-local-1')
    commit(repo, 'other.txt', 'unrelated-local-2')

    // what createFlow does, step by step
    const cur = await currentBranch(exec, repo)
    assert.ok(cur.ok && cur.branch === baseBranch)
    const sha = await resolveBaseSha(exec, repo, baseBranch)
    assert.ok(sha.ok)
    const baseSha = sha.ok ? sha.branch : ''
    assert.ok(
      worktreeCreateArgs(repo, 'feat/x', 'x', baseSha)
        .join(' ')
        .includes(`--base ${baseSha}`),
    )
    assert.ok(
      (await recordFlowBase(exec, repo, 'feat/x', baseBranch, baseSha)).ok,
    )
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, baseSha)

    commit(wt, 'f.txt', 'feature-1')
    commit(wt, 'f.txt', 'feature-2')

    const base = await readFlowBase(exec, wt)
    assert.ok(base.ok)
    if (!base.ok) return
    assert.equal(base.value.branch, baseBranch)
    assert.equal(base.value.sha, baseSha)
    const r = await resolveFlowRange(
      exec,
      wt,
      base.value.branch,
      base.value.sha ?? '',
    )
    assert.ok(r.ok)
    if (!r.ok) return
    assert.equal(r.value.commitCount, 2)
    const log = await commitMessagesForRange(exec, wt, r.value.range)
    assert.match(log, /feature-1/)
    assert.match(log, /feature-2/)
    assert.doesNotMatch(log, /unrelated-local/)
    const diff = await diffForRange(exec, wt, r.value.range)
    assert.match(diff, /f\.txt/)
    assert.doesNotMatch(diff, /other\.txt/)

    // base branch advancing later must not change the range
    commit(repo, 'other.txt', 'unrelated-local-3')
    const again = await resolveFlowRange(exec, wt, baseBranch, baseSha)
    assert.ok(again.ok && again.value.commitCount === 2)
  })
}

test('real git: empty range (no feature commits) is an error', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fb-'))
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', repo)
  commit(repo, 'a.txt', 'initial')
  const sha = git(repo, 'rev-parse', 'HEAD')
  const r = await resolveFlowRange(exec, repo, 'master', sha)
  assert.equal(r.ok, false)
})
