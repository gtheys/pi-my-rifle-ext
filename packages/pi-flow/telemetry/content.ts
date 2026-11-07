// AIDEV-NOTE: opt-in content capture for telemetry spans. OFF by default —
// spans are metadata-only unless the user sets telemetry.captureContent.
// Levels are CUMULATIVE:
//   off   metadata only (default)
//   text  + assistant text on gen spans            (gen_ai.completion)
//   tools + tool calls the model made on gen spans (gen_ai.tool_calls),
//           tool input/output on tool spans        (tool.input / tool.output)
//   all   + the model's reasoning                  (gen_ai.reasoning)
// Captured content CAN contain secrets, code and personal data — it lands in
// the trace backend. Every value is truncated to maxContentChars (Tempo drops
// anything past max_attribute_bytes, default 2048, silently — see README).
// No redaction is attempted: the level is the control.
import type { SpanAttributes } from './attributes.ts'

export type ContentLevel = 'off' | 'text' | 'tools' | 'all'

export const CONTENT_LEVELS: readonly ContentLevel[] = [
  'off',
  'text',
  'tools',
  'all',
]

/** Default per-attribute cap; stays under Tempo's default 2048-byte limit. */
export const DEFAULT_MAX_CONTENT_CHARS = 2000

const RANK: Record<ContentLevel, number> = {
  off: 0,
  text: 1,
  tools: 2,
  all: 3,
}

/** True when `level` captures at least `need`. */
export function levelIncludes(
  level: ContentLevel,
  need: ContentLevel,
): boolean {
  return RANK[level] >= RANK[need]
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, max)}…[truncated ${dropped} chars]`
}

function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(value)
    if (out === undefined) return ''
    return out
  } catch {
    return '[unserializable]'
  }
}

export interface AssistantContent {
  text: string
  reasoning: string
  toolCalls: Array<{ name: string; arguments: unknown }>
}

/** Pull text / thinking / tool calls out of an assistant message (defensive, no any). */
export function extractAssistantContent(message: unknown): AssistantContent {
  const out: AssistantContent = { text: '', reasoning: '', toolCalls: [] }
  if (message == null || typeof message !== 'object') return out
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') {
    out.text = content
    return out
  }
  if (!Array.isArray(content)) return out
  const texts: string[] = []
  const thoughts: string[] = []
  for (const part of content) {
    if (part == null || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
    if (
      p.type === 'thinking' &&
      typeof p.thinking === 'string' &&
      p.redacted !== true
    ) {
      thoughts.push(p.thinking)
    }
    if (p.type === 'toolCall' && typeof p.name === 'string') {
      out.toolCalls.push({ name: p.name, arguments: p.arguments })
    }
  }
  out.text = texts.join('\n')
  out.reasoning = thoughts.join('\n')
  return out
}

/** Attributes to add to a gen span for the configured level. */
export function generationContentAttributes(
  level: ContentLevel,
  max: number,
  message: unknown,
): SpanAttributes {
  const attrs: SpanAttributes = {}
  if (level === 'off') return attrs
  const content = extractAssistantContent(message)
  if (content.text.length > 0) {
    attrs['gen_ai.completion'] = truncate(content.text, max)
  }
  if (levelIncludes(level, 'tools') && content.toolCalls.length > 0) {
    attrs['gen_ai.tool_calls'] = truncate(safeJson(content.toolCalls), max)
  }
  if (levelIncludes(level, 'all') && content.reasoning.length > 0) {
    attrs['gen_ai.reasoning'] = truncate(content.reasoning, max)
  }
  return attrs
}

/** Tool input as text (level tools+); '' when empty. */
export function toolInputText(args: unknown, max: number): string {
  if (args === undefined || args === null) return ''
  return truncate(safeJson(args), max)
}

/** Tool result as text (level tools+): joined text parts, else JSON. */
export function toolOutputText(result: unknown, max: number): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return truncate(result, max)
  if (typeof result === 'object') {
    const content = (result as Record<string, unknown>).content
    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const part of content) {
        if (part == null || typeof part !== 'object') continue
        const p = part as Record<string, unknown>
        if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
      }
      if (texts.length > 0) return truncate(texts.join('\n'), max)
    }
  }
  return truncate(safeJson(result), max)
}
