// AIDEV-NOTE: PMR-0KMQ — REAL git, no fakes. Pins the commit-mode review gate
// fix: a commit review of the flow worktree HEAD pins and verifies NON-STALE
// when built and re-checked in the worktree, while the same pin verified from
// the session checkout reports the misleading 'stale' verdict ("HEAD moved")
// — the exact field failure from PMR-1KAE validate, kept as contrast.
// Template: test/flow-base-real-git.test.ts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import { buildReviewGatePin, resolveCommitReviewCwd } from '../review/review.ts'
import type { Exec } from '../shared/diff-base.ts'
import {
  reviewedRangeLine,
  verifyGateWithExec,
} from '../validate/gate-target.ts'

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

// Full-shape pi.exec wrapper over the same real git — used by the seam's
// productionReviewDeps wiring (aven/herdr probes fail honestly: the binding
// verifies first, so the fallback sources are never reached).
function makeRealPi(): ExtensionAPI {
  const piExec = async (
    cmd: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    try {
      const stdout = execFileSync(cmd, args, {
        cwd: options?.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        code: 0,
        stdout,
        stderr: '',
        killed: false,
        signal: null,
      }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string }
      return {
        code: 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        killed: false,
        signal: null,
      }
    }
  }
  return {
    exec: piExec,
  } as unknown as ExtensionAPI
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, file: string, msg: string): void {
  execFileSync('sh', ['-c', `echo "${msg}" >> ${file}`], { cwd })
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

test('real git: commit review of the worktree HEAD verifies non-stale through the binding', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rev-wt-'))
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
