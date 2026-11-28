// AIDEV-NOTE: PMR-7B8M rev 1 — session-side daemon staleness check. The daemon
// records its spawner checkout's SHA in the pidfile; a later session compares
// that SHA against the MAIN-CHECKOUT HEAD (resolved from any worktree via
// `git worktree list --porcelain`) with plain string equality:
//   equal → fresh (silent) | different → STALE (warn + restart command)
//   main HEAD unresolvable → unchecked/no-repo, SILENT (nothing to compare).
// Ancestry (`git merge-base --is-ancestor`) was REMOVED here: the 1.5 smoke
// proved it inverted — when main moves FORWARD (the Nov 26 incident: daemon at
// the Nov 21 SHA, HEAD at a descendant Nov 24 SHA) the daemon SHA stays an
// ancestor → "fresh" → silent. Equality against main HEAD catches exactly that.
// A pidfile without gitSha (daemon predates PMR-7B8M) is unknown + WARN
// "restart recommended". Staleness NEVER respawns — only the protocol-version
// pin does (EXPECTED_SERVER_PROTOCOL_VERSION stays untouched).
//
// AIDEV-NOTE: PMR-7B8M rev 2 — the daemon is ONE GLOBAL process (a single
// ~/.pi/agent/pi-flow/server.pid serves every repo: the live runs dir holds
// work-mode AA-*/HML-* runs next to personal PMR-* ones). A bare SHA therefore
// says nothing about THIS repo: a /flow start in repo A + any later session in
// repo B was a permanent false "daemon is running stale code — kill <pid>"
// warning for a healthy daemon (validate review P1, the rev-1 blocker). Rev 0
// guarded this by accident (merge-base exits 128 for an object absent from the
// repo → unknown/git-error → silent); rev 1's plain equality dropped it.
// The pidfile now carries a second advisory field, gitRoot — the MAIN-worktree
// path of the spawning repo — surfaced on ProbeResult as `mainWorktree` (PMR-8620:
// the on-disk key keeps its name for upgrade compatibility, but it is NOT the
// journal run-input gitRoot, which is the session's own worktree root).
// path of the spawning repo — and the verdict checks repo identity BEFORE the
// SHA verdict (see checkDaemonStaleness).
//
// Session-side ONLY: git runs exclusively through the injected StalenessExec
// seam (pi.exec), so this module imports no child_process and the daemon never
// loads it. Every seam is never-throws (null on failure), like
// resolveSessionRepoRoot in herdr/sync.ts.
import { type ProbeResult, probeDaemon } from './lifecycle.ts'

/** The MAIN worktree of a repo: its path plus the HEAD commit recorded there.
 *  Both halves come from one `git worktree list --porcelain` call, so the path
 *  is comparable across sessions by plain string equality. */
export interface MainCheckout {
  path: string
  headSha: string
}

export type DaemonStaleness =
  | { kind: 'fresh' }
  | { kind: 'stale'; pid: number; daemonSha: string; mainHeadSha: string }
  | { kind: 'unknown'; pid: number; reason: 'no-gitsha' }
  | {
      kind: 'unchecked'
      reason:
        | 'daemon-not-running'
        | 'no-repo'
        /** pidfile has a SHA but no repo identity (intermediate build) */
        | 'no-gitroot'
        /** the global daemon was spawned from a different repo */
        | 'other-repo'
    }

/** Narrow structural slice of pi.exec (ExecResult.code carries the exit
 *  status; pi.exec does not throw on non-zero exit but may throw on spawn
 *  failure — every seam below wraps that). */
export type StalenessExec = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; code: number }>

export interface StalenessDeps {
  probe: () => Promise<ProbeResult>
  mainCheckout: () => Promise<MainCheckout | null>
}

/**
 * Verdict for the current session against the running daemon. Order matters
 * and is pinned by test/server-staleness.test.ts:
 *
 *  1. main checkout unresolvable → unchecked/no-repo (silent)
 *  2. daemon not alive          → unchecked/daemon-not-running (silent)
 *  3. pidfile has no usable gitSha → unknown/no-gitsha (**warns**)
 *  4. pidfile has no usable gitRoot (probe.mainWorktree) → unchecked/no-gitroot (silent)
 *  5. probe.mainWorktree ≠ this main worktree → unchecked/other-repo (silent)
 *  6. gitSha === main.headSha → fresh, else stale
 *
 * AIDEV-NOTE: PMR-7B8M rev 2 — repo identity is checked BEFORE the SHA verdict
 * because the SHA alone is meaningless for a global daemon (review P1).
 *
 * AIDEV-NOTE: PMR-7B8M rev 2 — why no-gitsha WARNS but no-gitroot stays
 * SILENT: a pidfile with neither field is the known migration case (a daemon
 * started by a build that predates this feature, on this machine) and telling
 * the user to restart it is actionable. A pidfile with a SHA but NO repo
 * identity was written by an intermediate build (rev 1 shipped gitSha without
 * gitRoot); its SHA could belong to ANY repo, so warning would re-create the
 * exact cross-repo false positive this revision fixes. Never guess.
 */
export async function checkDaemonStaleness(
  deps: StalenessDeps,
): Promise<DaemonStaleness> {
  const main = await deps.mainCheckout()
  if (main === null) return { kind: 'unchecked', reason: 'no-repo' }
  const probe = await deps.probe()
  if (!probe.alive) return { kind: 'unchecked', reason: 'daemon-not-running' }
  // AIDEV-NOTE: PMR-7B8M — empty string counts as absent: parsePidfile keeps
  // any string, and an empty SHA could never equal a real main HEAD, so it is
  // the same "no provenance" case. An unusable SHA is the actionable warning,
  // never a silent one.
  if (probe.gitSha === undefined || probe.gitSha === '') {
    return { kind: 'unknown', pid: probe.pid, reason: 'no-gitsha' }
  }
  // Rev 2: same "empty counts as absent" posture for the repo identity, but
  // the verdict is silent (see the AIDEV-NOTE above). PMR-8620: the probe field
  // is `mainWorktree` — the MAIN worktree of the spawning repo, which is what
  // `main.path` is too; a session's own worktree root would never match.
  if (probe.mainWorktree === undefined || probe.mainWorktree === '') {
    return { kind: 'unchecked', reason: 'no-gitroot' }
  }
  // Rev 2: plain string equality on paths is enough — both sides come from the
  // same git plumbing (`worktree list` prints absolute, un-normalised paths),
  // so a symlinked or trailing-slash variant would have to differ in git's own
  // output, not ours.
  if (probe.mainWorktree !== main.path) {
    return { kind: 'unchecked', reason: 'other-repo' }
  }
  // Rev 1: string equality, not ancestry. A worktree session stays quiet while
  // main is unchanged (its own commits never move main HEAD); a daemon spawned
  // from an unmerged branch warns until merged or restarted — accepted, the
  // daemon really does run unmerged code.
  if (probe.gitSha === main.headSha) return { kind: 'fresh' }
  return {
    kind: 'stale',
    pid: probe.pid,
    daemonSha: probe.gitSha,
    mainHeadSha: main.headSha,
  }
}

/**
 * Warning text (no prefix — callers add `pi-flow: `), or null when there is
 * nothing to act on. Single source for ALL three surfaces (session_start,
 * /flow start, /flow-reconcile-push) so they cannot drift.
 * AIDEV-NOTE: PMR-7B8M rev 2 — unchanged: every new silent verdict is an
 * 'unchecked' kind, which already maps to null here.
 */
export function daemonStalenessMessage(st: DaemonStaleness): string | null {
  if (st.kind === 'stale') {
    return `daemon is running stale code — started from ${st.daemonSha.slice(0, 7)}, the main checkout is at ${st.mainHeadSha.slice(0, 7)}. Restart: kill ${st.pid} — the daemon is re-ensured at the next /flow start.`
  }
  if (st.kind === 'unknown' && st.reason === 'no-gitsha') {
    return `daemon predates staleness tracking (pidfile has no git SHA) — restart recommended: kill ${st.pid} — the daemon is re-ensured at the next /flow start.`
  }
  return null
}

/**
 * The session's own checkout HEAD as 40-hex, or null (not a repo, git
 * broken/missing, unexpected output). Never throws.
 *  AIDEV-NOTE: PMR-7B8M — kept for the SPAWN-side provenance only (index.ts
 *  /flow start records the spawning session's own HEAD in the pidfile); the
 *  staleness verdict itself compares against the main checkout, see
 *  resolveMainCheckout. */
export async function resolveHeadSha(
  exec: StalenessExec,
  cwd?: string,
): Promise<string | null> {
  const options: { cwd?: string } = {}
  if (cwd !== undefined) options.cwd = cwd
  try {
    const result = await exec('git', ['rev-parse', 'HEAD'], options)
    const sha = result.stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) return null
    return sha
  } catch {
    return null
  }
}

/**
 * The MAIN worktree of the repo containing `cwd`: its path and HEAD sha, or
 * null. Never throws.
 *
 * AIDEV-NOTE: PMR-7B8M rev 1 — `git worktree list --porcelain` always lists
 * the main worktree FIRST (git-worktree docs); blocks are separated by blank
 * lines and each starts with a `worktree <path>` line followed by its
 * `HEAD <sha>` line. So the answer is the first `worktree`/`HEAD` pair before
 * the first blank line — ONE call yields both halves (rev 2), which is what
 * makes the path comparison sound: the recorded gitRoot and the compared
 * main.path are produced by identical plumbing.
 * AIDEV-NOTE: PMR-7B8M rev 2 — an unborn HEAD (fresh repo, no commits) prints
 * no `HEAD` line at all → null → the verdict is unchecked/no-repo, silent. Same
 * for a non-repo, a broken git, an empty path, or a non-hex SHA — we never
 * guess, never false-positive.
 */
export async function resolveMainCheckout(
  exec: StalenessExec,
  cwd?: string,
): Promise<MainCheckout | null> {
  const options: { cwd?: string } = {}
  if (cwd !== undefined) options.cwd = cwd
  try {
    const result = await exec(
      'git',
      ['worktree', 'list', '--porcelain'],
      options,
    )
    if (result.code !== 0) return null
    let mainPath: string | null = null
    let headSha: string | null = null
    for (const line of result.stdout.split('\n')) {
      // Blank line ends the first (main) block.
      if (line === '') break
      if (mainPath === null && line.startsWith('worktree ')) {
        mainPath = line.slice('worktree '.length).trim()
        continue
      }
      if (headSha === null && line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length).trim()
      }
    }
    if (mainPath === null || mainPath === '') return null
    if (headSha === null || !/^[0-9a-f]{40}$/.test(headSha)) return null
    return { path: mainPath, headSha }
  } catch {
    return null
  }
}

/** Session wiring: deps from a pi.exec-shaped seam. `cwd` is the SESSION cwd —
 *  AIDEV-NOTE: PMR-7B8M rev 2 (review P2) — callers must pass it explicitly;
 *  omitting it lets pi.exec fall back to pi's load-time cwd, which judges a
 *  different repo than the session is actually in. */
export function sessionStalenessDeps(
  exec: StalenessExec,
  agentDir: string,
  cwd?: string,
): StalenessDeps {
  return {
    probe: () => probeDaemon(agentDir),
    mainCheckout: () => resolveMainCheckout(exec, cwd),
  }
}

/** Probe + notify, never throws. Shared by session_start and /flow start. */
export async function warnDaemonStaleness(
  deps: StalenessDeps,
  notify: (message: string, level: 'warning') => void,
): Promise<void> {
  const staleness = await checkDaemonStaleness(deps)
  const message = daemonStalenessMessage(staleness)
  if (message !== null) notify(`pi-flow: ${message}`, 'warning')
}
