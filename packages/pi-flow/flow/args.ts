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
  const parsed = parseRefKind(parts[0] ?? '')
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId }
  }
  return { kind: 'aven', ref: parsed.ref }
}
