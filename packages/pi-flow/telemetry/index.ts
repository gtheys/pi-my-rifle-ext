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

  const ensureTrace = (): void => {
    if (state.traceId !== null) return
    const ctx = parseTraceparent(deps.env.PI_FLOW_TRACEPARENT)
    if (ctx !== null) {
      state.traceId = ctx.traceId
      state.rootParentId = ctx.parentId
      return
    }
    state.traceId = randomTraceId(deps.rng)
    state.rootParentId = null
  }

  const subscribe = (settings: TelemetrySettings): void => {
    state.enabled = true
    state.settings = settings
    ensureTrace()
    state.flow = flowAttributes(deps.env)
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
        state.openTools.delete(event.toolCallId)
        let statusCode = 1
        let statusMessage: string | undefined
        if (event.isError) statusCode = 2
        if (event.isError) statusMessage = `${event.toolName} failed`
        const span: TelemetrySpan = {
          traceId: state.traceId ?? randomTraceId(deps.rng),
          spanId: open.spanId,
          parentSpanId: state.rootParentId ?? undefined,
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
          parentSpanId: state.rootParentId ?? undefined,
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
