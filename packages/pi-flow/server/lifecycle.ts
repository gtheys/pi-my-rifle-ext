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
    return { status: 'spawn-timeout' }
  } catch (err) {
    return { status: 'spawn-failed', reason: String(err) }
  }
}
