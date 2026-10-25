// AIDEV-NOTE: Pure /feedback arg parsing — mirrors validate/args.ts exactly
// (single ref, Jira-style or aven).

import { parseRefKind } from '../flow/ref-kind.ts'

export type FeedbackArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseFeedbackArgs(raw: string): FeedbackArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 1) return { kind: 'help' }
  const parsed = parseRefKind(parts[0] ?? '')
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId }
  }
  return { kind: 'aven', ref: parsed.ref }
}
