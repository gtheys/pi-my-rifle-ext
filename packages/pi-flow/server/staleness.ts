// AIDEV-NOTE: PMR-7B8M — session-side daemon staleness check. The daemon
// records its spawner checkout's SHA in the pidfile; a later session compares
// that SHA against its own HEAD via `git merge-base --is-ancestor`:
//   exit 0 → fresh (silent) | exit 1 → STALE (warn + restart command)
//   other → cannot judge (different repo / missing object / broken git) →
//           typed unknown, SILENT — cross-repo daemons must not false-positive.
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
  | { kind: 'stale'; pid: number; daemonSha: string; headSha: string }
  | { kind: 'unknown'; pid: number; reason: 'no-gitsha' | 'git-error' }
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
  headSha: () => Promise<string | null>
  isAncestor: (daemonSha: string, headSha: string) => Promise<boolean | null>
}

/**
 * Verdict for the current session against the running daemon. HEAD is
 * resolved FIRST: outside a repo there is nothing to compare against, so the
 * pidfile is never read (unchecked/no-repo).
 */
export async function checkDaemonStaleness(
  deps: StalenessDeps,
): Promise<DaemonStaleness> {
  const head = await deps.headSha()
  if (head === null) return { kind: 'unchecked', reason: 'no-repo' }
  const probe = await deps.probe()
  if (!probe.alive) return { kind: 'unchecked', reason: 'daemon-not-running' }
  // AIDEV-NOTE: PMR-7B8M — empty string counts as absent: parsePidfile keeps
  // any string, and `git merge-base --is-ancestor "" <head>` would only
  // produce a git error. An unusable SHA is the actionable "no provenance"
  // case (restart recommended), never a silent one.
  if (probe.gitSha === undefined || probe.gitSha === '') {
    return { kind: 'unknown', pid: probe.pid, reason: 'no-gitsha' }
  }
  const ancestor = await deps.isAncestor(probe.gitSha, head)
  if (ancestor === null) {
    return { kind: 'unknown', pid: probe.pid, reason: 'git-error' }
  }
  if (ancestor) return { kind: 'fresh' }
  return {
    kind: 'stale',
    pid: probe.pid,
    daemonSha: probe.gitSha,
    headSha: head,
  }
}

/**
 * Warning text (no prefix — callers add `pi-flow: `), or null when there is
 * nothing to act on. Single source for ALL three surfaces (session_start,
 * /flow start, /flow-reconcile-push) so they cannot drift.
 */
export function daemonStalenessMessage(st: DaemonStaleness): string | null {
  if (st.kind === 'stale') {
    return `daemon is running stale code — started from ${st.daemonSha.slice(0, 7)}, this checkout is at ${st.headSha.slice(0, 7)}. Restart: kill ${st.pid} — the daemon is re-ensured at the next /flow start.`
  }
  if (st.kind === 'unknown' && st.reason === 'no-gitsha') {
    return `daemon predates staleness tracking (pidfile has no git SHA) — restart recommended: kill ${st.pid} — the daemon is re-ensured at the next /flow start.`
  }
  return null
}

/** The session's own checkout HEAD as 40-hex, or null (not a repo, git
 *  broken/missing, unexpected output). Never throws. */
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
 * Ancestry probe: true = daemon SHA is contained in the session history
 * (fresh), false = the daemon predates it (stale), null = git could not
 * judge (exit > 1 or a thrown exec) — callers must stay silent on null.
 * Never throws.
 */
export async function mergeBaseIsAncestor(
  exec: StalenessExec,
  daemonSha: string,
  headSha: string,
  cwd?: string,
): Promise<boolean | null> {
  const options: { cwd?: string } = {}
  if (cwd !== undefined) options.cwd = cwd
  try {
    const result = await exec(
      'git',
      ['merge-base', '--is-ancestor', daemonSha, headSha],
      options,
    )
    if (result.code === 0) return true
    if (result.code === 1) return false
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
    headSha: () => resolveHeadSha(exec, cwd),
    isAncestor: (daemonSha, headSha) =>
      mergeBaseIsAncestor(exec, daemonSha, headSha, cwd),
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
