// AIDEV-NOTE (PMR-8MQH 2.1, plan PMR-8MQH decision D3): node-only settings
// reader + io wiring for the running-flow liveness push. This is the daemon's
// half of the `liveness` config block plus the single place where the daemon's
// world (agent dir + process env) becomes the engine's injected
// `LivenessDeps` (the pass itself arrives in 2.2, the timer wiring in 3.2).
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
import { type FlowRunEvent, readRunEvents } from '../run-state.ts'
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
    let message = `${err}`
    if (err instanceof Error) message = err.message
    return { ok: false, error: message }
  }
}
