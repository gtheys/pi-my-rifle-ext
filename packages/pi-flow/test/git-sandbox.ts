// AIDEV-NOTE: PMR-W9TE — shared REAL-git fixture isolation. Hoisted out of
// test/flow-base-real-git.test.ts (round 1) so every real-git fixture in this
// package shares one implementation; `node --test test/*.test.ts` gives each
// file its own process, so the registry below is per-file state.
//
// Two ways a fixture's git calls could reach the INVOKING checkout (a real
// flow worktree) instead of the mkdtemp sandbox, both observed corrupting
// that checkout:
//
//  1. env leak (the pre-push case). Inside a git hook (lefthook pre-push,
//     post-checkout, ...) git exports repo-pointing vars: GIT_DIR,
//     GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, ...
//     execFileSync/execFile inherit process.env, and an ABSOLUTE GIT_DIR wins
//     over the `cwd` option — so every fixture git command silently ran
//     against the hook's repo no matter how correct the cwd was. Fix:
//     sandboxEnv() drops every GIT_* key for the calls the fixture makes
//     itself; isolateProcessGitEnv() drops them for the whole fixture process
//     (the only way to reach the git calls buried inside production modules).
//  2. cwd fallback. `execFileSync(cmd, args, { cwd: undefined })` runs in
//     process.cwd() — the invoking checkout. Fix: assertSandboxCwd() turns any
//     cwd that is not inside a registered mkdtemp root into a loud test error
//     instead of checkout corruption.
//
// Same leak class as PMR-S6W3 (childGitEnv() in pi-interactive-subagents), but
// cross-package runtime imports are repo-verboten, so this module keeps its
// own minimal version.
import { execFileSync } from 'node:child_process'
import { realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Exec } from '../shared/diff-base.ts'

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
export function registerSandbox(root: string): string {
  sandboxRoots.add(normalizeDir(root))
  return root
}

/**
 * Guard every cwd handed to a child process. Throws (never an error result)
 * so a leak surfaces as a failing test, not as a mangled real repo.
 */
export function assertSandboxCwd(
  cwd: string | undefined,
  site: string,
): string {
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

// AIDEV-NOTE: PMR-W9TE round 2 — production code pins the repo with
// `git -C <path> …` and NO spawn cwd (tools/code-review-parse.ts,
// review/review.ts), so a bare "a cwd is mandatory" rule rejected legitimate
// sandbox calls. `-C` makes git chdir into <path> first, so <path> is a
// directory to guard just like the spawn cwd: BOTH are checked, and a `-C`
// pointing outside every registered root fails the test exactly like a
// leaked cwd would.
/** The `<path>` of a leading `git -C <path>` pin, if the args carry one. */
function pinnedWorkDir(args: string[]): string | undefined {
  const index = args.indexOf('-C')
  if (index === -1) {
    return undefined
  }
  return args[index + 1]
}

/** Guard the spawn cwd, the `-C` target, or (when neither) fail loudly. */
function guardCall(
  args: string[],
  cwd: string | undefined,
  site: string,
): void {
  const pinned = pinnedWorkDir(args)
  if (cwd !== undefined) {
    assertSandboxCwd(cwd, `${site} (spawn cwd)`)
  }
  if (pinned !== undefined) {
    assertSandboxCwd(pinned, `${site} (-C target)`)
  }
  if (cwd === undefined && pinned === undefined) {
    assertSandboxCwd(undefined, site)
  }
}

/** process.env without any GIT_* var (repo-pointing and identity both). */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('GIT_')) continue
    env[key] = value
  }
  return env
}

// AIDEV-NOTE: PMR-W9TE round 2 — process-level isolation. Production code
// under test (tools/land.ts execAsFlowBase / defaultResolveMainRepo /
// defaultResolveLandingBranch, config.ts's main-checkout lookup) shells out
// through promisified execFile with NO env option, so a fixture-side
// sandboxEnv() cannot reach those calls: an inherited GIT_DIR still re-points
// them at the hook's repo. Repro from the review: with GIT_DIR leaked into
// the land-advancement fixture it created `main` plus an initial commit in an
// unrelated checkout and left HEAD on main. Each real-git fixture therefore
// scrubs GIT_* from ITS OWN process.env at module load. That is contained
// because node's test runner gives every test file its own process, and no
// fixture here needs a GIT_* var (identity comes from `-c user.name` /
// `-c user.email`).
/** Drop every GIT_* var from the fixture process env (idempotent). */
export function isolateProcessGitEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) {
      delete process.env[key]
    }
  }
}

/**
 * execFileSync with the isolation baked in: scrubbed env, guarded cwd.
 * Returns trimmed stdout and throws on a non-zero exit, which is what the
 * fixture-side `git()` helpers have always wanted.
 */
export function runInSandbox(cmd: string, args: string[], cwd: string): string {
  guardCall(args, cwd, `runInSandbox '${cmd} ${args.join(' ')}'`)
  return execFileSync(cmd, args, {
    cwd,
    env: sandboxEnv(),
    encoding: 'utf8',
  }).trim()
}

/**
 * Isolated `Exec` for the seam handed to production code. The guard runs
 * BEFORE the try block: an out-of-sandbox directory must escape as a test
 * error, not be swallowed by the catch below into a `{ code: 1 }` result the
 * production code handles gracefully.
 */
export function makeSandboxExec(): Exec {
  return async (cmd, args, options) => {
    guardCall(args, options?.cwd, `exec '${cmd} ${args.join(' ')}'`)
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
}

/**
 * Remove every registered mkdtemp root. Wire this as a node:test `after()`
 * hook in each real-git fixture so sandbox roots do not pile up in /tmp
 * between runs; force:true keeps it safe when a fixture already cleaned up
 * itself.
 */
export function cleanupSandboxes(): void {
  for (const root of sandboxRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  sandboxRoots.clear()
}
