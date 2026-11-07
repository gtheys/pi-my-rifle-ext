// AIDEV-NOTE (PMR-R8AG): pure env->attribute mapping for telemetry spans.
// No I/O, fully unit-tested. Metadata only — never prompt or completion
// bodies (hard rule from the observability plan: spans describe, they do
// not leak content).
export type TelemetryEnv = Record<string, string | undefined>

export type SpanAttributes = Record<string, string>

/** W3C traceparent: 00-<32 hex traceId>-<16 hex parentId>-<2 hex flags>. */
export interface TraceContext {
  traceId: string
  parentId: string
}

const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

/** Parse PI_FLOW_TRACEPARENT into trace coordinates; null when absent/invalid. */
export function parseTraceparent(
  value: string | undefined,
): TraceContext | null {
  if (value === undefined) return null
  if (!TRACEPARENT_RE.test(value)) return null
  const parts = value.split('-')
  return { traceId: parts[1], parentId: parts[2] }
}

/** Bytes source for id generation (crypto.randomBytes in wiring, stub in tests). */
export interface TelemetryRng {
  bytes: (n: number) => Uint8Array
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

export function randomTraceId(rng: TelemetryRng): string {
  return toHex(rng.bytes(16))
}

export function randomSpanId(rng: TelemetryRng): string {
  return toHex(rng.bytes(8))
}

/**
 * Map the attribution env into span attributes. Keys follow the flow /
 * subagent env vars so backend queries read the same names everywhere:
 * flow.ref, phase, agent.name, subtask, parent.session. Empty or missing
 * values are omitted, never forwarded as empty strings.
 */
export function flowAttributes(env: TelemetryEnv): SpanAttributes {
  const attrs: SpanAttributes = {}
  const mapping: Array<[string, string]> = [
    ['flow.ref', 'PI_FLOW_REF'],
    ['phase', 'PI_FLOW_PHASE'],
    ['agent.name', 'PI_SUBAGENT_NAME'],
    ['subtask', 'PI_FLOW_SUBTASK'],
    ['parent.session', 'PI_SUBAGENT_PARENT_SESSION'],
  ]
  for (const [attrKey, envKey] of mapping) {
    const value = env[envKey]
    if (value !== undefined && value.length > 0) {
      attrs[attrKey] = value
    }
  }
  return attrs
}

export interface ToolSpanInput {
  toolName: string
  isError: boolean
}

/** Attributes for a tool-execution span (gen_ai.tool.* conventions). */
export function toolSpanAttributes(
  flow: SpanAttributes,
  tool: ToolSpanInput,
): SpanAttributes {
  const attrs: SpanAttributes = { ...flow }
  attrs['gen_ai.tool.name'] = tool.toolName
  attrs['tool.error'] = tool.isError ? 'true' : 'false'
  return attrs
}

export interface GenerationSpanInput {
  model: string
  inputTokens: number
  outputTokens: number
}

/** Attributes for a generation span (OTLP GenAI semantic conventions). */
export function generationSpanAttributes(
  flow: SpanAttributes,
  gen: GenerationSpanInput,
): SpanAttributes {
  const attrs: SpanAttributes = { ...flow }
  attrs['gen_ai.operation.name'] = 'generate_content'
  attrs['gen_ai.request.model'] = gen.model
  attrs['gen_ai.usage.input_tokens'] = `${gen.inputTokens}`
  attrs['gen_ai.usage.output_tokens'] = `${gen.outputTokens}`
  return attrs
}
