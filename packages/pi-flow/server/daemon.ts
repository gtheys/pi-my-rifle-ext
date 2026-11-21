// AIDEV-NOTE: PMR-XTQQ — pi-flow durable run server daemon. Own process, own
// event loop (this is what makes fs.watch sanctioned here — see
// plugins/herdr/flow-viewer.mjs and the subagent-done.ts scar tissue; NEVER
// put a watcher inside pi's extension process). The journal is authoritative
// and written by sessions via O_APPEND; this daemon is the ONLY projection
// writer, reprojecting per ref from journal events. Dependency-free beyond
// node built-ins + run-state.ts (whose imports are node:fs/node:path only) —
// it must NOT import @earendil-works/pi-coding-agent; the agent dir arrives
// via PI_FLOW_AGENT_DIR from the spawner.
//
// KEEPALIVE RULE (PMR-XTQQ review fix): the 1s poll interval is the daemon's
// LIVENESS BACKSTOP and must NEVER be unref'd — fs.watch(runsDir) can fail at
// startup (ENOENT: runs/ is only created by the first journal write, and
// ensureDaemon runs before that), and when it does the poll alone must keep
// the event loop alive. Watcher failures degrade silently to the poll
// (close the watcher, never retry fs.watch in a hot loop).
//
// BUMP TOGETHER: SERVER_PROTOCOL_VERSION must be kept in sync with
// server/lifecycle.ts (written in subtask 1.2) — a long-lived daemon can
// outlive a package upgrade, so the pidfile pins the version and a mismatch
// means kill + respawn.
//
// PENDING MAINTENANCE (subtask 3.2): after each per-ref reproject the same
// journal read also drives pending-record maintenance — parked loop-state
// (awaitingOutcome=true, status='running') → writePending (idempotent,
// skipped when the existing record already matches), otherwise → clearPending
// (terminal/paused/halted/done or no run); <ref>.consumed.json files are
// swept once per scan. Pending records are NOT journal events (they live in
// pending/), so writing them does NOT violate the daemon-never-appends-
// journal-events invariant above.

import { promises as fsp, watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type FlowRunEvent,
  type FlowRunState,
  isFlowRunState,
  projectRunState,
  readRunEvents,
  runStatePath,
  runsDir,
} from '../run-state.ts'
import {
  clearPending,
  defaultPendingIo,
  isParkedLoop,
  PENDING_SCHEMA,
  type PendingIo,
  type PendingPhase,
  type PendingRecord,
  parsePendingRecord,
  sweepConsumed,
  writePending,
} from './pending.ts'

export const SERVER_PROTOCOL_VERSION = '1'

const PID_FILE_NAME = 'server.pid'
const LOG_FILE_NAME = 'server.log'
const POLL_INTERVAL_MS = 1_000
const DEBOUNCE_MS = 150

// --- pure helpers (exported for unit tests, recordRunEvent io-seam style) ---

/** Reproject decision: has the projection's serialized JSON changed? Pure. */
export function projectionChanged(
  currentRaw: string | null,
  next: NonNullable<ReturnType<typeof projectRunState>>,
): boolean {
  if (currentRaw === null) return true
  const serialized = `${JSON.stringify(next, null, 2)}\n`
  return currentRaw !== serialized
}

export type ReprojectResult = 'written' | 'unchanged' | 'no-journal'

const defaultReprojectIo = {
  readFile: (p: string) => fsp.readFile(p, 'utf8'),
  writeFile: async (p: string, data: string) => {
    await fsp.writeFile(p, data, 'utf8')
  },
}

interface ReprojectIo {
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, data: string) => Promise<void>
}

export interface ReprojectOutcome {
  result: ReprojectResult
  /** Reprojected state; null when there is no readable journal/projection. */
  state: FlowRunState | null
}

/** AIDEV-NOTE: pending/ lives next to runs/ under <agentDir>/pi-flow/. */
export function pendingDirPath(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', 'pending')
}

/**
 * Pending decision from one journal read: parked loop → 'write', anything
 * else (terminal/paused/halted/done or no run at all) → 'clear'. Pure.
 */
export function decidePending(state: FlowRunState | null): 'write' | 'clear' {
  if (state === null) return 'clear'
  if (isParkedLoop(state.loop)) return 'write'
  return 'clear'
}

function recordsEqual(a: PendingRecord, b: PendingRecord): boolean {
  return (
    a.schema === b.schema &&
    a.ref === b.ref &&
    a.phase === b.phase &&
    a.createdAt === b.createdAt &&
    a.sourceAt === b.sourceAt
  )
}

/**
 * Pending maintenance for one ref, derived from the SAME journal read as the
 * reproject (no second readRunEvents). Parked → idempotent writePending,
 * keeping the original createdAt when only sourceAt advanced, and skipping
 * the write entirely when the on-disk record already matches (the daemon
 * writes on every 1s scan while parked — keep it cheap). Non-parked or
 * no-run → clearPending. Best-effort: failures are logged by the scan task,
 * never thrown into the queue tail.
 */
export async function maintainPending(
  pendingDir: string,
  ref: string,
  state: FlowRunState | null,
  io: PendingIo = defaultPendingIo,
): Promise<void> {
  let existing: PendingRecord | null = null
  const decision = decidePending(state)
  if (decision === 'write') {
    try {
      existing = parsePendingRecord(
        await io.readFile(path.join(pendingDir, `${ref}.json`)),
      )
    } catch {
      existing = null
    }
    const loop = state?.loop
    if (loop === undefined) return
    const phase: PendingPhase = loop.phase
    let createdAt = new Date().toISOString()
    if (
      existing !== null &&
      existing.phase === phase &&
      existing.schema === PENDING_SCHEMA &&
      existing.ref === ref
    ) {
      createdAt = existing.createdAt
    }
    let sourceAt = createdAt
    if (state !== null) {
      sourceAt = state.updatedAt
    }
    const record: PendingRecord = {
      schema: PENDING_SCHEMA,
      ref,
      phase,
      createdAt,
      sourceAt,
    }
    if (existing !== null && recordsEqual(existing, record)) return
    await writePending(pendingDir, record, io)
    return
  }
  await clearPending(pendingDir, ref, io)
}

/**
 * Reproject one run from its journal: read events (torn tails skipped),
 * project, and write the projection atomically-in-process ONLY when the
 * serialized state actually changed. The daemon never appends journal events
 * itself, so the "unchanged = skip" shortcut here is safe (unlike the
 * recordRunEvent main-session bug at run-state.ts:531-537 — see that
 * AIDEV-NOTE).
 */
export async function reprojectRun(
  agentDir: string,
  ref: string,
  io: ReprojectIo = defaultReprojectIo,
): Promise<ReprojectResult> {
  const outcome = await reprojectRunDetailed(agentDir, ref, io)
  return outcome.result
}

/**
 * Same read path as reprojectRun but also returns the reprojected state so
 * the scan's pending-maintenance step needs no second journal read.
 */
export async function reprojectRunDetailed(
  agentDir: string,
  ref: string,
  io: ReprojectIo = defaultReprojectIo,
): Promise<ReprojectOutcome> {
  const events = await readRunEvents(agentDir, ref, { readFile: io.readFile })
  if (events === null) return { result: 'no-journal', state: null }
  const state = projectRunState(events)
  if (state === null) return { result: 'no-journal', state: null }
  const statePath = runStatePath(agentDir, ref)
  if (statePath === null) return { result: 'no-journal', state: null }
  let currentRaw: string | null = null
  try {
    currentRaw = await io.readFile(statePath)
  } catch {
    // missing projection — rebuild below
  }
  if (currentRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(currentRaw)
      if (!isFlowRunState(parsed)) currentRaw = null
    } catch {
      currentRaw = null
    }
  }
  if (!projectionChanged(currentRaw, state)) {
    return { result: 'unchanged', state }
  }
  await io.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  return { result: 'written', state }
}

/**
 * One serial async queue: every reproject and pending-maintenance task goes
 * through here so the daemon never does concurrent read-modify-writes (there
 * are no lock utilities; single-writer serialization is the concurrency
 * story). Pure scheduling — no io, fully unit-testable.
 */
export interface SerialQueue {
  push(task: () => Promise<void>): Promise<void>
  drain(): Promise<void>
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve()
  return {
    push(task: () => Promise<void>): Promise<void> {
      const run = tail.then(task, task)
      // AIDEV-NOTE: the queue must survive task rejections (a failed
      // reproject must not poison subsequent scans); callers of push still
      // get the rejection surfaced through their own awaited promise.
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
    async drain(): Promise<void> {
      // AIDEV-NOTE: awaiting the tail chain covers every task enqueued
      // before the drain call. The previous implementation also kept every
      // settled task promise in a `tracked` array forever — with ~100 tasks
      // per 1s scan that is an unbounded memory leak that OOM-killed the
      // daemon after ~38h (4.9GB heap). Do not reintroduce it.
      await tail
    },
  }
}

/**
 * fs.watch event filter for the runs/ dir: only journal appends are external
 * input worth reacting to. The daemon's own .json projection writes land in
 * the watched dir on every productive scan — rescan-on-own-write turned the
 * watcher into a self-triggering loop amplifier (see the scan model note in
 * main()). A null filename (some platforms never report one) conservatively
 * triggers a rescan — the 1s poll is the correctness backstop either way.
 */
export function isJournalWatchEvent(filename: string | null): boolean {
  if (filename === null) return true
  return filename.endsWith('.journal.jsonl')
}

/** Change signature for one ref's journal: `${size}:${mtimeMs}`. Pure data. */
export interface ScanCacheEntry {
  sig: string
  state: FlowRunState
}

/**
 * Per-ref journal change signatures so the 1s poll skips re-reading and
 * re-parsing journals that have not been appended to since the last scan
 * (~800KB across ~100 refs in practice, every second, forever). When the
 * signature matches, pending maintenance still runs — derived from the
 * cached projection, which is provably identical to a fresh reproject
 * (same journal bytes → same projected state). Entries are dropped on
 * error/no-journal so a deleted-then-recreated journal can never serve a
 * stale cached state.
 */
export interface ScanCache {
  get(ref: string): ScanCacheEntry | undefined
  set(ref: string, sig: string, state: FlowRunState): void
  delete(ref: string): void
}

export function createScanCache(): ScanCache {
  const byRef = new Map<string, ScanCacheEntry>()
  return {
    get(ref: string): ScanCacheEntry | undefined {
      return byRef.get(ref)
    },
    set(ref: string, sig: string, state: FlowRunState): void {
      byRef.set(ref, { sig, state })
    },
    delete(ref: string): void {
      byRef.delete(ref)
    },
  }
}

/**
 * Stat-based change signature for one ref's journal; null when the journal
 * is missing/unreadable (treated as "changed" — the task path handles the
 * no-journal case and clears pending).
 */
async function journalSignature(
  agentDir: string,
  ref: string,
): Promise<string | null> {
  try {
    const st = await fsp.stat(
      path.join(runsDir(agentDir), `${ref}.journal.jsonl`),
    )
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

// --- daemon process ---

function log(agentDir: string, message: string): void {
  // Best-effort append-only lifecycle/error log; failures are swallowed —
  // the daemon must never crash because logging failed.
  const line = `${new Date().toISOString()} ${message}\n`
  fsp
    .appendFile(path.join(agentDir, 'pi-flow', LOG_FILE_NAME), line, 'utf8')
    .catch(() => undefined)
}

/** Scan the runs dir; per ref, reproject + maintain pending from one read,
 * and sweep consumed markers once per scan. Journals whose size+mtime
 * signature matches the previous scan skip the re-read entirely; pending
 * maintenance still runs from the cached projection. */
async function scanRuns(
  agentDir: string,
  queue: SerialQueue,
  cache: ScanCache,
): Promise<void> {
  const dir = runsDir(agentDir)
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return // runs dir does not exist yet — nothing to scan
  }
  const refs: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.journal.jsonl')) continue
    refs.push(entry.slice(0, -'.journal.jsonl'.length))
  }
  const pendingDir = pendingDirPath(agentDir)
  for (const ref of refs) {
    const sig = await journalSignature(agentDir, ref)
    let cached: ScanCacheEntry | undefined
    if (sig !== null) {
      cached = cache.get(ref)
    }
    if (sig !== null && cached !== undefined && cached.sig === sig) {
      // AIDEV-NOTE: unchanged journal — skip the full re-read/parse and
      // maintain pending from the cached projection (identical state →
      // identical decision). Cache is dropped on failure so the next scan
      // falls back to the full task path.
      queue.push(async () => {
        try {
          await maintainPending(pendingDir, ref, cached.state)
        } catch (err) {
          cache.delete(ref)
          log(agentDir, `scan maintenance failed for ${ref}: ${String(err)}`)
        }
      })
      continue
    }
    queue.push(async () => {
      try {
        const outcome = await reprojectRunDetailed(agentDir, ref)
        // Same journal read drives the pending decision (subtask 3.2).
        await maintainPending(pendingDir, ref, outcome.state)
        const sigNow = await journalSignature(agentDir, ref)
        if (outcome.state !== null && sigNow !== null) {
          cache.set(ref, sigNow, outcome.state)
        } else {
          cache.delete(ref)
        }
      } catch (err) {
        cache.delete(ref)
        log(agentDir, `scan maintenance failed for ${ref}: ${String(err)}`)
      }
    })
  }
  if (refs.length > 0) {
    queue.push(async () => {
      await sweepConsumed(pendingDir)
    })
  }
}

function main(): void {
  const agentDir = process.env.PI_FLOW_AGENT_DIR ?? ''
  if (!path.isAbsolute(agentDir)) {
    process.stderr.write('PI_FLOW_AGENT_DIR must be set to an absolute path\n')
    process.exitCode = 1
    return
  }

  const queue = createSerialQueue()
  const scanCache = createScanCache()

  // Pidfile: the extension's lifecycle module (subtask 1.2) uses pid +
  // version + startedAt + agentDir for liveness and version-mismatch respawn.
  const pidPath = path.join(agentDir, 'pi-flow', PID_FILE_NAME)
  fsp
    .mkdir(path.dirname(pidPath), { recursive: true })
    .then(() =>
      fsp.writeFile(
        pidPath,
        `${JSON.stringify({
          pid: process.pid,
          version: SERVER_PROTOCOL_VERSION,
          startedAt: new Date().toISOString(),
          agentDir,
        })}\n`,
        'utf8',
      ),
    )
    .catch((err: unknown) => {
      log(agentDir, `failed to write pidfile: ${String(err)}`)
    })

  // AIDEV-NOTE: PMR-XTQQ phase 1 — pending/ is created harmlessly at startup
  // (spec acceptance): the on-disk layout exists before the first parked run
  // and the consumer never needs to mkdir (consumePending only renames).
  // Best-effort: an unwritable agent dir degrades exactly like every other
  // daemon io failure (the journal stays authoritative).
  fsp
    .mkdir(pendingDirPath(agentDir), { recursive: true })
    .catch((err: unknown) => {
      log(agentDir, `failed to create pending dir: ${String(err)}`)
    })

  log(
    agentDir,
    `daemon started pid=${process.pid} version=${SERVER_PROTOCOL_VERSION}`,
  )

  // AIDEV-NOTE: scan model (plan decision 8) — 1s stat-poll full scan is the
  // PERMANENT fallback and the correctness backstop (dir-watch does not
  // reliably report appends into existing files); fs.watch only buys latency
  // for new journals (filtered to *.journal.jsonl — see isJournalWatchEvent),
  // and its failure degrades silently to poll. The per-ref size+mtime scan
  // cache (createScanCache) keeps an idle poll from re-reading every journal
  // every second; a cache hit still runs pending maintenance from the cached
  // projection. Hot-loop history: legacy out-of-vocabulary journals made
  // projections fail the daemon's own guard, so every scan rewrote identical
  // bytes inside the watched dir — CPU burn + watch churn + unbounded queue
  // growth (see applyEvent's AIDEV-NOTE in run-state.ts and the drain note
  // in createSerialQueue).
  // AIDEV-NOTE: KEEPALIVE — pollTimer is intentionally NOT unref'd. It is the
  // only guaranteed event-loop handle when fs.watch(runsDir) fails (runs/ may
  // not exist at startup); unref'ing it let the daemon exit milliseconds after
  // writing its pidfile (PMR-XTQQ review blocker). If you add another handle,
  // this interval must remain ref'd or the daemon must gain an explicit
  // keepalive handle.
  const schedule = createDebouncedScheduler(() => {
    void scanRuns(agentDir, queue, scanCache)
  }, DEBOUNCE_MS)
  const pollTimer = setInterval(() => {
    void scanRuns(agentDir, queue, scanCache)
  }, POLL_INTERVAL_MS)
  try {
    const watcher = watch(runsDir(agentDir), (_event, filename) => {
      if (isJournalWatchEvent(filename)) schedule()
    })
    watcher.on('error', () => {
      // Degrade silently to the poll scan.
      watcher.close()
    })
  } catch {
    // runs dir may not exist yet; the poll scan covers everything
  }

  const shutdown = (): void => {
    clearInterval(pollTimer)
    log(agentDir, 'daemon stopping')
    // AIDEV-NOTE: best-effort pidfile unlink on clean shutdown (SIGTERM/SIGINT)
    // so a drained daemon doesn't leave a stale server.pid behind. A SIGKILL
    // still leaves one — acceptable: probeDaemon's pid-liveness check is the
    // source of truth, and lifecycle.ts treats a fresh dead-pid pidfile as
    // spawn-in-progress rather than trusting it.
    fsp.unlink(pidPath).catch(() => undefined)
    void queue
      .drain()
      .catch(() => undefined)
      .then(() => {
        process.exit(0)
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  void scanRuns(agentDir, queue, scanCache)
}

// AIDEV-NOTE: extracted so schedule() is constructible without io; same
// debounce shape as flow-viewer.mjs's createDebouncedRender.
function createDebouncedScheduler(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
    timer.unref()
  }
}

// ── main-module guard (flow-viewer.mjs pattern) ──
// AIDEV-NOTE: only the daemon process (spawned with PI_FLOW_AGENT_DIR set)
// runs the execution prelude below; importing this module from tests must
// execute nothing. Pure helpers (reprojectRun, projectionChanged,
// createSerialQueue, SERVER_PROTOCOL_VERSION) are exported for unit tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

// FlowRunEvent is re-exported only as a type so test/daemon consumers can
// build journal events without importing from two modules.
export type { FlowRunEvent }
