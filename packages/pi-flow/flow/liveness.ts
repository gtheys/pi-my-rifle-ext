// AIDEV-NOTE (PMR-8MQH 2.1 + 2.2, plan PMR-8MQH decision D3): node-only
// settings reader, io wiring and the pass engine for the running-flow
// liveness push. This is the daemon's half of the `liveness` config block plus
// the single place where the daemon's world (agent dir + process env) becomes
// the engine's injected `LivenessDeps`; only the timer wiring (3.2) is still
// missing from this module.
//
// Home justification: reconcile's equivalent split lived in two files
// (`flow/reconcile.ts` engine + `flow/reconcile-deps.ts` wiring) because a
// manual in-session command (`/flow-reconcile-push`) reused the wiring with
// its own warn sink. Liveness has NO command (plan: "no /flow-liveness-push"),
// so its engine, tolerant reader and wiring collapse into this one node-only
// module instead of adding a second file pair. The 2.2 pass goes here too.
//
// Dependency contract (mirrors flow/reconcile-deps.ts:1-25 and the node-only
// module contract in flow/cost-rows.ts:1-30): node built-ins +
// ../run-state.ts + ./push.ts + ./reconcile-deps.ts + ./cost-rows.ts + the
// `@gtheys/pi-interactive-subagents` `assignments`/`usage` SUBPATHS only.
// Never the package root, never `config.ts` (its `readConfigFile` THROWS on a
// malformed file and its loader pulls `@earendil-works/pi-coding-agent` — a
// daemon must degrade to defaults + warning instead), never a pi extension
// runtime. Locked textually by test/run-liveness.test.ts. Note the accepted
// pre-existing exception: `../run-state.ts` and the `assignments` subpath each
// transitively module-load pi-coding-agent (`run-state.ts:10`,
// `subagents/dataroot.ts`), and both only ever call `getAgentDir()` when their
// own root/agentDir argument is omitted — every call site here passes an
// explicit one, so the daemon never resolves a path it was not handed.
//
// Two further contracts, both deliberate:
//   - env is always a parameter (`options.env`, defaulted to `process.env`
//     only at the boundary) so tests inject the gate and nothing reads
//     `process.env` deep in the module;
//   - the agent dir comes from `PI_FLOW_AGENT_DIR` (server/lifecycle.ts),
//     NEVER from `getAgentDir()`, and the runs dir is derived from it exactly
//     as `flow/reconcile-deps.ts` does.

import { promises as fsp, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AssignmentRecord,
  listAssignments,
} from '@gtheys/pi-interactive-subagents/assignments'
import {
  type FlowRunEvent,
  projectRunState,
  readRunEvents,
  runTracking,
} from '../run-state.ts'
import {
  buildPushBody,
  computeCostRollup,
  type PhaseDuration,
  phaseDurations,
  type WorkerRow,
} from './cost-rows.ts'
import { type PushFetch, type PushResult, pushToGateway } from './push.ts'
import { listJournalRefs, pushgatewayEnv } from './reconcile-deps.ts'

/** Daemon-side `liveness` settings. `warning` is ours, not the engine's: a
 *  broken file keeps the timer running on defaults and says why, exactly like
 *  `ReconcileSettings` in flow/reconcile-deps.ts. */
export interface LivenessSettings {
  enabled: boolean
  intervalMinutes: number
  warning?: string
}

// AIDEV-NOTE: PMR-8MQH (2.1) — these defaults are the daemon half of a
// DELIBERATE two-reader split over the same `<agentDir>/pi-flow/config.json`.
// `config.ts`'s typed `liveness` reader (subtask 4.1) is the session half and
// must return the identical `{ enabled: true, intervalMinutes: 5 }` for an
// absent block. This function stays here, not delegating to config.ts, because
// the daemon must remain node-only AND must not throw on a broken file — it
// warns and keeps its retires/cost pushes running instead.
export const DEFAULT_LIVENESS_SETTINGS: LivenessSettings = {
  enabled: true,
  intervalMinutes: 5,
}

/**
 * Parse the `liveness` block out of RAW config file text
 * (`<agentDir>/pi-flow/config.json`). Mirrors `parseReconcileSettings`
 * (flow/reconcile.ts:217) key for key: null/blank input and an absent section
 * are silent defaults; malformed JSON, a non-object file, a non-object
 * section, a non-boolean `enabled`, or a non-finite/`< 1` `intervalMinutes`
 * all fall back to the defaults AND return a `liveness: …` warning the daemon
 * logs. A broken config must not silently stop running pushes, and must not
 * crash the daemon.
 */
export function parseLivenessSettings(raw: string | null): LivenessSettings {
  if (raw === null || raw.trim().length === 0) {
    return { ...DEFAULT_LIVENESS_SETTINGS }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return warned('liveness: config file is not valid JSON')
  }
  if (!isRecord(parsed)) return warned('liveness: config file is not an object')
  if (parsed.liveness === undefined) return { ...DEFAULT_LIVENESS_SETTINGS }
  if (!isRecord(parsed.liveness)) {
    return warned('liveness: "liveness" is not an object')
  }
  const block = parsed.liveness
  const settings: LivenessSettings = { ...DEFAULT_LIVENESS_SETTINGS }
  if (block.enabled !== undefined) {
    if (typeof block.enabled !== 'boolean') {
      return warned('liveness: "enabled" is not a boolean')
    }
    settings.enabled = block.enabled
  }
  if (block.intervalMinutes !== undefined) {
    const minutes = block.intervalMinutes
    if (
      typeof minutes !== 'number' ||
      !Number.isFinite(minutes) ||
      minutes < 1
    ) {
      return warned('liveness: "intervalMinutes" is not a number >= 1')
    }
    settings.intervalMinutes = minutes
  }
  return settings
}

function warned(warning: string): LivenessSettings {
  return { ...DEFAULT_LIVENESS_SETTINGS, warning }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Injected IO for one liveness pass. Everything impure lives here so the
 *  2.2 engine stays node-only and testable with fakes. The three reads
 *  `readRunEvents` / `listAssignmentRecords` / `readSessionFile` are exactly
 *  `CostRollupDeps` (flow/cost-rows.ts:628), so a `LivenessDeps` value can be
 *  handed to `computeCostRollup` unchanged — that is the point, not a
 *  coincidence: the liveness body must be the same rollup the terminal autopush
 *  renders. */
export interface LivenessDeps {
  /** Refs (journal basenames) to scan — the daemon readdir's `runsDir`. */
  listJournalRefs: () => Promise<string[]>
  /** Journal events for a ref, or null when the journal is unreadable. */
  readRunEvents: (ref: string) => Promise<FlowRunEvent[] | null>
  /** Durable assignment records (subagents data dir of the agent dir). */
  listAssignmentRecords: () => readonly AssignmentRecord[]
  /** Raw session jsonl body, or null when unreadable (coverage gap). */
  readSessionFile: (file: string) => string | null
  /** Replace a group with the full running body (POST to the group URL). */
  pushBody: (
    trackRef: string,
    mode: 'work' | 'personal',
    body: string,
  ) => Promise<PushResult>
  /** The daemon's log channel (or a test collector). */
  warn: (message: string) => void
}

export interface LivenessDepsOptions {
  /** agent dir from PI_FLOW_AGENT_DIR (the daemon); never getAgentDir() */
  agentDir: string
  /** the daemon's log channel — engine warnings land here */
  warn: (message: string) => void
  env?: NodeJS.ProcessEnv
  /** gateway seam (tests capture POSTs); defaults to global fetch */
  fetchImpl?: PushFetch
  /** runs-dir listing seam for journal enumeration */
  readdir?: (dir: string) => Promise<string[]>
}

/**
 * Wire the engine's io. Returns null when the pushgateway env gate is closed
 * — the caller then skips the pass silently (ISC-4: no journal read, no fetch,
 * no assignment scan happens either, because every read is a lazy closure and
 * this factory performs no io itself).
 */
export function createLivenessDeps(
  options: LivenessDepsOptions,
): LivenessDeps | null {
  const gateway = pushgatewayEnv(options.env ?? process.env)
  if (gateway === null) return null
  const fetchImpl: PushFetch = options.fetchImpl ?? defaultPushFetch
  const readdir = options.readdir ?? defaultReaddir
  const { agentDir, warn } = options
  const assignmentsRoot = join(agentDir, 'pi-subagents')
  return {
    listJournalRefs: () => listJournalRefs(agentDir, readdir),
    readRunEvents: (ref: string) => readRunEvents(agentDir, ref),
    listAssignmentRecords: () => {
      const records: AssignmentRecord[] = []
      for (const view of listAssignments(assignmentsRoot)) {
        if (view.state === 'unknown') continue
        records.push(view.record)
      }
      return records
    },
    readSessionFile: (file: string) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    pushBody: (trackRef: string, mode: 'work' | 'personal', body: string) =>
      pushBodyOrError(gateway, trackRef, mode, body, fetchImpl),
    warn,
  }
}

async function defaultReaddir(dir: string): Promise<string[]> {
  return fsp.readdir(dir)
}

async function defaultPushFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; statusText: string }> {
  const response = await fetch(url, init)
  return { status: response.status, statusText: response.statusText }
}

// AIDEV-NOTE: the `LivenessDeps` contract is `{ok:false,error}` or a
// PushResult, never a throw — but flow/push.ts only guarantees that for its own
// io. This wrapper keeps the promise for the whole call (a frozen DNS cache
// throwing synchronously inside `fetch` must cost one failed ref, not the
// daemon's pass): unexpected throws become ordinary failure results. Same
// pattern as reconcile-deps.ts `pushTombstoneOrError`.
async function pushBodyOrError(
  gateway: { url: string; token: string | undefined },
  trackRef: string,
  mode: 'work' | 'personal',
  body: string,
  fetchImpl: PushFetch,
): Promise<PushResult> {
  try {
    return await pushToGateway(
      gateway.url,
      trackRef,
      body,
      fetchImpl,
      gateway.token,
      mode,
    )
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

/** `unknown` from a catch becomes a loggable message, Error first (the one
 *  shape every warning in this module uses). */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return `${err}`
}

// the pass engine (PMR-8MQH 2.2): the report, its log line, and one pass.

type RefOutcome = 'pushed' | 'skipped' | 'failed'

/** What one pass did, as counts. `scanned` is every enumerated journal ref,
 *  so `scanned === pushed + skipped + failed` always holds. */
export interface LivenessReport {
  scanned: number
  pushed: number
  skipped: number
  failed: number
}

/** The one log line per pass. The factory (3.1) logs `formatSummary` output
 *  VERBATIM (server/daemon.ts:592), so this line is the whole log entry — no
 *  label prefix is applied. The exact shape is a contract — homelab log greps
 *  key on these names. */
export function livenessSummaryLine(report: LivenessReport): string {
  return `liveness pass: scanned=${report.scanned} pushed=${report.pushed} skipped=${report.skipped} failed=${report.failed}`
}

/**
 * AIDEV-NOTE (PMR-8MQH 2.2, plan decisions D2/D4): one liveness pass. For
 * every journal ref whose projection says the loop is `running`, re-render
 * the FULL group body and POST it, so a running run never fades from the
 * dashboard between phase pushes. Reading order per ref:
 *   read journal -> gate on `running` -> `computeCostRollup` -> render ->
 *   RE-READ + re-gate (ISC-8: a run that went terminal during the rollup must
 *   not get a `running` body pushed after its terminal push) -> `pushBody`.
 * Two invariants the call sites cannot give up:
 *   - the body is `buildPushBody(trackRef, rows, durations, events)` — the
 *     SAME render path as the terminal autopush, so the two pushes of one run
 *     differ only in the status line (ISC-2, and why the rollup's own `events`
 *     are preferred over the gate read when present);
 *   - this function NEVER appends a journal event (ISC-A-1) and NEVER reads a
 *     group back with `fetchGroupBody` (ISC-A-5): a partial body POST would
 *     drop the series the terminal push owns.
 * Never rejects: the enumeration and every ref are wrapped, so a broken runs
 * dir costs one warning, and one broken journal or gateway costs a `failed`
 * count plus one warning — never the pass (ISC-5).
 */
export async function runLivenessPassOnce(
  deps: LivenessDeps,
): Promise<LivenessReport> {
  const report: LivenessReport = {
    scanned: 0,
    pushed: 0,
    skipped: 0,
    failed: 0,
  }
  let refs: string[]
  try {
    refs = await deps.listJournalRefs()
  } catch (err) {
    // The wired deps swallow a readdir failure to an empty list, so this only
    // fires for hand-wired deps; an enumeration error is not a per-ref count.
    deps.warn(`liveness: journal enumeration failed: ${errorText(err)}`)
    return report
  }
  report.scanned = refs.length
  for (const ref of refs) {
    let outcome: RefOutcome
    try {
      outcome = await pushIfRunning(deps, ref)
    } catch (err) {
      outcome = 'failed'
      deps.warn(`liveness ${ref}: pass aborted: ${errorText(err)}`)
    }
    if (outcome === 'pushed') report.pushed += 1
    if (outcome === 'skipped') report.skipped += 1
    if (outcome === 'failed') report.failed += 1
  }
  return report
}

/** The per-ref half of the pass. Skips are silent (a non-running ref is the
 *  normal case); only a failed POST warns, because the caller's own throw
 *  handling already warns on exceptions. */
async function pushIfRunning(
  deps: LivenessDeps,
  ref: string,
): Promise<RefOutcome> {
  const events = await deps.readRunEvents(ref)
  if (events === null) return 'skipped'
  if (!projectsRunning(events)) return 'skipped'
  const rollup = await computeCostRollup(ref, deps)
  if (rollup.kind === 'no-journal') return 'skipped'
  let trackRef = ref
  let mode: 'work' | 'personal' = 'personal'
  let rows: readonly WorkerRow[] = []
  let durations: readonly PhaseDuration[] = []
  let bodyEvents: readonly FlowRunEvent[] = events
  if (rollup.kind === 'ok') {
    trackRef = rollup.trackRef
    mode = rollup.mode
    rows = rollup.rows
    durations = rollup.durations
    if (rollup.events !== undefined) bodyEvents = rollup.events
  } else {
    // `empty` (plan ISC-10): a fresh run with no spawn notes and no
    // main-session record yet, so there are no cost rows to render. The
    // tracking ref and the phase durations still come straight from the
    // journal — same `runTracking` derivation the terminal autopush uses —
    // which makes the push health-only rather than absent.
    // AIDEV-NOTE (PMR-8MQH review P2): guarded to trackRef === ref. The
    // Pushgateway group is keyed by TRACKREF, and in work mode several runs
    // (across resume/restarts of one Jira issue) share one trackRef — a
    // zero-cost health-only body would REPLACE that group and erase the
    // previous run's cost/token series (measured: 85 series lost, and
    // unrecoverable if the new run dies before its terminal push). An
    // 'ok' rollup may still replace the shared group: it carries the full
    // re-render of everything the current journal knows, matching the
    // terminal autopush exactly. ISC-10 therefore covers personal-mode fresh
    // runs; a work-mode fresh run appears at its first cost-bearing pass.
    const tracking = runTracking(events, ref)
    if (tracking.trackRef !== ref) return 'skipped'
    trackRef = tracking.trackRef
    mode = tracking.mode
    durations = phaseDurations(events)
  }
  const latest = await deps.readRunEvents(ref)
  if (latest === null) return 'skipped'
  if (!projectsRunning(latest)) return 'skipped'
  const body = buildPushBody(trackRef, rows, durations, bodyEvents)
  const result = await deps.pushBody(trackRef, mode, body)
  if (result.ok) return 'pushed'
  deps.warn(
    `liveness ${ref}: push failed: ${result.error ?? 'pushgateway POST failed'}`,
  )
  return 'failed'
}

/** The liveness gate: a journal that projects no state, or a state with no
 *  loop record, or a loop that is not `running`, gets no push (ISC-3). Pure. */
function projectsRunning(events: readonly FlowRunEvent[]): boolean {
  const state = projectRunState(events)
  if (state === null) return false
  if (state.loop === undefined) return false
  return state.loop.status === 'running'
}
