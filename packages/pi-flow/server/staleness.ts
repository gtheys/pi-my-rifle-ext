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
// Session-side ONLY: git runs exclusively through the injected StalenessExec
// seam (pi.exec), so this module imports no child_process and the daemon never
// loads it. Every seam is never-throws (null on failure), like
// resolveSessionRepoRoot in herdr/sync.ts.
import { type ProbeResult, probeDaemon } from './lifecycle.ts'

export type DaemonStaleness =
  | { kind: 'fresh' }
  | { kind: 'stale'; pid: number; daemonSha: string; mainHeadSha: string }
  | { kind: 'unknown'; pid: number; reason: 'no-gitsha' }
  | { kind: 'unchecked'; reason: 'daemon-not-running' | 'no-repo' }

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
  mainHeadSha: () => Promise<string | null>
}

/**
 * Verdict for the current session against the running daemon. The MAIN-checkout
 * HEAD is resolved FIRST: outside a repo there is nothing to compare against,
 * so the pidfile is never read (unchecked/no-repo).
 */
export async function checkDaemonStaleness(
  deps: StalenessDeps,
): Promise<DaemonStaleness> {
  const mainHead = await deps.mainHeadSha()
  if (mainHead === null) return { kind: 'unchecked', reason: 'no-repo' }
  const probe = await deps.probe()
  if (!probe.alive) return { kind: 'unchecked', reason: 'daemon-not-running' }
  // AIDEV-NOTE: PMR-7B8M — empty string counts as absent: parsePidfile keeps
  // any string, and an empty SHA could never equal a real main HEAD, so it is
  // the same "no provenance" case. An unusable SHA is the actionable warning,
  // never a silent one.
  if (probe.gitSha === undefined || probe.gitSha === '') {
    return { kind: 'unknown', pid: probe.pid, reason: 'no-gitsha' }
  }
  // Rev 1: string equality, not ancestry. A worktree session stays quiet while
  // main is unchanged (its own commits never move main HEAD); a daemon spawned
  // from an unmerged branch warns until merged or restarted — accepted, the
  // daemon really does run unmerged code.
  if (probe.gitSha === mainHead) return { kind: 'fresh' }
  return {
    kind: 'stale',
    pid: probe.pid,
    daemonSha: probe.gitSha,
    mainHeadSha: mainHead,
  }
}

/**
 * Warning text (no prefix — callers add `pi-flow: `), or null when there is
 * nothing to act on. Single source for ALL three surfaces (session_start,
 * /flow start, /flow-reconcile-push) so they cannot drift.
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

/** The session's own checkout HEAD as 40-hex, or null (not a repo, git
 *  broken/missing, unexpected output). Never throws.
 *  AIDEV-NOTE: PMR-7B8M — kept for the SPAWN-side provenance only (index.ts
 *  /flow start records the spawning session's own HEAD in the pidfile); the
 *  staleness verdict itself compares against the main checkout, see
 *  resolveMainHeadSha. */
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
 * The MAIN-checkout HEAD as 40-hex, resolved from ANY worktree, or null.
 * Never throws.
 *
 * AIDEV-NOTE: PMR-7B8M rev 1 — `git worktree list --porcelain` always lists
 * the main worktree FIRST (git-worktree docs); blocks are separated by blank
 * lines and each starts with a `worktree <path>` line followed by its
 * `HEAD <sha>` line. So the answer is the first `HEAD` line before the first
 * blank line. An unborn HEAD (fresh repo, no commits) prints no `HEAD` line at
 * all → null → the verdict is unchecked/no-repo, silent. Same for a non-repo,
 * a broken git, or a non-hex value — we never guess, never false-positive.
 */
export async function resolveMainHeadSha(
  exec: StalenessExec,
  cwd?: string,
): Promise<string | null> {
  const options: { cwd?: string } = {}
  if (cwd !== undefined) options.cwd = cwd
  try {
    const result = await exec(
      'git',
      ['worktree', 'list', '--porcelain'],
      options,
    )
    if (result.code !== 0) return null
    for (const line of result.stdout.split('\n')) {
      // Blank line ends the first (main) block — no HEAD there, no verdict.
      if (line === '') break
      if (line.startsWith('HEAD ')) {
        const sha = line.slice('HEAD '.length).trim()
        if (!/^[0-9a-f]{40}$/.test(sha)) return null
        return sha
      }
    }
    return null
  } catch {
    return null
  }
}

/** Session wiring: deps from a pi.exec-shaped seam. */
export function sessionStalenessDeps(
  exec: StalenessExec,
  agentDir: string,
  cwd?: string,
): StalenessDeps {
  return {
    probe: () => probeDaemon(agentDir),
    mainHeadSha: () => resolveMainHeadSha(exec, cwd),
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
