// REAL git, no fakes (same pattern as flow-base-real-git.test.ts): the
// PMR-1KAE field scenario. The flow branch was created from an older main;
// main moved on (other flows landed). defaultCheckMainAdvancement must
// refuse with rebase guidance BEFORE authorization, pass after the guided
// rebase, refuse while origin/main is ahead of local main, and only pass
// once the local base is fast-forwarded AND the branch rebased onto it.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { defaultCheckMainAdvancement } from '../tools/land.ts'
// AIDEV-NOTE: PMR-W9TE round 2 — `defaultCheckMainAdvancement` is the DEFAULT
// checker, so it shells out through land.ts's own execFileAsync and there is
// no seam to wrap here: isolation has to cover the fixture's direct calls
// (runInSandbox) AND the inherited env of the whole fixture process
// (isolateProcessGitEnv) — the leak the review proved, where this fixture
// created `main` + an initial commit in an unrelated checkout.
// See test/git-sandbox.ts.
import {
  cleanupSandboxes,
  isolateProcessGitEnv,
  registerSandbox,
  runInSandbox,
} from './git-sandbox.ts'

isolateProcessGitEnv()

function git(cwd: string, ...args: string[]): string {
  return runInSandbox('git', args, cwd)
}

function commit(cwd: string, file: string, msg: string): void {
  runInSandbox('sh', ['-c', `echo "${msg}" >> ${file}`], cwd)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

function rebaseOntoMain(repo: string): void {
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'rebase',
    '-q',
    'main',
    'flow-branch',
  )
}

function setupRepo(): { root: string; repo: string } {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'land-adv-')))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'branch', '-q', '--set-upstream-to', 'origin/main')
  // AIDEV-NOTE: pin the bare origin's HEAD to main. CI git defaults the
  // initial branch to 'master', so a later clone gets an unborn HEAD and
  // `git push origin main` from it fails with "src refspec main does not
  // match any" (red main CI since 2026-11-21).
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  return { root, repo }
}

after(() => {
  cleanupSandboxes()
})

test('real git: stale branch refuses, guided rebase heals, landing proceeds (PMR-1KAE)', async () => {
  const { repo } = setupRepo()
  // Flow branch starts at S; main advances past it (other flows landed).
  git(repo, 'checkout', '-q', '-b', 'flow-branch')
  commit(repo, 'f.txt', 'flow work')
  git(repo, 'checkout', '-q', 'main')
  commit(repo, 'a.txt', 'other flow landed on main')

  const stale = await defaultCheckMainAdvancement(repo, 'flow-branch')
  assert.equal(stale.ok, false, 'a moved main must refuse the landing')
  if (stale.ok) throw new Error('unreachable')
  assert.match(stale.reason, /rebase/)

  // The guided rebase-then-reland procedure heals the staleness. It runs in
  // the flow worktree in production; here the same repo doubles as the flow
  // checkout, so restore the base branch as the checked-out state afterwards
  // (the main checkout must sit on the base for the landing).
  rebaseOntoMain(repo)
  git(repo, 'checkout', '-q', 'main')
  const healed = await defaultCheckMainAdvancement(repo, 'flow-branch')
  assert.deepEqual(healed, { ok: true })
})

test('real git: origin ahead refuses until local base is ff-forwarded, then rebase (PMR-1KAE)', async () => {
  const { root, repo } = setupRepo()
  // Flow branch at S; local main advances past it; the branch is rebased so
  // it is FRESH against the local base — only then can the origin leg of the
  // check be reached (staleness is detected first, by design).
  git(repo, 'checkout', '-q', '-b', 'flow-branch')
  commit(repo, 'f.txt', 'flow work')
  git(repo, 'checkout', '-q', 'main')
  commit(repo, 'a.txt', 'local main moved')
  // Publish the local main first so origin/main CONTAINS it — then commits
  // pushed from another clone make origin/main strictly ahead of local main
  // (a diverged origin would not be "ahead" and would legitimately pass).
  git(repo, 'push', '-q', 'origin', 'main')
  rebaseOntoMain(repo)
  git(repo, 'checkout', '-q', 'main')

  // A second clone pushes new main commits: origin/main is now ahead of
  // the local main in the first repo.
  const other = path.join(root, 'other')
  git(root, 'clone', '-q', path.join(root, 'origin.git'), other)
  git(other, 'config', 'user.name', 't')
  git(other, 'config', 'user.email', 't@t')
  commit(other, 'a.txt', 'pushed from elsewhere')
  git(other, 'push', '-q', 'origin', 'main')

  // Fresh: merge-base(flow-branch, main) == main tip, but origin is ahead.
  const ahead = await defaultCheckMainAdvancement(repo, 'flow-branch')
  assert.equal(ahead.ok, false, 'an advanced origin must refuse the landing')
  if (ahead.ok) throw new Error('unreachable')
  assert.match(ahead.reason, /merge --ff-only 'origin\/main'/)

  // Follow the guidance: fast-forward the local base onto origin/main.
  git(repo, 'fetch', '-q', 'origin')
  git(repo, 'merge', '-q', '--ff-only', 'origin/main')

  // The base moved again past the branch's base -> stale guidance, not ok.
  const staleAgain = await defaultCheckMainAdvancement(repo, 'flow-branch')
  assert.equal(staleAgain.ok, false)
  if (staleAgain.ok) throw new Error('unreachable')
  assert.match(staleAgain.reason, /rebase/)

  // Guided rebase onto the now-current main (and restore the base as the
  // checked-out branch of the main checkout): the landing proceeds.
  rebaseOntoMain(repo)
  git(repo, 'checkout', '-q', 'main')
  const healed = await defaultCheckMainAdvancement(repo, 'flow-branch')
  assert.deepEqual(healed, { ok: true })
})
