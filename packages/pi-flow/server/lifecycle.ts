// AIDEV-NOTE: PMR-XTQQ — extension-side lifecycle for the pi-flow durable run
// server (server/daemon.ts). Owns the pidfile liveness probe and the
// spawn/respawn decision. NEVER throws: every failure mode (missing/garbage
// pidfile, dead pid, version mismatch, spawn failure, spawn timeout) degrades
// to a typed status — journal writes fall back to the full writer path
// (server/writer.ts) and a flow phase must never break because the daemon
// could not start.
//
// BUMP TOGETHER: EXPECTED_SERVER_PROTOCOL_VERSION pins the pidfile version the
// daemon writes (SERVER_PROTOCOL_VERSION in server/daemon.ts). Two-sided pin
// per plan decision 7 (pattern: HERDR_MIN_VERSION in pi-interactive-subagents
// herdr.ts ↔ EXPECTED_MIN_HERDR_VERSION in herdr/sync.ts): a long-lived daemon
// can outlive a package upgrade, so a mismatch means kill + respawn. The
// value is imported from daemon.ts (same package, single literal) — when
// bumping, update the constant in daemon.ts and this note together.

import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, promises as fsp, openSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_PROTOCOL_VERSION } from './daemon.ts'

/** Pidfile version pin — see BUMP TOGETHER note above. */
export const EXPECTED_SERVER_PROTOCOL_VERSION = SERVER_PROTOCOL_VERSION

const PID_FILE_NAME = 'server.pid'
const SPAWN_LOCK_NAME = 'server.spawn-lock'
const LOG_FILE_NAME = 'server.log'
const POLL_INTERVAL_MS = 50
const SPAWN_READY_BUDGET_MS = 2_000
// AIDEV-NOTE: spawn-in-progress window — a pidfile with a DEAD pid whose
// mtime is younger than this is treated as a spawn racing/just-crashed, not
// as an immediate respawn trigger (prevents trusting a recycled pid and
// prevents two rapid /flow starts from double-spawning). The pidfile is
// written by the daemon child right after startup, so "fresh but dead" means
// either the child died within milliseconds or another ensureDaemon's spawn
// is in flight; either way we wait briefly, re-probe, and only report a
// typed status — never spawn a duplicate ourselves in that window.
const SPAWN_IN_PROGRESS_MAX_AGE_MS = 5_000
const SPAWN_IN_PROGRESS_WAIT_MS = 1_500

export function pidFilePath(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', PID_FILE_NAME)
}

export function spawnLockPath(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', SPAWN_LOCK_NAME)
}

export function logFilePath(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', LOG_FILE_NAME)
}

/** Daemon entry module, derived from this file's location so it works both
 * from the repo and an installed package layout. */
export function daemonEntryPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'daemon.ts')
}

export interface SpawnedProcess {
  pid: number
  unref(): void
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    detached: boolean
    stdio: ['ignore', number, number]
    env: NodeJS.ProcessEnv
  },
) => SpawnedProcess

export interface LifecycleIo {
  /** Pidfile contents, or null when missing/unreadable. */
  readFile: (p: string) => Promise<string | null>
  /** Liveness check — real impl is `process.kill(pid, 0)` in a try/catch. */
  isProcessAlive: (pid: number) => boolean
  /** Best-effort SIGTERM; real impl swallows errors (incl. ESRCH). */
  kill: (pid: number, signal: 'SIGTERM') => void
  spawn: SpawnFn
  mkdir: (p: string) => Promise<void>
  openLogFd: (p: string) => number
  closeFd: (fd: number) => void
  sleep: (ms: number) => Promise<void>
  /** Pidfile mtime in ms, or null when missing/unreadable (injectable clock
   * pairs with `now`). */
  statMtimeMs: (p: string) => Promise<number | null>
  /** Wall clock in ms (injectable so the spawn-in-progress wait costs
   * nothing in tests even with instant sleeps). */
  now: () => number
  // AIDEV-NOTE: PMR-HRGJ — cross-process spawn-claim seam. These are REQUIRED
  // members (no optional/legacy fallback) so a degraded implementation fails
  // loudly instead of silently losing the single-daemon guarantee.
  /** Exclusive create: write `content` at `p` only if it does not exist
   * (real impl: fs open 'wx'). Returns false on EEXIST or any failure. */
  tryCreateExclusive: (p: string, content: string) => Promise<boolean>
  /** Atomic rename of `from` over `to`; false when the rename fails. */
  renameOver: (from: string, to: string) => Promise<boolean>
  /** Best-effort unlink; real impl swallows errors (incl. ENOENT). */
  unlinkFile: (p: string) => Promise<void>
}

function realIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const realIo: LifecycleIo = {
  readFile: async (p) => {
    try {
      return await fsp.readFile(p, 'utf8')
    } catch {
      return null
    }
  },
  isProcessAlive: realIsProcessAlive,
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal)
    } catch {
      // Already dead (ESRCH) or permissions — respawn decision stands either way.
    }
  },
  spawn: (cmd, args, opts) => {
    const child = nodeSpawn(cmd, args, opts)
    return { pid: child.pid ?? -1, unref: () => child.unref() }
  },
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true })
  },
  openLogFd: (p) => openSync(p, 'a'),
  closeFd: (fd) => {
    closeSync(fd)
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  statMtimeMs: async (p) => {
    try {
      const st = await fsp.stat(p)
      return st.mtimeMs
    } catch {
      return null
    }
  },
  now: () => Date.now(),
  // AIDEV-NOTE: PMR-HRGJ — real claim primitives. 'wx' flag = fail if the
  // path exists (the O_EXCL lockfile pattern); any error counts as "lost".
  tryCreateExclusive: async (p, content) => {
    try {
      const fh = await fsp.open(p, 'wx')
      try {
        await fh.writeFile(content, 'utf8')
      } finally {
        await fh.close()
      }
      return true
    } catch {
      return false
    }
  },
  renameOver: async (from, to) => {
    try {
      await fsp.rename(from, to)
      return true
    } catch {
      return false
    }
  },
  unlinkFile: async (p) => {
    try {
      await fsp.unlink(p)
    } catch {
      // Missing/unlinkable lock — nothing to release.
    }
  },
}

export type ProbeResult =
  | { alive: true; pid: number }
  | {
      alive: false
      reason:
        | 'no-pidfile'
        | 'malformed-pidfile'
        | 'dead-process'
        | 'version-mismatch'
      /** Surfaced when the pidfile parsed, so callers can SIGTERM without re-reading. */
      pid?: number
    }

interface ParsedPidfile {
  pid: number
  version: string
}

function parsePidfile(raw: string): ParsedPidfile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as { pid?: unknown; version?: unknown }
  if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid)) return null
  if (typeof rec.version !== 'string') return null
  return { pid: rec.pid, version: rec.version }
}

/** Liveness probe: never throws, every failure mode a distinct reason. */
export async function probeDaemon(
  agentDir: string,
  io: LifecycleIo = realIo,
): Promise<ProbeResult> {
  let raw: string | null = null
  try {
    raw = await io.readFile(pidFilePath(agentDir))
  } catch {
    raw = null
  }
  if (raw === null) return { alive: false, reason: 'no-pidfile' }
  const parsed = parsePidfile(raw)
  if (parsed === null) return { alive: false, reason: 'malformed-pidfile' }
  if (!io.isProcessAlive(parsed.pid)) {
    return { alive: false, reason: 'dead-process', pid: parsed.pid }
  }
  if (parsed.version !== EXPECTED_SERVER_PROTOCOL_VERSION) {
    return {
      alive: false,
      reason: 'version-mismatch',
      pid: parsed.pid,
    }
  }
  return { alive: true, pid: parsed.pid }
}

// AIDEV-NOTE: PMR-HRGJ — spawn claim. Before spawning, ensureDaemon claims
// `server.spawn-lock` (JSON {pid, at}) via exclusive create. Concurrent
// ensureDaemons that lose the claim must NOT spawn (or SIGTERM): they wait
// and re-probe, exactly like the fresh-dead spawnInProgressStatus window.
// A claim is STALE when its claimant pid is provably dead OR its age exceeds
// SPAWN_IN_PROGRESS_MAX_AGE_MS (5s > the 2s spawn budget, so a live spawn can
// never be stolen); stale/garbage claims are stolen atomically via a
// temp-then-rename (exclusive temp write, then renameOver onto the lock —
// losing the rename means someone else claimed first). The winner releases
// the lock in ALL spawn exit paths (spawned / timeout / failed) via try/finally.
interface SpawnClaim {
  pid: number
  at: number
}

function parseSpawnClaim(raw: string): SpawnClaim | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rec = parsed as { pid?: unknown; at?: unknown }
  if (typeof rec.pid !== 'number' || !Number.isInteger(rec.pid)) return null
  if (typeof rec.at !== 'number') return null
  return { pid: rec.pid, at: rec.at }
}

function claimIsStale(claim: SpawnClaim | null, io: LifecycleIo): boolean {
  // Unreadable/garbage claim content → treat as stale so a corrupt lock
  // cannot wedge daemon startup forever.
  if (claim === null) return true
  if (!io.isProcessAlive(claim.pid)) return true
  if (io.now() - claim.at > SPAWN_IN_PROGRESS_MAX_AGE_MS) return true
  return false
}

/**
 * Try to win the spawn claim. Returns `won: true` (with the claim timestamp
 * `at` for ownership-checked release) when the caller may spawn and owns the
 * lock file, including after a stale-claim steal. Never throws.
 */
async function acquireSpawnClaim(
  agentDir: string,
  io: LifecycleIo,
): Promise<{ won: boolean; at: number }> {
  const lockPath = spawnLockPath(agentDir)
  const myAt = io.now()
  const claimJson = JSON.stringify({ pid: process.pid, at: myAt })
  const won = await io.tryCreateExclusive(lockPath, claimJson)
  if (won) return { won: true, at: myAt }

  // Contended: is the existing claim stale enough to steal?
  let raw: string | null = null
  try {
    raw = await io.readFile(lockPath)
  } catch {
    raw = null
  }
  const existing = parseSpawnClaim(raw ?? '')
  // PMR-HRGJ: young-empty-lock guard — between open('wx') and the content
  // write the lock exists but is EMPTY; parsing it yields null and the old
  // code treated that as "stale", clobbering the winner's fresh claim. If
  // the unparsable/empty lock is YOUNG (mtime within the age bound), a
  // winner is writing it right now → contend, never steal. Old (or
  // unmeasurable) empty/garbage locks stay stale → steal below.
  if (existing === null) {
    let lockMtime: number | null = null
    try {
      lockMtime = await io.statMtimeMs(lockPath)
    } catch {
      lockMtime = null
    }
    if (
      lockMtime !== null &&
      io.now() - lockMtime <= SPAWN_IN_PROGRESS_MAX_AGE_MS
    ) {
      return { won: false, at: myAt }
    }
  }
  if (!claimIsStale(existing, io)) return { won: false, at: myAt }

  // Atomic steal: exclusive temp claim, then rename over the lock. Losing
  // the rename means another contender claimed/refreshed first.
  const tmpPath = `${lockPath}.${process.pid}.${io.now()}.tmp`
  const tmpCreated = await io.tryCreateExclusive(tmpPath, claimJson)
  if (!tmpCreated) return { won: false, at: myAt }
  const stolen = await io.renameOver(tmpPath, lockPath)
  if (stolen) {
    // PMR-HRGJ — rename replaces UNCONDITIONALLY, so a faster contender's
    // steal can land between our stale-claim read and our rename; both
    // renames then "succeed" but only the last claim on the lock is real.
    // Read the lock back and spawn only if it still holds OUR claim —
    // otherwise we lost the steal race and must contend, never spawn twice.
    const verifyRaw = await io.readFile(lockPath)
    const verified = parseSpawnClaim(verifyRaw ?? '')
    if (
      verified !== null &&
      verified.pid === process.pid &&
      verified.at === myAt
    ) {
      return { won: true, at: myAt }
    }
    return { won: false, at: myAt }
  }
  await io.unlinkFile(tmpPath)
  return { won: false, at: myAt }
}

// PMR-HRGJ: ownership-checked release — the winner may be >5s stalled, by
// which time a contender has legitimately stolen the aged claim and is
// spawning under it. A blind unlink would delete the STEALER's fresh claim
// and re-open the double-spawn window. Only unlink when the lock still holds
// OUR pid + OUR claim timestamp; otherwise leave it alone.
async function releaseSpawnClaimIfOwned(
  agentDir: string,
  io: LifecycleIo,
  myAt: number,
): Promise<void> {
  const lockPath = spawnLockPath(agentDir)
  let raw: string | null = null
  try {
    raw = await io.readFile(lockPath)
  } catch {
    raw = null
  }
  const claim = parseSpawnClaim(raw ?? '')
  if (claim !== null && claim.pid === process.pid && claim.at === myAt) {
    await io.unlinkFile(lockPath)
  }
}

/**
 * Wait-and-reprobe when another session owns a live spawn claim. Mirrors
 * spawnInProgressStatus's bounded wait (statuses reused, enum unchanged).
 */
async function contendedStatus(
  agentDir: string,
  io: LifecycleIo,
): Promise<EnsureDaemonResult> {
  const deadline = io.now() + SPAWN_IN_PROGRESS_WAIT_MS
  while (io.now() < deadline) {
    await io.sleep(POLL_INTERVAL_MS)
    const check = await probeDaemon(agentDir, io)
    if (check.alive) return { status: 'already-running', pid: check.pid }
  }
  return { status: 'spawn-in-progress' }
}

export type EnsureDaemonResult =
  | { status: 'already-running'; pid: number }
  | { status: 'spawned'; pid: number }
  | { status: 'spawn-timeout' }
  | { status: 'spawn-failed'; reason: string }
  | { status: 'spawn-in-progress' }

/**
 * Spawn-in-progress guard: when the pidfile holds a DEAD pid but is FRESH
 * (mtime within SPAWN_IN_PROGRESS_MAX_AGE_MS), another ensureDaemon's spawn
 * may be in flight (or a just-started daemon died instantly). Do not spawn a
 * duplicate: wait up to SPAWN_IN_PROGRESS_WAIT_MS (injectable clock via
 * io.now/io.sleep), re-probing as we go. Daemon came up (or the pidfile was
 * replaced by a live one) → 'already-running'. Still dead after the wait →
 * 'spawn-in-progress' so the caller's journal write degrades to the full
 * writer path without a double-spawn. Old/missing/unreadable pidfile → null
 * (caller falls through to the normal respawn decision). Never throws.
 */
async function spawnInProgressStatus(
  agentDir: string,
  io: LifecycleIo,
): Promise<EnsureDaemonResult | null> {
  let mtimeMs: number | null = null
  try {
    mtimeMs = await io.statMtimeMs(pidFilePath(agentDir))
  } catch {
    mtimeMs = null
  }
  if (mtimeMs === null) return null
  const age = io.now() - mtimeMs
  // Negative age = clock skew / just-written: treat as fresh.
  if (age > SPAWN_IN_PROGRESS_MAX_AGE_MS) return null
  const deadline = io.now() + SPAWN_IN_PROGRESS_WAIT_MS
  let last: ProbeResult = { alive: false, reason: 'dead-process' }
  while (io.now() < deadline) {
    await io.sleep(POLL_INTERVAL_MS)
    last = await probeDaemon(agentDir, io)
    if (last.alive) return { status: 'already-running', pid: last.pid }
  }
  return { status: 'spawn-in-progress' }
}

/**
 * Ensure a live, version-matching daemon. Alive+matching → no-op; stale,
 * mismatched or dead → best-effort SIGTERM of the old pid, then spawn
 * detached with stdio → server.log, unref, and poll ≤2s for the fresh
 * pidfile. Never throws — degradation is a status, not an error.
 */
export async function ensureDaemon(
  agentDir: string,
  io: LifecycleIo = realIo,
): Promise<EnsureDaemonResult> {
  try {
    const probe = await probeDaemon(agentDir, io)
    if (probe.alive) return { status: 'already-running', pid: probe.pid }

    // Fresh dead pidfile → spawn-in-progress window (see the anchor note on
    // the constants): never spawn a duplicate, just wait + re-probe.
    if (probe.reason === 'dead-process') {
      const inProgress = await spawnInProgressStatus(agentDir, io)
      if (inProgress !== null) return inProgress
    }

    // PMR-HRGJ: cross-process claim before any SIGTERM/spawn — with NO
    // pidfile the fresh-dead window below cannot fire, so this lock is the
    // only guard against two concurrent ensureDaemons double-spawning.
    const claim = await acquireSpawnClaim(agentDir, io)
    if (!claim.won) return await contendedStatus(agentDir, io)
    // PMR-HRGJ: keepClaim — on spawn-timeout the claim is deliberately KEPT:
    // the child may still be >2s from writing its pidfile, so releasing
    // would let a contender spawn a duplicate while the slow child is
    // starting. The SPAWN_IN_PROGRESS_MAX_AGE_MS (5s) age bound reclaims the
    // claim eventually — a contender steals it once stale, and until then
    // contention resolves via wait-and-reprobe (contendedStatus).
    let keepClaim = false
    try {
      // PMR-HRGJ: post-claim re-probe — the pre-claim probe above is a
      // STALE OBSERVATION once we hold the claim. Two interleavings:
      // (a) a scheduling/GC stall in the probe→claim gap lets a rival
      //     complete claim→spawn→pidfile→release; we then win the now-free
      //     lock and would spawn over a live daemon;
      // (b) a claimant SIGKILLed after spawning but before release leaves a
      //     dead-claimant lock that we steal while the orphan child is still
      //     starting.
      // Re-probing here fully closes (a) and shrinks (b) to the sub-window
      // where the orphan's pidfile has not yet landed. Recording the child
      // pid in the claim was considered and deferred — the child pid is
      // unknowable before spawn().
      const reprobe = await probeDaemon(agentDir, io)
      if (reprobe.alive) {
        return { status: 'already-running', pid: reprobe.pid }
      }

      // Best-effort SIGTERM of a stale/mismatched daemon; the dead-process
      // case carries a pid too but killing it is pointless — kill() swallows
      // ESRCH either way, so a single unguarded call is fine.
      if (probe.pid !== undefined) {
        io.kill(probe.pid, 'SIGTERM')
      }

      await io.mkdir(path.join(agentDir, 'pi-flow'))
      const logFd = io.openLogFd(logFilePath(agentDir))
      let child: SpawnedProcess
      try {
        child = io.spawn(process.execPath, [daemonEntryPath()], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...process.env, PI_FLOW_AGENT_DIR: agentDir },
        })
      } finally {
        io.closeFd(logFd)
      }
      child.unref()

      // Bounded readiness poll: the real daemon writes its pidfile right after
      // startup; sleep is injectable so this loop costs nothing in tests.
      const maxPolls = SPAWN_READY_BUDGET_MS / POLL_INTERVAL_MS
      for (let i = 0; i < maxPolls; i += 1) {
        await io.sleep(POLL_INTERVAL_MS)
        const check = await probeDaemon(agentDir, io)
        if (check.alive) return { status: 'spawned', pid: check.pid }
      }
      keepClaim = true
      return { status: 'spawn-timeout' }
    } finally {
      // Release in all exit paths EXCEPT spawn-timeout (keepClaim above);
      // the thrown-error case still lands in the outer catch as
      // spawn-failed. Release is ownership-checked: a stealer's fresh claim
      // must survive our stalled finally.
      if (!keepClaim) {
        await releaseSpawnClaimIfOwned(agentDir, io, claim.at)
      }
    }
  } catch (err) {
    return { status: 'spawn-failed', reason: String(err) }
  }
}
