// AIDEV-NOTE (PMR-ZV9Y 4.2): minimal Loki log-push client. Mirrors
// telemetry/exporter.ts (PMR-R8AG) on purpose — hand-rolled JSON POST, no
// collector dependency, no growing buffers, no retry queue. Fire-and-forget
// with a short AbortSignal timeout; failures are dropped silently after AT
// MOST ONE journal note per process (never a rejected promise into the host),
// and the once-per-process guard is the caller-owned `state` object (a
// per-LokiPusher singleton threaded through subtask 4.3's fan-out). Loki's
// push receiver accepts this JSON at <endpoint>/loki/api/v1/push.
//
// LABEL HYGIENE (ISC-A-1): the Loki stream carries ONLY the closed v2 enum set
// plus identity (job, flow_ref, mode, phase, state, reason, wait_kind, kind).
// Free text — note prose, halt reasons, deviation text — lives in the JSON
// `line` only, NEVER a label. buildLokiStream is the fixed label-builder so a
// caller structurally cannot inject an arbitrary label, and it drops
// empty/absent values so a reasonless state never emits `reason=""`.
//
// SESSION-SIDE ONLY: like the OTLP path, this pushes from the live session
// (subtask 4.3 wires the journal-writer fan-out that calls it). The daemon
// never pushes Loki — see the AIDEV-NOTE on the `telemetry.loki` block in
// config.ts (single strict reader).

import type { FlowReason, FlowState, WaitKind } from '../flow/vocabulary.ts'
import type { FlowPhase } from '../run-state.ts'

/** Closed Loki label set: job (fixed) + identity + v2 enums. No free text. */
export interface LokiLabels {
  flow_ref?: string
  mode?: string
  phase?: FlowPhase
  state?: FlowState
  reason?: FlowReason | ''
  wait_kind?: WaitKind
  kind?: string
}

/** Resolved Loki push settings; null (caller) = disabled, push zero events. */
export interface LokiSettings {
  endpoint: string
  headers?: Record<string, string>
}

export interface LokiOutcome {
  ok: boolean
  error?: string
}

/**
 * At-most-one-note-per-process guard (ISC-A-5). Held by the caller and shared
 * across every push in a process; pushLokiEvent flips `noted` on first failure
 * so later failures are silent. Mirrors the OTLP path's `state.noted`.
 */
export interface LokiNoteState {
  noted: boolean
}

/** Pusher dependencies, injected so tests run without a live endpoint (D2). */
export interface LokiPushDeps {
  fetchImpl: LokiFetch
  /** Wall-clock fallback (ms epoch) when the event carries no parseable `at`. */
  now: () => number
  /** Shared per-process once-guard; the caller owns and threads it (4.3). */
  state: LokiNoteState
  /** Journal-note hook, invoked at most once per process on first failure. */
  onNote: (error: string) => void
  timeoutMs?: number
}

/** Injectable fetch seam: returns at least the HTTP status. */
export type LokiFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{ status: number }>

/** Fixed Loki job label — every pi-flow stream is `{job="pi-flow"}`. */
export const LOKI_JOB = 'pi-flow'

/** Loki push endpoint path (D2): the config stores only the base URL. */
export const LOKI_PUSH_PATH = '/loki/api/v1/push'

/** Default push timeout in ms — same posture as the OTLP exporter. */
export const LOKI_TIMEOUT_MS = 2500

/** The closed label keys that may ride a Loki stream, in a stable order. */
const LOKI_LABEL_KEYS = [
  'flow_ref',
  'mode',
  'phase',
  'state',
  'reason',
  'wait_kind',
  'kind',
] as const satisfies readonly (keyof LokiLabels)[]

/**
 * Build the fixed label map: `job` always, then each closed-set key present
 * AND non-empty. Unknown keys are never copied (the key list is the guard) and
 * an empty value (e.g. reasonless state's `reason: ''`) is dropped so it
 * cannot inflate cardinality.
 */
export function buildLokiStream(labels: LokiLabels): Record<string, string> {
  const stream: Record<string, string> = { job: LOKI_JOB }
  for (const key of LOKI_LABEL_KEYS) {
    const value = labels[key]
    if (typeof value === 'string' && value.length > 0) stream[key] = value
  }
  return stream
}

/**
 * Build the Loki push request body (pure): one stream, one entry. `timestampNs`
 * is an epoch-nanoseconds STRING — see lokiTimestampNs.
 */
export function buildLokiPushBody(
  labels: LokiLabels,
  line: string,
  timestampNs: string,
): string {
  return JSON.stringify({
    streams: [
      { stream: buildLokiStream(labels), values: [[timestampNs, line]] },
    ],
  })
}

/**
 * Epoch-nanoseconds STRING for the Loki entry. Derives from the event's own
 * `at` (ISO-8601) when it parses, else the caller's `now()` fallback — this
 * keeps the Loki entry timestamp aligned with the journal event time even
 * when a push is retried or delayed within the session. Nanoseconds EXCEED
 * Number.MAX_SAFE_INTEGER at current epoch (~1.7e18), so the value is built by
 * appending the six nano digits to the integer millisecond epoch rather than
 * `ms * 1_000_000` (which would silently truncate low-order digits to float).
 */
export function lokiTimestampNs(at: string | undefined, nowMs: number): string {
  const eventMs = at === undefined ? Number.NaN : Date.parse(at)
  const ms = Number.isNaN(eventMs) ? nowMs : eventMs
  return `${Math.trunc(ms)}000000`
}

/** Pull the event's ISO `at` off a JSON line so pushLokiEvent can timestamp it. */
function eventAt(line: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const at = (parsed as Record<string, unknown>).at
  return typeof at === 'string' ? at : undefined
}

/**
 * POST one event. Timeout via AbortSignal (default LOKI_TIMEOUT_MS); any
 * failure (throw, abort, non-2xx) maps to {ok:false, error} — the caller
 * decides whether to note it once, then drops it. Never throws.
 */
export async function pushLoki(
  endpoint: string,
  headers: Record<string, string>,
  labels: LokiLabels,
  line: string,
  timestampNs: string,
  fetchImpl: LokiFetch,
  timeoutMs = LOKI_TIMEOUT_MS,
): Promise<LokiOutcome> {
  try {
    const base = endpoint.replace(/\/+$/, '')
    const response = await fetchImpl(`${base}${LOKI_PUSH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: buildLokiPushBody(labels, line, timestampNs),
      // AbortSignal.timeout is unref'd — a dead endpoint never pins the loop.
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: `Loki endpoint responded ${response.status}` }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    return { ok: false, error: message }
  }
}

/**
 * Fire-and-forget push (the 4.3 fan-out seam). `settings === null` or an empty
 * endpoint → disabled, ZERO fetch calls and no note. Otherwise: void the POST
 * promise (no-throw contract — the flow loop must never await or crash on it)
 * and route any failure through `state`, so the FIRST failure in the process
 * calls `onNote` once and every later one is silent.
 *
 * The entry timestamp comes from the line's own `at` when parseable, else the
 * caller's `now()` — see lokiTimestampNs.
 */
export function pushLokiEvent(
  settings: LokiSettings | null,
  labels: LokiLabels,
  line: string,
  deps: LokiPushDeps,
): void {
  if (settings === null) return
  if (settings.endpoint.length === 0) return
  const timestampNs = lokiTimestampNs(eventAt(line), deps.now())
  void pushLoki(
    settings.endpoint,
    settings.headers ?? {},
    labels,
    line,
    timestampNs,
    deps.fetchImpl,
    deps.timeoutMs ?? LOKI_TIMEOUT_MS,
  ).then((outcome) => {
    if (outcome.ok) return
    if (deps.state.noted) return
    deps.state.noted = true
    deps.onNote(outcome.error ?? 'loki push failed')
  })
}
