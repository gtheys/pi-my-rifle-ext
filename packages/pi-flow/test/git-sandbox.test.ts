// AIDEV-NOTE: PMR-W9TE — pins the fixture-isolation contract itself, so the
// guard cannot silently rot now that six real-git fixtures depend on it.
// Every assertion here is about refusing to touch a real repo; the sandbox
// roots used to satisfy the guard are ordinary mkdtemp dirs.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import {
  assertSandboxCwd,
  cleanupSandboxes,
  isolateProcessGitEnv,
  makeSandboxExec,
  registerSandbox,
  runInSandbox,
  sandboxEnv,
} from './git-sandbox.ts'

after(() => {
  cleanupSandboxes()
})

test('assertSandboxCwd: accepts a path inside a registered root', () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-in-')))
  const nested = path.join(root, 'a', 'b')
  assert.equal(assertSandboxCwd(nested, 'probe'), nested)
})

test('assertSandboxCwd: rejects undefined and out-of-root cwds loudly', () => {
  registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-out-')))
  assert.throws(
    () => assertSandboxCwd(undefined, 'no-cwd probe'),
    /fixture isolation: no-cwd probe has no cwd/,
  )
  assert.throws(
    () => assertSandboxCwd(process.cwd(), 'outside probe'),
    /fixture isolation: outside probe cwd .* is outside every registered sandbox root/,
  )
})

test('runInSandbox: guards the spawn cwd AND a `git -C` pinned target', () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-run-')))
  // In-sandbox call really runs (git reports the repo it was pointed at).
  const repo = path.join(root, 'repo')
  runInSandbox('git', ['init', '-q', repo], root)
  assert.equal(
    runInSandbox(
      'git',
      ['-C', repo, 'rev-parse', '--is-inside-work-tree'],
      root,
    ),
    'true',
  )
  // A cwd outside every root never reaches git.
  assert.throws(
    () => runInSandbox('git', ['rev-parse', 'HEAD'], process.cwd()),
    /is outside every registered sandbox root/,
  )
  // Same for a `-C` pin — git would chdir there before doing anything.
  assert.throws(
    () => runInSandbox('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], root),
    /-C target.* is outside every registered sandbox root/,
  )
})

test('runInSandbox: `git switch -C <branch>` is not misread as a directory pin', () => {
  // PMR-T0S0 regression: only a LEADING `git -C <dir>` pins a work dir; the
  // `-C` of `git switch -C` is a branch flag. With the old indexOf('-C')
  // parse the branch name was resolved against process.cwd() and the guard
  // threw "outside every registered sandbox root".
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-switch-')))
  const repo = path.join(root, 'repo')
  runInSandbox('git', ['init', '-q', repo], root)
  runInSandbox(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    repo,
  )
  runInSandbox('git', ['switch', '-C', 'topic'], repo)
  assert.equal(runInSandbox('git', ['branch', '--show-current'], repo), 'topic')
})

test('makeSandboxExec: an out-of-sandbox cwd is a thrown error, not a code-1 result', async () => {
  registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-exec-')))
  // A `{ code: 1 }` result would be handled gracefully by production code and
  // hide the leak; the guard must escape the exec wrapper entirely.
  await assert.rejects(
    () => makeSandboxExec()('git', ['status'], { cwd: process.cwd() }),
    /is outside every registered sandbox root/,
  )
  await assert.rejects(
    () => makeSandboxExec()('git', ['status'], undefined),
    /has no cwd/,
  )
})

test('sandboxEnv + isolateProcessGitEnv: no GIT_* var survives either path', () => {
  process.env.GIT_DIR_PROBE = '/somewhere/real'
  process.env.GS_PROBE_KEEP = 'keep-me'
  try {
    assert.equal(sandboxEnv().GIT_DIR_PROBE, undefined)
    assert.equal(sandboxEnv().GS_PROBE_KEEP, 'keep-me', 'non-git keys survive')
    isolateProcessGitEnv()
    assert.equal(process.env.GIT_DIR_PROBE, undefined)
    assert.equal(process.env.GS_PROBE_KEEP, 'keep-me')
    // Idempotent: a second scrub on an already-clean env changes nothing.
    isolateProcessGitEnv()
    assert.equal(process.env.GIT_DIR_PROBE, undefined)
  } finally {
    delete process.env.GIT_DIR_PROBE
    delete process.env.GS_PROBE_KEEP
  }
})

test('cleanupSandboxes: removes the roots and tightens the guard again', () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-clean-')))
  assert.ok(existsSync(root))
  cleanupSandboxes()
  assert.ok(!existsSync(root))
  // Registry emptied: the removed root is no longer an accepted cwd.
  assert.throws(
    () => assertSandboxCwd(root, 'after cleanup'),
    /is outside every registered sandbox root/,
  )
  // AIDEV-NOTE: PMR-0RDM — cleanupSandboxes() emptied the PROCESS-WIDE
  // registry, making every test appended after this one order-dependent.
  // Re-register a throwaway root so later tests keep a valid sandbox.
  registerSandbox(mkdtempSync(path.join(tmpdir(), 'gs-after-clean-')))
})
