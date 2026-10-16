// AIDEV-NOTE: Pure /plan arg parsing — unit-testable without pi. A Jira-style
// ref (PROJECT-123) routes to the existing feature-plan-aven skill in work
// mode; anything else is treated as an aven ref (personal mode).

export type PlanArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parsePlanArgs(raw: string): PlanArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  const match = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/.exec(trimmed)
  if (match) {
    return { kind: 'jira', jiraId: `${match[1].toUpperCase()}-${match[2]}` }
  }
  return { kind: 'aven', ref: trimmed }
}
