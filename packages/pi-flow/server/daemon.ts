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
// BUMP TOGETHER: SERVER_PROTOCOL_VERSION must be kept in sync with
// server/lifecycle.ts (written in subtask 1.2) — a long-lived daemon can
// outlive a package upgrade, so the pidfile pins the version and a mismatch
// means kill + respawn.

import { promises as fsp, watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type FlowRunEvent,
  isFlowRunState,
  projectRunState,
  readRunEvents,
  runStatePath,
  runsDir,
} from '../run-state.ts'

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
  io: {
    readFile: (p: string) => Promise<string>
    writeFile: (p: string, data: string) => Promise<void>
  } = {
    readFile: (p) => fsp.readFile(p, 'utf8'),
    writeFile: async (p, data) => {
      await fsp.writeFile(p, data, 'utf8')
    },
  },
): Promise<ReprojectResult> {
  const events = await readRunEvents(agentDir, ref, { readFile: io.readFile })
  if (events === null) return 'no-journal'
  const state = projectRunState(events)
  if (state === null) return 'no-journal'
  const statePath = runStatePath(agentDir, ref)
  if (statePath === null) return 'no-journal'
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
  if (!projectionChanged(currentRaw, state)) return 'unchanged'
  await io.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  return 'written'
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
  const tracked: Array<Promise<void>> = []
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
      tracked.push(run)
      return run
    },
    async drain(): Promise<void> {
      await Promise.all(tracked)
    },
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

/** Scan the runs dir and queue a reproject for every journal found. */
async function scanRuns(agentDir: string, queue: SerialQueue): Promise<void> {
  const dir = runsDir(agentDir)
  let entries: string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return // runs dir does not exist yet — nothing to scan
  }
  for (const entry of entries) {
    if (!entry.endsWith('.journal.jsonl')) continue
    const ref = entry.slice(0, -'.journal.jsonl'.length)
    queue.push(async () => {
      try {
        await reprojectRun(agentDir, ref)
      } catch (err) {
        log(agentDir, `reproject failed for ${ref}: ${String(err)}`)
      }
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

  log(
    agentDir,
    `daemon started pid=${process.pid} version=${SERVER_PROTOCOL_VERSION}`,
  )

  // AIDEV-NOTE: scan model (plan decision 8) — 1s stat-poll full scan is the
  // PERMANENT fallback and the correctness backstop (dir-watch does not
  // reliably report appends into existing files); fs.watch only buys latency
  // for new journals, and its failure degrades silently to poll.
  const schedule = createDebouncedScheduler(() => {
    void scanRuns(agentDir, queue)
  }, DEBOUNCE_MS)
  const pollTimer = setInterval(() => {
    void scanRuns(agentDir, queue)
  }, POLL_INTERVAL_MS)
  pollTimer.unref()
  try {
    const watcher = watch(runsDir(agentDir), () => {
      schedule()
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
    void queue
      .drain()
      .catch(() => undefined)
      .then(() => {
        process.exit(0)
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  void scanRuns(agentDir, queue)
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
