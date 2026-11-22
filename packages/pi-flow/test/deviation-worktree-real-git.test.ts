// AIDEV-NOTE: PMR-0KMQ — REAL git, no fakes. Pins the deviation gate fix
// end-to-end: a flow whose worktree lives OUTSIDE the session cwd resolves
// its range through the binding (readFlowBase reads branch.<feature>.flowbase
// from the feature-branch checkout), while the session checkout on main still
// fails exactly as before (the old misleading behavior, kept as contrast).
// Template: test/flow-base-real-git.test.ts.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import { readFlowBase, recordFlowBase } from '../shared/flow-base.ts'
import type { ReviewDeps } from '../tools/code-review-parse.ts'
import {
  resolveDeviationCwd,
  resolveDeviationRange,
} from '../tools/deviation.ts'
// AIDEV-NOTE: PMR-W9TE round 2 — the isolation helpers were hoisted out of
// flow-base-real-git.test.ts into test/git-sandbox.ts; every real-git fixture
// in this package now shares them (see that module's header for the leak
// classes: inherited GIT_* env re-pointing child git at the invoking
// checkout, and a missing cwd falling back to process.cwd()).
import {
  cleanupSandboxes,
  isolateProcessGitEnv,
  makeSandboxExec,
  registerSandbox,
  runInSandbox,
} from './git-sandbox.ts'

isolateProcessGitEnv()

const exec = makeSandboxExec()

function git(cwd: string, ...args: string[]): string {
  return runInSandbox('git', args, cwd)
}

function commit(cwd: string, file: string, msg: string): void {
  runInSandbox('sh', ['-c', `echo "${msg}" >> ${file}`], cwd)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

after(() => {
  cleanupSandboxes()
})

test('real git: deviation resolves the range through the bound external worktree', async () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'dev-wt-')))
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
      // ReviewDeps.exec requires stderr: string; the shared Exec helper's
      // failure branch leaves stderr optional — normalize here.
      exec: async (cmd, args, opts) => {
        const r = await exec(cmd, args, opts)
        return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? '' }
      },
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
