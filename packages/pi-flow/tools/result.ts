// AIDEV-NOTE: PMR-T22H — shared AgentToolResult shaping for pi-flow tools:
// one text content block, typed details, isError only when set.
import type { AgentToolResult } from '@earendil-works/pi-coding-agent'

export function toolResult<Details>(
  text: string,
  details: Details,
  opts: { isError?: boolean } = {},
): AgentToolResult<Details> {
  const result: AgentToolResult<Details> = {
    content: [{ type: 'text', text }],
    details,
  }
  if (opts.isError === true) {
    result.isError = true
  }
  return result
}
