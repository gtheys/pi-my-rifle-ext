// AIDEV-NOTE: PMR-R4AP — REAL git, no fakes. Scenario from the field: the main
// checkout is on `develop`, origin/develop is BEHIND local develop (unpushed
// local merges), the feature worktree branches from local develop. The flow
// range must contain ONLY the feature commits.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
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

// AIDEV-NOTE: PMR-W9TE — fixture isolation. Two ways the git calls below could
// reach the INVOKING checkout (a real flow worktree) instead of the mkdtemp
// sandbox, both observed corrupting that checkout:
//
//  1. env leak (the pre-push case). Inside a git hook (lefthook pre-push,
//     post-checkout, ...) git exports repo-pointing vars: GIT_DIR,
//     GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, ...
//     execFileSync inherits process.env, and an ABSOLUTE GIT_DIR wins over the
//     `cwd` option — so every fixture git command silently ran against the
//     hook's repo no matter how correct the cwd was. Fix: sandboxEnv() drops
//     every GIT_* key. The fixture sets its identity with `-c user.name` /
//     `-c user.email`, so GIT_AUTHOR_* / GIT_COMMITTER_* are not needed.
//  2. cwd fallback. `execFileSync(cmd, args, { cwd: undefined })` runs in
//     process.cwd() — the invoking checkout. Fix: assertSandboxCwd() turns any
//     cwd that is not inside a registered mkdtemp root into a loud test error
//     instead of checkout corruption.
//
// Same leak class as PMR-S6W3 (childGitEnv() in pi-interactive-subagents), but
// cross-package runtime imports are repo-verboten, so this file keeps its own
// minimal version.
const sandboxRoots = new Set<string>()

/** Realpath when the path exists, plain resolve otherwise (ENOENT-safe). */
function normalizeDir(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Register a test's mkdtemp root and return it for use as the sandbox base. */
function registerSandbox(root: string): string {
  sandboxRoots.add(normalizeDir(root))
  return root
}

/**
 * Guard every cwd handed to a child process. Throws (never an error result)
 * so a leak surfaces as a failing test, not as a mangled real repo.
 */
function assertSandboxCwd(cwd: string | undefined, site: string): string {
  if (!cwd) {
    throw new Error(
      `PMR-W9TE fixture isolation: ${site} has no cwd — it would run in the invoking checkout ('${process.cwd()}')`,
    )
  }
  const resolved = normalizeDir(cwd)
  for (const root of sandboxRoots) {
    const rel = path.relative(root, resolved)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return cwd
    }
  }
  throw new Error(
    `PMR-W9TE fixture isolation: ${site} cwd '${cwd}' is outside every registered sandbox root (${[
      ...sandboxRoots,
    ].join(', ')}) — refusing to touch a real repo`,
  )
}

/** process.env without any GIT_* var (repo-pointing and identity both). */
function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('GIT_')) continue
    env[key] = value
  }
  return env
}

const exec: Exec = async (cmd, args, options) => {
  // AIDEV-NOTE: PMR-W9TE — the guard runs BEFORE the try block: an
  // out-of-sandbox cwd must escape as a test error, not be swallowed by the
  // catch below into a `{ code: 1 }` result the production code handles
  // gracefully.
  assertSandboxCwd(options?.cwd, `exec '${cmd} ${args.join(' ')}'`)
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: options?.cwd,
      env: sandboxEnv(),
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
  const sandbox = assertSandboxCwd(cwd, `git '${args.join(' ')}'`)
  return execFileSync('git', args, {
    cwd: sandbox,
    env: sandboxEnv(),
    encoding: 'utf8',
  }).trim()
}

function commit(cwd: string, file: string, msg: string): void {
  const sandbox = assertSandboxCwd(cwd, `commit '${msg}'`)
  execFileSync('sh', ['-c', `echo "${msg}" >> ${file}`], {
    cwd: sandbox,
    env: sandboxEnv(),
  })
  git(sandbox, 'add', '-A')
  git(
    sandbox,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    msg,
  )
}

for (const baseBranch of ['main', 'develop', 'staging']) {
  test(`real git: range == feature commits only (base ${baseBranch}, origin behind local)`, async () => {
    const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'fb-')))
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
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'fb-')))
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', repo)
  commit(repo, 'a.txt', 'initial')
  const sha = git(repo, 'rev-parse', 'HEAD')
  const r = await resolveFlowRange(exec, repo, 'master', sha)
  assert.equal(r.ok, false)
})
