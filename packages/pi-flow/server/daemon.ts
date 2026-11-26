// AIDEV-NOTE: PMR-XTQQ — pi-flow durable run server daemon. Own process, own
// event loop (this is what makes fs.watch sanctioned here — see
// plugins/herdr/flow-viewer.mjs and the subagent-done.ts scar tissue; NEVER
// put a watcher inside pi's extension process). The journal is authoritative
// and written by sessions via O_APPEND; this daemon is the ONLY projection
// writer, reprojecting per ref from journal events.
//
// DEPENDENCY CONTRACT (corrected in PMR-MSDJ 2.2 — the PMR-XTQQ wording here
// was stale): run-state.ts runtime-imports `@earendil-works/pi-coding-agent`
// (run-state.ts:10, getAgentDir) and has since before this feature, so the
// daemon transitively loads pi-coding-agent TODAY — "dependency-free beyond
// node built-ins" was never literally true. The ENFORCEABLE contract is: every
// module the daemon imports adds NO NEW runtime dependency beyond
// run-state.ts + flow/reconcile.ts + flow/reconcile-deps.ts + flow/push.ts +
// flow/liveness.ts + flow/cost-rows.ts + flow/run-health.ts +
// flow/state-metrics.ts + flow/vocabulary.ts + aven/status.ts (all node
// built-ins apart from that pre-existing one). flow/liveness.ts and
// flow/cost-rows.ts (PMR-8MQH 3.2) are sanctioned because they import ONLY the
// node-only `@gtheys/pi-interactive-subagents` SUBPATH exports (`/usage`,
// `/assignments`) — never the package root — and, like run-state.ts,
// `assignments` transitively module-loads pi-coding-agent through
// `subagents/dataroot.ts`. That is the SAME documented pre-existing acceptance
// class as run-state.ts (a module-load, not a new dependency edge, and both
// only ever call `getAgentDir()` at their own call sites the daemon never
// reaches), so they add no NEW runtime dependency either.
// AIDEV-NOTE (PMR-ZV9Y 3.2): flow/run-health.ts, flow/state-metrics.ts and
// flow/vocabulary.ts join the sanctioned list because the v2 gauges MUST render
// inside the daemon's liveness body — liveness re-pushes run-health bodies
// through buildPushBody, so a session-side derivation would leave running flows
// without v2 series. They add no edge beyond the ones already here:
// state-metrics.ts imports only run-state.ts + ./vocabulary.ts + ./cost-rows.ts
// (`labelString`), vocabulary.ts is zero-import, and run-health.ts gains only
// the state-metrics edge. Locked textually, per root, by
// test/cost-rows-node-only.test.ts.
// Never
// add `config.ts` (its readConfigFile THROWS on a malformed file — the daemon
// is best-effort io), `flow/cost.ts` (runtime dep on
// @gtheys/pi-interactive-subagents) or `aven/client.ts` (imports config.ts).
// The agent dir arrives via PI_FLOW_AGENT_DIR from the spawner
// (server/lifecycle.ts), never from getAgentDir().
// The spawn-side git SHA arrives the same way via PI_FLOW_DAEMON_GIT_SHA
// (PMR-7B8M): validated as 40-hex lowercase in gitShaFromEnv, dropped
// otherwise, and ADVISORY-ONLY — it is recorded in the pidfile so sessions can
// judge staleness; it never affects liveness, respawn, or any daemon decision.
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
  createLivenessDeps,
  type LivenessReport,
  type LivenessSettings,
  livenessSummaryLine,
  parseLivenessSettings,
  runLivenessPassOnce,
} from '../flow/liveness.ts'
import type { ReconcileReport } from '../flow/reconcile.ts'
import {
  globalConfigPath,
  journalRefsFromEntries,
  pushgatewayEnv,
  type ReconcileSettings,
  readReconcileSettings,
  reconcileSummaryLine,
  runReconcilePassOnce,
} from '../flow/reconcile-deps.ts'
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

/**
 * AIDEV-NOTE: PMR-7B8M — the spawner's checkout HEAD arrives via env (like
 * PI_FLOW_AGENT_DIR); validated 40-hex lowercase, anything else is dropped
 * because gitSha is an advisory pidfile field the daemon must never trust.
 * Pure (reads only the passed env) so it is unit-testable without a spawn.
 */
export function gitShaFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.PI_FLOW_DAEMON_GIT_SHA
  if (typeof raw !== 'string') return undefined
  if (!/^[0-9a-f]{40}$/.test(raw)) return undefined
  return raw
}

/**
 * PMR-7B8M: serialize the pidfile line. gitSha is included only when present
 * so pidfiles written outside a repo keep the pre-feature shape exactly
 * (lifecycle.ts treats an absent gitSha as "predates staleness tracking").
 */
export function pidfileLine(fields: {
  pid: number
  version: string
  startedAt: string
  agentDir: string
  gitSha?: string
}): string {
  const payload: Record<string, unknown> = {
    pid: fields.pid,
    version: fields.version,
    startedAt: fields.startedAt,
    agentDir: fields.agentDir,
  }
  if (fields.gitSha !== undefined) payload.gitSha = fields.gitSha
  return `${JSON.stringify(payload)}\n`
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
  const refs = journalRefsFromEntries(entries)
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

// --- periodic pass timer (PMR-8MQH 3.1) ---
// AIDEV-NOTE: PMR-8MQH 3.1 — the reconcile timer's loop generalized. The gate
// check, the settings re-read, the re-arm-before-the-pass cadence, the
// disabled skip, the in-flight guard and the error logging are ONE
// implementation here so a second timer (liveness, subtask 3.2) cannot drift
// from them. Byte-identical behavior to the pre-extraction
// `startReconcileTimer`: the only difference in shape is that the log lines
// are built from `label` + a message body, so an adapter with
// `label: 'reconcile'` emits exactly the strings the tests assert.
// `gateClosedMessage` exists because the startup-gate reason is adapter
// knowledge (which env var / which config key), not the loop's.

/** One minute in ms — the unit `intervalMinutes` is expressed in. Also the
 *  fallback delay after a failed settings read: a read that failed once is
 *  retried in a minute rather than at the configured (possibly 6-hour)
 *  cadence. */
const PERIODIC_MINUTE_MS = 60_000
/** Default delay before the FIRST pass after daemon start (an adapter may
 *  override it via `firstPassDelayMs`). */
const PERIODIC_FIRST_PASS_DELAY_MS = 60_000

/** One armed timer. `hasRef` exists so the keepalive posture is assertable —
 *  production handles are real `setTimeout`s, which are ref'd until cleared. */
export interface ReconcileTimerHandle {
  cancel(): void
  hasRef(): boolean
}

export interface ReconcileTimer extends ReconcileTimerHandle {}

/** The settings a periodic pass re-reads on every tick. */
export interface PeriodicPassSettings {
  enabled: boolean
  intervalMinutes: number
  /** a non-fatal problem reading the settings source; logged once per pass,
   *  never fatal (defaults are still applied) */
  warning?: string
}

export interface PeriodicPassTimerOptions<TReport> {
  /** prefix for every log line this timer emits (`'reconcile'`,
   *  `'liveness'`). Summary lines from `formatSummary` are logged verbatim —
   *  they carry their own prefix. */
  label: string
  agentDir: string
  /** the daemon's log channel (`<agentDir>/pi-flow/server.log`) */
  log: (message: string) => void
  readSettings: (agentDir: string) => Promise<PeriodicPassSettings>
  /** the pass itself. `null` means "nothing to report" — no summary line. */
  runPass: () => Promise<TReport | null>
  formatSummary: (report: TReport) => string
  /** startup-only gate, evaluated once. False ⇒ one log line, no timer at all
   *  (a gate the daemon's fixed env/config can never satisfy later is not
   *  worth an armed chain). */
  gateOpen: () => boolean
  /** body of the gate-failure log line (after `label: `) */
  gateClosedMessage?: string
  /** seam: defaults to `setTimeout` — a REF'D handle (keepalive) */
  schedule?: (fn: () => void, ms: number) => ReconcileTimerHandle
  firstPassDelayMs?: number
}

/**
 * A startup-gated loop whose next delay comes from a settings read on EVERY
 * tick, so `intervalMinutes` changes and a flip back to `enabled: true` take
 * effect WITHOUT restarting the daemon — PROVIDED a timer exists: a flip
 * BEFORE startup (disabled at startup) never arms one, see the gate-2 cost
 * note on `startReconcileTimer` below. A tick that reads `enabled: false`
 * skips the pass but stays armed (plan behavior: "Each pass: settings
 * disabled ⇒ skip").
 *
 * AIDEV-NOTE: KEEPALIVE — the armed handle is intentionally NOT unref'd,
 * mirroring the pollTimer rule above (`hasRef` is exposed so a test pins it).
 * AIDEV-NOTE: THE PASS NEVER TOUCHES THE SCAN QUEUE. It runs on its own async
 * chain: a gateway round-trip (or a hung fetch) must not delay the 1s journal
 * scan by even one tick. The flip side is that ticks do not wait for each
 * other, so `inFlight` keeps a slow pass from stacking a second one behind it
 * — a skipped tick re-arms and says so once.
 */
export function startPeriodicPassTimer<TReport>(
  options: PeriodicPassTimerOptions<TReport>,
): ReconcileTimer {
  const schedule = options.schedule ?? schedulePeriodicPassTimer
  const firstPassDelayMs =
    options.firstPassDelayMs ?? PERIODIC_FIRST_PASS_DELAY_MS

  let handle: ReconcileTimerHandle | null = null
  let cancelled = false
  let inFlight = false
  // Dedupe the disabled notice so a 1-minute interval cannot spam.
  let disabledNoticed = false

  const info = (message: string): void => {
    options.log(`${options.label}: ${message}`)
  }

  const arm = (delayMs: number): void => {
    if (cancelled) return
    handle = schedule(() => {
      void tick()
    }, delayMs)
  }

  /** Reads the settings, logging the failure (and any source warning) in the
   *  same order the pre-extraction timer did. `null` means the read failed. */
  const readSettings = async (): Promise<PeriodicPassSettings | null> => {
    try {
      return await options.readSettings(options.agentDir)
    } catch (err) {
      info(`settings read failed: ${String(err)}`)
      return null
    }
  }

  const logWarning = (settings: PeriodicPassSettings): void => {
    if (settings.warning !== undefined) {
      info(settings.warning)
    }
  }

  const tick = async (): Promise<void> => {
    handle = null
    if (cancelled) return
    const settings = await readSettings()
    if (settings === null) {
      arm(PERIODIC_MINUTE_MS)
      return
    }
    if (cancelled) return
    logWarning(settings)
    const delayMs = Math.max(1, settings.intervalMinutes) * PERIODIC_MINUTE_MS
    // Re-arm BEFORE the pass: the cadence must survive a slow or hung pass.
    arm(delayMs)
    if (!settings.enabled) {
      if (!disabledNoticed) {
        disabledNoticed = true
        info('disabled in config — passes skipped')
      }
      return
    }
    disabledNoticed = false
    if (inFlight) {
      info('previous pass still running — pass skipped')
      return
    }
    inFlight = true
    try {
      const report = await options.runPass()
      if (report !== null) {
        options.log(options.formatSummary(report))
      }
    } catch (err) {
      info(`pass failed: ${String(err)}`)
    } finally {
      inFlight = false
    }
  }

  const startup = async (): Promise<void> => {
    if (!options.gateOpen()) {
      info(
        options.gateClosedMessage ?? 'startup gate closed — timer not started',
      )
      return
    }
    const settings = await readSettings()
    if (settings === null) return
    if (cancelled) return
    logWarning(settings)
    if (!settings.enabled) {
      info('disabled in config — timer not started')
      return
    }
    disabledNoticed = false
    arm(firstPassDelayMs)
  }
  void startup()

  return {
    cancel(): void {
      cancelled = true
      if (handle !== null) {
        handle.cancel()
        handle = null
      }
    },
    hasRef(): boolean {
      if (handle === null) return false
      return handle.hasRef()
    },
  }
}

/** Production scheduler: a real `setTimeout`, deliberately NOT unref'd. */
function schedulePeriodicPassTimer(
  fn: () => void,
  ms: number,
): ReconcileTimerHandle {
  const timer = setTimeout(fn, ms)
  return {
    cancel: () => {
      clearTimeout(timer)
    },
    hasRef: () => timer.hasRef(),
  }
}

// --- reconcile timer (PMR-MSDJ 2.2, plan PMR-V36Y decision 4a) ---

/** Delay before the FIRST pass after daemon start: long enough that a spawn
 *  storm (session start → ensureDaemon → reconcile) cannot reach the gateway
 *  before the projections exist, short enough that an operator who just ran
 *  `/flow-reconcile-push` sees the timer take over within a minute. */
export const RECONCILE_FIRST_PASS_DELAY_MS = PERIODIC_FIRST_PASS_DELAY_MS
/** `intervalMinutes` → ms. Exported so the tests assert the re-read contract
 *  without a live daemon. */
export const RECONCILE_MINUTE_MS = PERIODIC_MINUTE_MS

export interface ReconcileTimerOptions {
  agentDir: string
  /** the daemon's log channel (`<agentDir>/pi-flow/server.log`) — also where
   *  engine warnings go, via `runReconcilePassOnce`'s `warn` */
  log: (message: string) => void
  env?: NodeJS.ProcessEnv
  /** seam: defaults to reading `<agentDir>/pi-flow/config.json` as raw text */
  readSettings?: (agentDir: string) => Promise<ReconcileSettings>
  /** seam: defaults to the wired engine pass (never dry) */
  runPass?: () => Promise<ReconcileReport | null>
  /** seam: defaults to `setTimeout` — a REF'D handle (keepalive) */
  schedule?: (fn: () => void, ms: number) => ReconcileTimerHandle
  firstPassDelayMs?: number
}

/**
 * The daemon's stale-liveness reconcile loop — the reconcile wiring of
 * `startPeriodicPassTimer`. Gates, in order, evaluated at startup:
 *  1. `PI_FLOW_PUSHGATEWAY_URL` unset → log once, NO timer at all (the
 *     autopush gate: no endpoint means there is nothing to reconcile, and the
 *     daemon's env is fixed at spawn so a later check could never succeed);
 *  2. `reconcile.enabled === false` → log once, NO timer at all.
 * Then on every tick the reconcile settings are re-read (see the factory for
 * the rest of the loop contract).
 *
 * AIDEV-NOTE (PMR-MSDJ review P2-3 — what gate 2 really costs): a flip BACK
 * to `enabled: true` does NOT take effect unless the timer was armed at
 * startup. A daemon that STARTED with `enabled=false` has no timer left to
 * re-read settings (pinned by test/server-reconcile-timer.test.ts: "disabled
 * at startup creates no timer at all"), and `server/lifecycle.ts` respawns
 * only a DEAD daemon or a version mismatch — so disable, wait, re-enable
 * yields silence with no log line until the daemon restarts (kill it and the
 * next session's `ensureDaemon` re-spawns, or run `/flow-reconcile-push` for
 * one pass now). Arming unconditionally and letting the per-tick check skip
 * would close the gap; the startup gate is pinned behaviour, so this round
 * documents it instead of changing it. The liveness timer inherits the same
 * posture by design.
 */
export function startReconcileTimer(
  options: ReconcileTimerOptions,
): ReconcileTimer {
  const runPass =
    options.runPass ??
    (() =>
      runReconcilePassOnce({
        agentDir: options.agentDir,
        env: options.env,
        warn: options.log,
      }))
  return startPeriodicPassTimer<ReconcileReport>({
    label: 'reconcile',
    agentDir: options.agentDir,
    log: options.log,
    readSettings: options.readSettings ?? readReconcileSettings,
    runPass,
    formatSummary: reconcileSummaryLine,
    gateOpen: () => pushgatewayEnv(options.env) !== null,
    gateClosedMessage: 'PI_FLOW_PUSHGATEWAY_URL is not set — timer not started',
    schedule: options.schedule,
    firstPassDelayMs: options.firstPassDelayMs,
  })
}

// --- liveness timer (PMR-8MQH 3.2) ---

/** Delay before the FIRST liveness pass and the unit `intervalMinutes` is
 *  expressed in — both reuse the factory's shared `PERIODIC_*` values (3.1),
 *  which are byte-identical here. Named per the plan's liveness contract and
 *  exported so the timer test asserts the re-read policy without a live
 *  daemon. */
export const LIVENESS_FIRST_PASS_DELAY_MS = PERIODIC_FIRST_PASS_DELAY_MS
export const LIVENESS_MINUTE_MS = PERIODIC_MINUTE_MS

/**
 * AIDEV-NOTE: PMR-8MQH 3.2 — the liveness half of the two-reader split over
 * `<agentDir>/pi-flow/config.json` (see flow/liveness.ts's `parseLivenessSettings`
 * note). Mirrors `readReconcileSettings` (flow/reconcile-deps.ts) exactly:
 * read the raw global-config text, hand it to the liveness parser, and degrade
 * a non-ENOENT read failure to defaults + a warning — NEVER throw out of the
 * tick (the daemon is best-effort io; `config.ts`'s throwing reader is
 * deliberately off the allowlist). ENOENT is the normal "no config yet" answer
 * (defaults, no warning).
 */
async function readLivenessSettings(
  agentDir: string,
  readFile: (file: string) => Promise<string> = (file) =>
    fsp.readFile(file, 'utf8'),
): Promise<LivenessSettings> {
  const file = globalConfigPath(agentDir)
  let raw: string | null = null
  let warning: string | undefined
  try {
    raw = await readFile(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      let reason = `${err}`
      if (err instanceof Error) {
        reason = err.message
      }
      warning = `could not read ${file}: ${reason}`
    }
    raw = null
  }
  const settings = parseLivenessSettings(raw)
  if (warning !== undefined) return { ...settings, warning }
  return settings
}

export interface LivenessTimerOptions {
  agentDir: string
  /** the daemon's log channel (`<agentDir>/pi-flow/server.log`) — also where
   *  engine warnings land, via `createLivenessDeps`'s `warn` */
  log: (message: string) => void
  env?: NodeJS.ProcessEnv
  /** seam: defaults to reading `<agentDir>/pi-flow/config.json` as raw text */
  readSettings?: (agentDir: string) => Promise<LivenessSettings>
  /** seam: defaults to the wired engine pass (a null from
   *  `createLivenessDeps` — the gate closed late — means "no pass") */
  runPass?: () => Promise<LivenessReport | null>
  /** seam: defaults to `setTimeout` — a REF'D handle (keepalive) */
  schedule?: (fn: () => void, ms: number) => ReconcileTimerHandle
  firstPassDelayMs?: number
}

/**
 * The daemon's liveness pass — the liveness wiring of
 * `startPeriodicPassTimer`. Gates, in order, evaluated at startup:
 *  1. `PI_FLOW_PUSHGATEWAY_URL` unset → log once, NO timer at all (the same
 *     endpoint gate the reconcile timer uses — with no gateway there is
 *     nothing to keep alive on the dashboard, and the daemon's env is fixed at
 *     spawn so a later check could never succeed);
 *  2. `liveness.enabled === false` → log once, NO timer at all.
 * Then on every tick the liveness settings are re-read (see the factory for
 * the rest of the loop contract). `runPass` builds deps via
 * `createLivenessDeps`; a null return (gate closed late) is reported as "no
 * pass" so the factory logs no summary line (2.2 handoff).
 */
export function startLivenessTimer(
  options: LivenessTimerOptions,
): ReconcileTimer {
  const runPass =
    options.runPass ??
    (async () => {
      const deps = createLivenessDeps({
        agentDir: options.agentDir,
        warn: options.log,
        env: options.env,
      })
      if (deps === null) return null
      return runLivenessPassOnce(deps)
    })
  return startPeriodicPassTimer<LivenessReport>({
    label: 'liveness',
    agentDir: options.agentDir,
    log: options.log,
    readSettings: options.readSettings ?? readLivenessSettings,
    runPass,
    formatSummary: livenessSummaryLine,
    gateOpen: () => pushgatewayEnv(options.env) !== null,
    gateClosedMessage: 'PI_FLOW_PUSHGATEWAY_URL is not set — timer not started',
    schedule: options.schedule,
    firstPassDelayMs: options.firstPassDelayMs,
  })
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
  // PMR-7B8M adds the ADVISORY gitSha — the spawning checkout's HEAD, dropped
  // unless it validates as 40-hex — which later sessions compare against their
  // own HEAD to warn about a daemon running stale code. It never influences
  // this daemon's behavior.
  const pidPath = path.join(agentDir, 'pi-flow', PID_FILE_NAME)
  const gitSha = gitShaFromEnv(process.env)
  fsp
    .mkdir(path.dirname(pidPath), { recursive: true })
    .then(() =>
      fsp.writeFile(
        pidPath,
        pidfileLine({
          pid: process.pid,
          version: SERVER_PROTOCOL_VERSION,
          startedAt: new Date().toISOString(),
          agentDir,
          gitSha,
        }),
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
  // AIDEV-NOTE: PMR-MSDJ 2.2 — reconcile timer (plan PMR-V36Y decision 4a).
  // Runs on its OWN async chain, never through `queue`, so a Pushgateway
  // round-trip cannot delay a 1s scan; its handle is ref'd like pollTimer
  // (keepalive), and `cancel()` on shutdown stops it from re-arming behind an
  // in-flight pass. Startup gates (no endpoint / disabled) mean no timer is
  // created at all; per-pass the config is re-read so interval and enable
  // changes apply without restarting the daemon. Best-effort io: every failure
  // is one log line.
  const reconcile = startReconcileTimer({
    agentDir,
    log: (message) => {
      log(agentDir, message)
    },
  })
  // AIDEV-NOTE: PMR-8MQH 3.2 — liveness timer, the same gated periodic-pass
  // loop as reconcile but pushing the FULL running body for still-running
  // runs (so they never fade from the dashboard between phase pushes). Own
  // async chain, ref'd handle (keepalive), `cancel()` on shutdown; the
  // settings (`liveness` block) are re-read per tick. Gates identically: no
  // endpoint / disabled at startup ⇒ no timer.
  const liveness = startLivenessTimer({
    agentDir,
    log: (message) => {
      log(agentDir, message)
    },
    env: process.env,
  })
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
    reconcile.cancel()
    liveness.cancel()
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
