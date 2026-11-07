// AIDEV-NOTE (PMR-R8AG): telemetry wiring. Hard no-backend rules (part of
// the test gate): telemetry disabled or unconfigured = the session_start
// probe subscribes to NOTHING else and allocates nothing; endpoint
// unreachable = fire-and-forget export that fails silently after at most
// one journal note per process; tool calls and turns proceed identically
// whether export succeeds, fails, or no backend exists. Spans are
// metadata-only (attribute mapping in attributes.ts — no prompt or
// completion content ever enters a span).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  flowAttributes,
  generationSpanAttributes,
  parseTraceparent,
  randomSpanId,
  randomTraceId,
  type SpanAttributes,
  type TelemetryEnv,
  type TelemetryRng,
  toolSpanAttributes,
} from './attributes.ts'
import {
  exportSpans,
  type TelemetryFetch,
  type TelemetrySpan,
} from './exporter.ts'

/** Resolved telemetry settings; null = disabled (subscribe to nothing). */
export interface TelemetrySettings {
  endpoint: string
  headers: Record<string, string>
}

export interface TelemetryDeps {
  /** Load settings for the session cwd; null means OFF. */
  loadSettings: (cwd: string) => Promise<TelemetrySettings | null>
  env: TelemetryEnv
  rng: TelemetryRng
  fetchImpl: TelemetryFetch
  now: () => number
  /** Journal-note hook; called at most once per process, on first failure. */
  onExportFailure: (error: string) => void
}

const FLUSH_THRESHOLD = 16
const ROLE_MAX = 40

/**
 * Session span name: "<flow ref> - <role>". The role is the agent name up to
 * its first colon ("Review: changes against 'abc…'" -> "review",
 * "Deviation check: PMR-1" -> "deviation check"), so names stay short and
 * groupable; the full agent name and phase remain span attributes.
 */
export function sessionSpanName(flow: SpanAttributes): string {
  let role = (flow['agent.name'] ?? '').split(':')[0].trim().toLowerCase()
  if (role.length > ROLE_MAX) role = role.slice(0, ROLE_MAX).trimEnd()
  if (role.length === 0) role = 'worker'
  const ref = flow['flow.ref']
  if (ref === undefined) return role
  return `${ref} - ${role}`
}

interface OpenToolSpan {
  spanId: string
  name: string
  startUnixNano: string
  attributes: SpanAttributes
}

function toUnixNano(ms: number): string {
  return `${Math.floor(ms * 1_000_000)}`
}

/** Read usage numbers off an assistant message defensively (no any). */
function readUsage(
  message: unknown,
): { input: number; output: number; model: string } | null {
  if (message == null || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.role !== 'assistant') return null
  const usage = m.usage
  if (usage == null || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  if (typeof u.input !== 'number' || typeof u.output !== 'number') return null
  let model = 'unknown'
  if (typeof m.model === 'string' && m.model.length > 0) model = m.model
  return { input: u.input, output: u.output, model }
}

export interface TelemetryState {
  enabled: boolean
  settings: TelemetrySettings | null
  traceId: string | null
  rootParentId: string | null
  /** traceId came from PI_FLOW_TRACEPARENT (so a later clear must reset it). */
  fromFlow: boolean
  /** flow trace ids whose root span this (main) process already emitted. */
  rootsEmitted: Set<string>
  /** worker session span (child of the flow root); null outside flow workers. */
  session: { spanId: string } | null
  flow: SpanAttributes
  openTools: Map<string, OpenToolSpan>
  buffer: TelemetrySpan[]
  noted: boolean
  unsubscribers: Array<() => void>
}

/**
 * Register the telemetry extension surface on pi. The session_start probe
 * decides once per session: settings null = zero telemetry subscriptions
 * (the probe itself is the only overhead). session_shutdown unsubscribes
 * and flushes whatever is left.
 */
export function registerTelemetry(pi: ExtensionAPI, deps: TelemetryDeps): void {
  const state: TelemetryState = {
    enabled: false,
    settings: null,
    traceId: null,
    rootParentId: null,
    fromFlow: false,
    rootsEmitted: new Set(),
    session: null,
    flow: {},
    openTools: new Map(),
    buffer: [],
    noted: false,
    unsubscribers: [],
  }

  const flush = (): void => {
    if (state.buffer.length === 0) return
    const spans = state.buffer.splice(0, state.buffer.length)
    const settings = state.settings
    if (settings === null) return
    // fire-and-forget: failures surface at most one note, then drop
    void exportSpans(
      settings.endpoint,
      settings.headers,
      { 'service.name': 'pi-flow' },
      spans,
      deps.fetchImpl,
    ).then((outcome) => {
      if (outcome.ok) return
      if (state.noted) return
      state.noted = true
      deps.onExportFailure(outcome.error ?? 'unknown export failure')
    })
  }

  // AIDEV-NOTE: the flow loop reserves the root span id inside
  // PI_FLOW_TRACEPARENT but nothing ever exported that span, so every trace
  // showed "<root span not yet received>" in Grafana. The MAIN process
  // (no PI_SUBAGENT_NAME — workers set it) exports the root once per flow
  // trace, named "flow <ref>". shortcut: it is a zero-length marker emitted
  // when the trace is first seen, not a span covering the whole run — upgrade
  // if per-run duration on the root matters (Tempo derives trace duration
  // from the child spans anyway).
  const emitFlowRoot = (traceId: string, rootSpanId: string): void => {
    if (state.rootsEmitted.has(traceId)) return
    if (isWorker()) return
    state.rootsEmitted.add(traceId)
    const nowNano = toUnixNano(deps.now())
    let name = 'flow'
    const ref = state.flow['flow.ref']
    if (ref !== undefined) name = `flow ${ref}`
    state.buffer.push({
      traceId,
      spanId: rootSpanId,
      name,
      kind: 1,
      startTimeUnixNano: nowNano,
      endTimeUnixNano: nowNano,
      attributes: { ...state.flow },
      statusCode: 0,
    })
  }

  const isWorker = (): boolean => {
    const name = deps.env.PI_SUBAGENT_NAME
    return name !== undefined && name.length > 0
  }

  // AIDEV-NOTE: workers get one session span ("<agent> · <phase>") between
  // the flow root and their tool/gen spans, so a trace reads as a tree:
  // flow <ref> -> worker session -> tool/gen. It is exported ONCE, as a
  // zero-length marker, the first time the trace is seen — so a crashed
  // worker's children never hang off a missing parent. shortcut: the span
  // carries no real duration (trace duration comes from the child spans).
  // Re-sending the same span id with a later end does NOT work: Tempo keeps
  // both copies until compaction and which one wins is undefined (verified
  // against the homelab Tempo 2.10), so never update a span in place.
  const parentFor = (): string | undefined => {
    if (state.session !== null) return state.session.spanId
    return state.rootParentId ?? undefined
  }

  // AIDEV-NOTE: the flow loop stamps PI_FLOW_REF / PHASE / TRACEPARENT into
  // process.env at run START, which is after session_start in the main
  // session. Re-read the env on every span so late stamps (and phase
  // changes, and clears at terminal transitions) are honoured; a one-shot
  // read at subscribe time left main-session spans without flow.ref.
  const ensureTrace = (): void => {
    state.flow = flowAttributes(deps.env)
    const ctx = parseTraceparent(deps.env.PI_FLOW_TRACEPARENT)
    if (ctx !== null) {
      state.traceId = ctx.traceId
      state.rootParentId = ctx.parentId
      state.fromFlow = true
      emitFlowRoot(ctx.traceId, ctx.parentId)
      if (isWorker() && state.session === null) {
        const spanId = randomSpanId(deps.rng)
        const nowNano = toUnixNano(deps.now())
        state.session = { spanId }
        const name = sessionSpanName(state.flow)
        state.buffer.push({
          traceId: ctx.traceId,
          spanId,
          parentSpanId: ctx.parentId,
          name,
          kind: 1,
          startTimeUnixNano: nowNano,
          endTimeUnixNano: nowNano,
          attributes: { ...state.flow },
          statusCode: 0,
        })
      }
      return
    }
    if (state.traceId !== null && !state.fromFlow) return
    // no flow traceparent (never stamped, or cleared): own random trace
    state.traceId = randomTraceId(deps.rng)
    state.rootParentId = null
    state.fromFlow = false
  }

  const subscribe = (settings: TelemetrySettings): void => {
    state.enabled = true
    state.settings = settings
    ensureTrace()
    state.unsubscribers.push(
      pi.on('tool_execution_start', (event) => {
        if (!state.enabled) return
        ensureTrace()
        state.openTools.set(event.toolCallId, {
          spanId: randomSpanId(deps.rng),
          name: `tool ${event.toolName}`,
          startUnixNano: toUnixNano(deps.now()),
          attributes: toolSpanAttributes(state.flow, {
            toolName: event.toolName,
            isError: false,
          }),
        })
      }),
    )
    state.unsubscribers.push(
      pi.on('tool_execution_end', (event) => {
        if (!state.enabled) return
        const open = state.openTools.get(event.toolCallId)
        if (open === undefined) return
        ensureTrace()
        state.openTools.delete(event.toolCallId)
        let statusCode = 1
        let statusMessage: string | undefined
        if (event.isError) statusCode = 2
        if (event.isError) statusMessage = `${event.toolName} failed`
        const span: TelemetrySpan = {
          traceId: state.traceId ?? randomTraceId(deps.rng),
          spanId: open.spanId,
          parentSpanId: parentFor(),
          name: open.name,
          kind: 1,
          startTimeUnixNano: open.startUnixNano,
          endTimeUnixNano: toUnixNano(deps.now()),
          attributes: toolSpanAttributes(state.flow, {
            toolName: event.toolName,
            isError: event.isError,
          }),
          statusCode,
          ...(statusMessage !== undefined ? { statusMessage } : {}),
        }
        state.buffer.push(span)
        if (state.buffer.length >= FLUSH_THRESHOLD) flush()
      }),
    )
    state.unsubscribers.push(
      pi.on('turn_end', (event) => {
        if (!state.enabled) return
        const usage = readUsage(event.message)
        if (usage === null) return
        ensureTrace()
        const endMs = deps.now()
        state.buffer.push({
          traceId: state.traceId ?? randomTraceId(deps.rng),
          spanId: randomSpanId(deps.rng),
          parentSpanId: parentFor(),
          name: `gen ${usage.model}`,
          kind: 1,
          startTimeUnixNano: toUnixNano(endMs),
          endTimeUnixNano: toUnixNano(endMs),
          attributes: generationSpanAttributes(state.flow, {
            model: usage.model,
            inputTokens: usage.input,
            outputTokens: usage.output,
          }),
          statusCode: 0,
        })
        if (state.buffer.length >= FLUSH_THRESHOLD) flush()
      }),
    )
    state.unsubscribers.push(
      pi.on('session_shutdown', () => {
        if (!state.enabled) return
        flush()
        for (const off of state.unsubscribers) off()
        state.unsubscribers.length = 0
        state.enabled = false
      }),
    )
  }

  pi.on('session_start', (_event, ctx) => {
    if (state.enabled) return
    void deps
      .loadSettings(ctx.cwd)
      .then((settings) => {
        if (settings === null) return
        subscribe(settings)
      })
      .catch(() => {
        // config read failure = telemetry stays off, session proceeds
      })
  })
}
