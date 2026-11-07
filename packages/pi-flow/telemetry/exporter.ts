// AIDEV-NOTE (PMR-R8AG): minimal OTLP/HTTP JSON trace exporter. Hand-rolled
// on purpose — no OTel SDK dependency, no growing buffers, no retry queue.
// Fire-and-forget with a short timeout; failures are dropped silently after
// at most one journal note per process (never a rejected promise into the
// host). Tempo's OTLP/HTTP receiver accepts this JSON at <endpoint>/v1/traces.
export interface TelemetrySpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** OTel span kind: 1 INTERNAL, 2 SERVER, 3 CLIENT. */
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, string>
  /** 2 = ERROR, 1 = OK, 0 = UNSET. */
  statusCode: number
  statusMessage?: string
}

export interface ExportOutcome {
  ok: boolean
  error?: string
}

export type TelemetryFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{ status: number }>

function attrValue(value: string): { stringValue: string } {
  return { stringValue: value }
}

/**
 * Build the OTLP export request body (pure). Attribute values ride as
 * strings; numeric gen_ai usage tokens are formatted strings, which OTLP
 * JSON accepts and Tempo indexes fine.
 */
export function buildOtlpBody(
  resourceAttributes: Record<string, string>,
  spans: readonly TelemetrySpan[],
): string {
  const resourceAttrs = Object.keys(resourceAttributes).map((key) => ({
    key,
    value: attrValue(resourceAttributes[key]),
  }))
  const otlpSpans = spans.map((span) => {
    const out: Record<string, unknown> = {
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: span.startTimeUnixNano,
      endTimeUnixNano: span.endTimeUnixNano,
      attributes: Object.keys(span.attributes).map((key) => ({
        key,
        value: attrValue(span.attributes[key]),
      })),
      status: { code: span.statusCode },
    }
    if (span.parentSpanId !== undefined) {
      out.parentSpanId = span.parentSpanId
    }
    if (span.statusMessage !== undefined) {
      out.status = { code: span.statusCode, message: span.statusMessage }
    }
    return out
  })
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: 'pi-flow-telemetry', version: '1.0.0' },
            spans: otlpSpans,
          },
        ],
      },
    ],
  })
}

/**
 * POST one batch of spans. Timeout via AbortSignal (default 2500 ms);
 * any failure maps to {ok:false, error} — the caller decides whether to
 * note it once, then drops it.
 */
export async function exportSpans(
  endpoint: string,
  headers: Record<string, string>,
  resourceAttributes: Record<string, string>,
  spans: readonly TelemetrySpan[],
  fetchImpl: TelemetryFetch,
  timeoutMs = 2500,
): Promise<ExportOutcome> {
  if (spans.length === 0) return { ok: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const base = endpoint.replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: buildOtlpBody(resourceAttributes, spans),
      signal: controller.signal,
    })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, error: `OTLP endpoint responded ${response.status}` }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}
