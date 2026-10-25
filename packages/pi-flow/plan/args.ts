// AIDEV-NOTE: Pure /plan arg parsing — unit-testable without pi. A Jira-style
// ref (PROJECT-123) routes to the existing feature-plan-aven skill in work
// mode; anything else is treated as an aven ref (personal mode).

import { parseRefKind } from '../flow/ref-kind.ts'

export type PlanArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parsePlanArgs(raw: string): PlanArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  const parsed = parseRefKind(trimmed)
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId }
  }
  return { kind: 'aven', ref: parsed.ref }
}
