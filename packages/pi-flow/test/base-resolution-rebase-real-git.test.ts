// AIDEV-NOTE: PMR-7N3D — REAL git, no fakes. The field scenario the stale
// `branch.<feature>.flowbasesha` pin could not survive: a personal-mode flow
// whose branch was REBASED onto main mid-flow ("rebase-then-reland",
// PMR-1KAE). The recorded sha points at the PRE-rebase base, so a sha-pinned
// range sweeps every commit other flows landed on main since worktree create.
// Personal mode therefore resolves the gate-time base as
// merge-base(HEAD, <LOCAL flowbase branch>) via the shared local-only
// resolver (MODE_PROFILE.baseResolution = 'merge-base-local', PMR-R4AP: the
// SAME resolver the review gate uses) — never the base's upstream ref
// (PMR-MH1Y/DQ7Z). Work mode keeps its recorded-sha semantics; Case 1 pins
// that deliberately (ISC-4). Case 2 pins the no-rebase contract (ISC-8):
// merge-base(HEAD, main) == flowbasesha, so nothing changes for an
// unrebased flow. Template: test/flow-base-real-git.test.ts; rebase pattern:
// test/land-advancement-real-git.test.ts rebaseOntoMain.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { commitMessagesForRange, diffForRange } from '../shared/diff-base.ts'
import { readFlowBase, recordFlowBase } from '../shared/flow-base.ts'
import { resolveDeviationRange } from '../tools/deviation.ts'
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

/**
 * The shared fixture: base branch `main` at commit A, worktree on `feat/x`
 * at A with the flow's own commits F1 + F2, and `branch.feat/x.flowbase` /
 * `.flowbasesha` recorded exactly as worktree create records them.
 */
async function setupFlow(): Promise<{
  repo: string
  wt: string
  shaA: string
}> {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'base-res-')))
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

test('real git: rebased personal flow ranges from the new merge-base; work stays sha-anchored', async () => {
  const { repo, wt, shaA } = await setupFlow()
  // Another flow lands on main (touches other.txt), then our branch is
  // rebased onto the moved main — the PMR-1KAE guided procedure.
  commit(repo, 'other.txt', 'unrelated-main-commit')
  const mainTip = git(repo, 'rev-parse', 'main')
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '-q', 'main')

  // Personal: the rebase-aware base is the NEW main tip, so the spread
  // carries only the flow's own commits (ISC-1).
  const personal = await resolveDeviationRange(exec, wt, 'personal')
  assert.equal(personal.ok, true)
  if (personal.ok) {
    assert.equal(personal.value.flowRange.baseSha, mainTip)
    const log = await commitMessagesForRange(
      exec,
      wt,
      personal.value.flowRange.range,
    )
    const diff = await diffForRange(exec, wt, personal.value.flowRange.range)
    assert.match(log, /F1-feature-work/)
    assert.match(log, /F2-feature-work/)
    assert.doesNotMatch(log, /unrelated-main-commit/)
    assert.doesNotMatch(diff, /other\.txt/)
  }

  // Work: the recorded flowbasesha still anchors the range, so the rebased-in
  // main commit IS part of its spread. Deliberate pin — ISC-4 (this is the
  // behavior the plan promises to keep byte-for-byte, not an oversight).
  const work = await resolveDeviationRange(exec, wt, 'work')
  assert.equal(work.ok, true)
  if (work.ok) {
    assert.equal(work.value.flowRange.baseSha, shaA)
    const log = await commitMessagesForRange(
      exec,
      wt,
      work.value.flowRange.range,
    )
    assert.match(log, /F1-feature-work/)
    assert.match(log, /F2-feature-work/)
    assert.match(log, /unrelated-main-commit/)
  }
})

test('real git: unrebased personal flow base equals the recorded flowbasesha', async () => {
  const { wt } = await setupFlow()
  const base = await readFlowBase(exec, wt)
  assert.ok(base.ok)
  if (!base.ok) return
  assert.equal(base.value.branch, 'main')

  // No rebase in the flow's history: merge-base(HEAD, main) is exactly the
  // sha recorded at worktree create, so the gate behaves as it always did.
  const personal = await resolveDeviationRange(exec, wt, 'personal')
  assert.equal(personal.ok, true)
  if (personal.ok) {
    assert.equal(personal.value.flowRange.baseSha, base.value.sha)
    assert.equal(personal.value.flowRange.commitCount, 2)
    const log = await commitMessagesForRange(
      exec,
      wt,
      personal.value.flowRange.range,
    )
    assert.match(log, /F1-feature-work/)
    assert.match(log, /F2-feature-work/)
  }
})
