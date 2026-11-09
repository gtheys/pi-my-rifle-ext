// AIDEV-NOTE (PMR-R8AG): telemetry wiring. Hard no-backend rules (part of
// the test gate): telemetry disabled or unconfigured = the session_start
// probe subscribes to NOTHING else and allocates nothing; endpoint
// unreachable = fire-and-forget export that fails silently after at most
// one journal note per process; tool calls and turns proceed identically
// whether export succeeds, fails, or no backend exists. Spans are
// metadata-only (attribute mapping in attributes.ts — no prompt or
// completion content ever enters a span).
import { createHash } from 'node:crypto'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { agentRole } from '../flow/agent-role.ts'
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
  type ContentLevel,
  DEFAULT_MAX_CONTENT_CHARS,
  generationContentAttributes,
  levelIncludes,
  toolInputText,
  toolOutputText,
} from './content.ts'
import {
  exportSpans,
  type TelemetryFetch,
  type TelemetrySpan,
} from './exporter.ts'

/** Resolved telemetry settings; null = disabled (subscribe to nothing). */
export interface TelemetrySettings {
  endpoint: string
  headers: Record<string, string>
  /** Content captured on spans; absent = 'off' (metadata only). */
  captureContent?: ContentLevel
  /** Jira issue base URL (…/browse/); work-mode spans get flow.url = base + ref. */
  jiraBaseUrl?: string
  /** Per-attribute cap for captured content; absent = DEFAULT_MAX_CONTENT_CHARS. */
  maxContentChars?: number
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
/**
 * Deterministic phase span id: first 16 hex chars of sha256(traceId:phase).
 * The main process exports the phase span; workers recompute the same id from
 * their own PI_FLOW_TRACEPARENT + PI_FLOW_PHASE to nest under it, so no extra
 * env var has to cross the package boundary.
 */
export function phaseSpanId(traceId: string, phase: string): string {
  return createHash('sha256')
    .update(`${traceId}:${phase}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Session span name: "<flow ref> - <role>". The role comes from the agent
 * type when known (scout, worker, reviewer...), else from the agent name up
 * to its first colon (see flow/agent-role.ts); full name, type and phase stay
 * as span attributes.
 */
export function sessionSpanName(flow: SpanAttributes): string {
  const role = agentRole(flow['agent.type'], flow['agent.name'])
  const ref = flow['flow.ref']
  if (ref === undefined) return role
  return `${ref} - ${role}`
}

interface OpenToolSpan {
  spanId: string
  name: string
  startUnixNano: string
  parentSpanId: string | undefined
  attributes: SpanAttributes
  /** captured tool input (level tools+), empty otherwise */
  input: string
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
  /** main-process open phase span (exported when the phase closes). */
  phase: {
    traceId: string
    name: string
    spanId: string
    startNano: string
    attrs: SpanAttributes
    /** root span id of ITS trace (rootParentId may already point at a newer trace when it closes). */
    parentId: string | null
    /** already sent: kept as parent for trailing spans, never re-sent. */
    exported: boolean
  } | null
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
export interface TelemetryHandle {
  /**
   * Call after the flow loop stamps/re-stamps/clears the flow env (start,
   * phase change, halt, pause, done, supersede). Closes + flushes a phase
   * that just ended even though no further span ever fires, and flushes the
   * flow root marker immediately. No-op while telemetry is off.
   */
  syncFlowEnv: () => void
}

export function registerTelemetry(
  pi: ExtensionAPI,
  deps: TelemetryDeps,
): TelemetryHandle {
  const state: TelemetryState = {
    enabled: false,
    settings: null,
    traceId: null,
    rootParentId: null,
    fromFlow: false,
    rootsEmitted: new Set(),
    session: null,
    phase: null,
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

  const contentLevel = (): ContentLevel =>
    state.settings?.captureContent ?? 'off'
  const toolContentAttributes = (
    input: string,
    result: unknown,
  ): SpanAttributes => {
    const attrs: SpanAttributes = {}
    if (!levelIncludes(contentLevel(), 'tools')) return attrs
    if (input.length > 0) attrs['tool.input'] = input
    const output = toolOutputText(result, contentMax())
    if (output.length > 0) attrs['tool.output'] = output
    return attrs
  }
  const contentMax = (): number =>
    state.settings?.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS

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
      attributes: { ...state.flow, 'flow.span': 'root' },
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
    if (state.phase !== null) return state.phase.spanId
    return state.rootParentId ?? undefined
  }

  // AIDEV-NOTE: phase spans. The main process exports one span per flow
  // phase ("<ref> - plan"), with its real start/end, and parents its own
  // tool/gen spans on it; workers parent their session span on the same
  // deterministic id (phaseSpanId). Clicking the phase in Grafana shows
  // every call made in that phase. The span is exported when the phase
  // CLOSES: flow_phase_complete finishing (the LAST phase has no successor,
  // so without this its span stayed unsent and review/deviation sessions
  // under it hung off a missing parent), next phase seen, flow cleared, or
  // shutdown — never updated in place (Tempo keeps both copies of a re-sent span id). shortcut: a main
  // process killed mid-phase never exports that phase span, so its children
  // hang off a missing parent; the flow root still names the trace.
  const closePhase = (): void => {
    const open = state.phase
    if (open === null || open.exported) return
    open.exported = true
    state.buffer.push({
      traceId: open.traceId,
      spanId: open.spanId,
      parentSpanId: open.parentId ?? undefined,
      name: open.name,
      kind: 1,
      startTimeUnixNano: open.startNano,
      endTimeUnixNano: toUnixNano(deps.now()),
      attributes: open.attrs,
      statusCode: 0,
    })
  }

  const syncPhase = (traceId: string | null): void => {
    if (isWorker()) return
    const phase = state.flow.phase
    const open = state.phase
    if (open !== null) {
      if (traceId === open.traceId && phase === open.attrs.phase) return
      closePhase()
      state.phase = null
    }
    if (traceId === null || phase === undefined) return
    let name = phase
    const ref = state.flow['flow.ref']
    if (ref !== undefined) name = `${ref} - ${phase}`
    state.phase = {
      traceId,
      name,
      spanId: phaseSpanId(traceId, phase),
      startNano: toUnixNano(deps.now()),
      attrs: { ...state.flow, 'flow.span': 'phase' },
      parentId: state.rootParentId,
      exported: false,
    }
  }

  // AIDEV-NOTE: the flow loop stamps PI_FLOW_REF / PHASE / TRACEPARENT into
  // process.env at run START, which is after session_start in the main
  // session. Re-read the env on every span so late stamps (and phase
  // changes, and clears at terminal transitions) are honoured; a one-shot
  // read at subscribe time left main-session spans without flow.ref.
  const ensureTrace = (): void => {
    state.flow = flowAttributes(deps.env)
    const base = state.settings?.jiraBaseUrl
    const trackRef = state.flow['flow.ref']
    if (
      base !== undefined &&
      base.length > 0 &&
      state.flow['flow.mode'] === 'work' &&
      trackRef !== undefined
    ) {
      state.flow['flow.url'] = `${base}${trackRef}`
    }
    const ctx = parseTraceparent(deps.env.PI_FLOW_TRACEPARENT)
    if (ctx !== null) {
      state.traceId = ctx.traceId
      state.rootParentId = ctx.parentId
      state.fromFlow = true
      emitFlowRoot(ctx.traceId, ctx.parentId)
      syncPhase(ctx.traceId)
      if (isWorker() && state.session === null) {
        const spanId = randomSpanId(deps.rng)
        const nowNano = toUnixNano(deps.now())
        state.session = { spanId }
        const name = sessionSpanName(state.flow)
        let sessionParent = ctx.parentId
        const workerPhase = state.flow.phase
        if (workerPhase !== undefined) {
          sessionParent = phaseSpanId(ctx.traceId, workerPhase)
        }
        state.buffer.push({
          traceId: ctx.traceId,
          spanId,
          parentSpanId: sessionParent,
          name,
          kind: 1,
          startTimeUnixNano: nowNano,
          endTimeUnixNano: nowNano,
          attributes: { ...state.flow, 'flow.span': 'session' },
          statusCode: 0,
        })
      }
      return
    }
    syncPhase(null)
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
        let input = ''
        if (levelIncludes(contentLevel(), 'tools')) {
          input = toolInputText(event.args, contentMax())
        }
        state.openTools.set(event.toolCallId, {
          spanId: randomSpanId(deps.rng),
          name: `tool ${event.toolName}`,
          startUnixNano: toUnixNano(deps.now()),
          parentSpanId: parentFor(),
          attributes: toolSpanAttributes(state.flow, {
            toolName: event.toolName,
            isError: false,
          }),
          input,
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
          parentSpanId: open.parentSpanId,
          name: open.name,
          kind: 1,
          startTimeUnixNano: open.startUnixNano,
          endTimeUnixNano: toUnixNano(deps.now()),
          attributes: {
            ...toolSpanAttributes(state.flow, {
              toolName: event.toolName,
              isError: event.isError,
            }),
            ...toolContentAttributes(open.input, event.result),
          },
          statusCode,
          ...(statusMessage !== undefined ? { statusMessage } : {}),
        }
        state.buffer.push(span)
        if (event.toolName === 'flow_phase_complete' && !event.isError) {
          // flush NOW: the main session may sit idle (or end) after the last
          // phase, and the buffer only auto-flushes at FLUSH_THRESHOLD spans
          closePhase()
          flush()
        }
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
          attributes: {
            ...generationSpanAttributes(state.flow, {
              model: usage.model,
              inputTokens: usage.input,
              outputTokens: usage.output,
            }),
            ...generationContentAttributes(
              contentLevel(),
              contentMax(),
              event.message,
            ),
          },
          statusCode: 0,
        })
        if (state.buffer.length >= FLUSH_THRESHOLD) flush()
      }),
    )
    state.unsubscribers.push(
      pi.on('session_shutdown', () => {
        if (!state.enabled) return
        closePhase()
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

  return {
    syncFlowEnv: () => {
      if (!state.enabled) return
      const before = state.buffer.length
      ensureTrace()
      if (state.buffer.length > before) flush()
    },
  }
}
