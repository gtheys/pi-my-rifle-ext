// AIDEV-NOTE: Pure /flow arg parsing — ref + optional --skip-research
// passthrough. Same jira/aven split as implement/args.ts.

import { parseRefKind } from './ref-kind.ts'

export type FlowArgs =
  | { kind: 'jira'; jiraId: string; skipResearch: boolean }
  | { kind: 'aven'; ref: string; skipResearch: boolean }
  | { kind: 'help' }

export function parseFlowArgs(raw: string): FlowArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  const parts = trimmed.split(/\s+/)
  const skipResearch = parts.includes('--skip-research')
  const rest = parts.filter((p) => p !== '--skip-research')
  if (rest.length !== 1) return { kind: 'help' }
  const ref = rest[0] ?? ''
  const parsed = parseRefKind(ref)
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId, skipResearch }
  }
  return { kind: 'aven', ref: parsed.ref, skipResearch }
}
