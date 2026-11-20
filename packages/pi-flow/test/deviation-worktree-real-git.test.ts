// AIDEV-NOTE: PMR-0KMQ — REAL git, no fakes. Pins the deviation gate fix
// end-to-end: a flow whose worktree lives OUTSIDE the session cwd resolves
// its range through the binding (readFlowBase reads branch.<feature>.flowbase
// from the feature-branch checkout), while the session checkout on main still
// fails exactly as before (the old misleading behavior, kept as contrast).
// Template: test/flow-base-real-git.test.ts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import type { Exec } from '../shared/diff-base.ts'
import { readFlowBase, recordFlowBase } from '../shared/flow-base.ts'
import type { ReviewDeps } from '../tools/code-review-parse.ts'
import {
  resolveDeviationCwd,
  resolveDeviationRange,
} from '../tools/deviation.ts'

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

test('real git: deviation resolves the range through the bound external worktree', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dev-wt-'))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')

  const baseSha = git(repo, 'rev-parse', 'HEAD')
  assert.ok((await recordFlowBase(exec, repo, 'feat/x', 'main', baseSha)).ok)
  const wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, baseSha)
  commit(wt, 'feature.txt', 'feature work')
  const wtHead = git(wt, 'rev-parse', 'HEAD')

  setActiveFlowRef('PMR-TEST')
  setFlowWorktree(wt, 'feat/x')
  try {
    const deps: ReviewDeps = {
      getFlowWorktree: () => ({ ref: 'PMR-TEST', path: wt, branch: 'feat/x' }),
      avenShowFull: async () => '',
      herdrWorktreeList: async () => [],
      exec,
      exists: (p: string) => existsSync(p),
      repoRoot: repo,
    }

    const cwdResolution = await resolveDeviationCwd('PMR-TEST', deps)
    assert.deepEqual(cwdResolution, { ok: true, cwd: wt })

    // The gate path: resolveDeviationRange(exec, worktree) → readFlowBase
    // reads branch.feat/x.flowbase from the feature-branch checkout and the
    // range covers ONLY the worktree-only commit.
    const range = await resolveDeviationRange(exec, wt)
    assert.equal(range.ok, true)
    if (range.ok) {
      assert.equal(range.value.flowRange.headSha, wtHead)
      assert.ok(range.value.flowRange.commitCount >= 1)
      assert.ok(range.value.diff.trim().length > 0)
    }

    // Contrast: resolving from the session checkout (on main, no
    // branch.main.flowbase) fails exactly as before — the misleading
    // "flow worktree is not bound" refusal this ticket removes from the
    // happy path.
    const fromSession = await resolveDeviationRange(exec, repo)
    assert.equal(fromSession.ok, false)
    if (!fromSession.ok) {
      assert.match(fromSession.reason, /not bound|flow base/)
    }

    // The recorded flowbase is keyed by the feature branch (shared git
    // config) and readable from the worktree checkout — FlowBase.branch is
    // the recorded BASE branch, the resolution source of truth.
    const base = await readFlowBase(exec, wt)
    assert.ok(base.ok && base.value.branch === 'main')
  } finally {
    setActiveFlowRef(null)
  }
})
