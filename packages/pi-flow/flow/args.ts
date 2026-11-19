// AIDEV-NOTE: Pure /flow arg parsing — ref only (PMR-Z2K7: --skip-research
// removed with the research phase). Same jira/aven split as implement/args.ts.

import { parseRefKind } from './ref-kind.ts'

export type FlowArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseFlowArgs(raw: string): FlowArgs {
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 1 || parts[0] === '') return { kind: 'help' }
  const token = parts[0] ?? ''
  // PMR-N0W6: a literal '/flow help' is a usage request, not a run for a
  // ticket named 'help' — reserve the exact token (case-insensitive) for the
  // single-token shape. Multi-arg shapes ('/flow help X') already return
  // help above; similar-but-different tokens ('helpme') still parse as refs.
  if (token.toLowerCase() === 'help') return { kind: 'help' }
  const parsed = parseRefKind(token)
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId }
  }
  return { kind: 'aven', ref: parsed.ref }
}
