// AIDEV-NOTE: PMR-0KMQ — REAL git, no fakes. Pins the commit-mode review gate
// fix: a commit review of the flow worktree HEAD pins and verifies NON-STALE
// when built and re-checked in the worktree, while the same pin verified from
// the session checkout reports the misleading 'stale' verdict ("HEAD moved")
// — the exact field failure from PMR-1KAE validate, kept as contrast.
// AIDEV-NOTE: PMR-7N3D — also pins the flow-base override seam
// (resolveBranchRefForReview) on a REBASED personal flow: personal returns
// the rebase-aware merge-base vs the LOCAL flowbase branch (the new main
// tip), work returns the recorded flowbasesha (stale by design — ISC-4),
// and the resolved SHA carries through the PMR-6EEW gate pin unchanged.
// Template: test/flow-base-real-git.test.ts; rebase sandbox script shared
// with test/base-resolution-rebase-real-git.test.ts.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import {
  buildReviewGatePin,
  resolveBranchRefForReview,
  resolveCommitReviewCwd,
} from '../review/review.ts'
import { recordFlowBase } from '../shared/flow-base.ts'
import {
  reviewedRangeLine,
  verifyGateWithExec,
} from '../validate/gate-target.ts'
// AIDEV-NOTE: PMR-W9TE round 2 — the isolation helpers now live in
// test/git-sandbox.ts, shared by every real-git fixture in this package.
import {
  cleanupSandboxes,
  isolateProcessGitEnv,
  makeSandboxExec,
  registerSandbox,
  runInSandbox,
} from './git-sandbox.ts'

isolateProcessGitEnv()

const exec = makeSandboxExec()

// Full-shape pi.exec wrapper over the same isolated real git — used by the
// seam's productionReviewDeps wiring (aven/herdr probes fail honestly: the
// binding verifies first, so the fallback sources are never reached).
// AIDEV-NOTE: PMR-W9TE — it delegates to makeSandboxExec(), so the cwd guard
// and the GIT_* env scrub cannot be forgotten at this call site; only the
// extra pi.exec result fields are added here.
function makeRealPi(): ExtensionAPI {
  const piExec = async (
    cmd: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    const result = await exec(cmd, args, options)
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr ?? '',
      killed: false,
      signal: null,
    }
  }
  return {
    exec: piExec,
  } as unknown as ExtensionAPI
}

function git(cwd: string, ...args: string[]): string {
  return runInSandbox('git', args, cwd)
}

function commit(cwd: string, file: string, msg: string): void {
  runInSandbox('sh', ['-c', `echo "${msg}" >> ${file}`], cwd)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

/**
 * PMR-7N3D fixture: base branch `main` at commit A, flow worktree on
 * `feat/x` at A with the flow's own commits F1 + F2, and
 * `branch.feat/x.flowbase` / `.flowbasesha` recorded exactly as worktree
 * create records them. Same script as
 * test/base-resolution-rebase-real-git.test.ts (kept local on purpose —
 * real-git fixtures stay self-contained).
 */
async function setupFlow(): Promise<{
  repo: string
  wt: string
  shaA: string
}> {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'rev-base-')))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', '--bare', origin)
  // Pin the bare origin's HEAD to main (CI git defaults the initial branch
  // to master, which would leave a clone with an unborn HEAD).
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')

  const shaA = git(repo, 'rev-parse', 'HEAD')
  assert.ok((await recordFlowBase(exec, repo, 'feat/x', 'main', shaA)).ok)
  const wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, shaA)
  commit(wt, 'f.txt', 'F1-feature-work')
  commit(wt, 'f.txt', 'F2-feature-work')
  return { repo, wt, shaA }
}

after(() => {
  cleanupSandboxes()
})

test('real git: commit review of the worktree HEAD verifies non-stale through the binding', async () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'rev-wt-')))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')
  const baseSha = git(repo, 'rev-parse', 'HEAD')

  const wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, baseSha)
  commit(wt, 'feature.txt', 'feature work')
  const sha = git(wt, 'rev-parse', 'HEAD')
  const parent = git(wt, 'rev-parse', 'HEAD^')

  // (1) The pin builds in the worktree: base = sha^, head = sha.
  const pin = await buildReviewGatePin(exec, { type: 'commit', sha }, wt)
  assert.ok(pin, 'pin built')
  if (pin) {
    assert.equal(pin.headSha, sha)
    assert.equal(pin.baseSha, parent)
  }

  // (2) Verified from the worktree cwd: echo matches, HEAD unchanged → pass.
  assert.ok(pin)
  const artifact = `review prose\n${reviewedRangeLine(pin)}`
  const verified = await verifyGateWithExec(exec, wt, pin, artifact)
  assert.equal(verified.ok, true)
  if (verified.ok) assert.equal(verified.status, 'pass')

  // (3) Contrast — the old failure mode: the same pin re-checked from the
  // session checkout (HEAD = main tip) reports a bogus 'stale'.
  const stale = await verifyGateWithExec(exec, repo, pin, artifact)
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.equal(stale.status, 'stale')
    assert.match(stale.reason, /HEAD moved/)
  }

  // (4) Seam: main-checkout-rooted session + bound worktree → worktree cwd.
  setActiveFlowRef('PMR-TEST')
  setFlowWorktree(wt, 'feat/x')
  try {
    const resolution = await resolveCommitReviewCwd(makeRealPi(), repo, sha)
    assert.deepEqual(resolution, {
      ok: true,
      cwd: wt,
      source: 'worktree',
    })
  } finally {
    setActiveFlowRef(null)
  }
})

test('real git: rebased flow base — personal merge-base tip, work recorded sha, pin carries it (PMR-7N3D)', async () => {
  const { repo, wt, shaA } = await setupFlow()
  // Another flow lands on main (touches other.txt), then our branch is
  // rebased onto the moved main — the PMR-1KAE guided procedure that
  // silently staled the recorded flowbasesha pin.
  commit(repo, 'other.txt', 'unrelated-main-commit')
  const mainTip = git(repo, 'rev-parse', 'main')
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '-q', 'main')

  // Personal: rebase-aware local merge-base vs the recorded flowbase
  // BRANCH — the new main tip, so the review spread carries only the
  // flow's own commits (ISC-2). Local-only: never <base>@{upstream}
  // (PMR-MH1Y/DQ7Z).
  const personal = await resolveBranchRefForReview(
    makeRealPi(),
    'main',
    wt,
    'personal',
  )
  assert.equal(personal, mainTip)

  // Work: the recorded sha still anchors — deliberately unchanged (ISC-4).
  const work = await resolveBranchRefForReview(makeRealPi(), 'main', wt, 'work')
  assert.equal(work, shaA)

  // PMR-6EEW pin path: the resolved SHA plumbed as target.branch carries
  // through buildReviewGatePin as the pin's baseSha — no re-resolution
  // drift downstream.
  const pin = await buildReviewGatePin(
    exec,
    { type: 'baseBranch', branch: personal },
    wt,
  )
  assert.ok(pin, 'pin built')
  if (pin) {
    assert.equal(pin.baseSha, mainTip)
  }
})
