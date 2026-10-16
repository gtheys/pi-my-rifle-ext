// AIDEV-NOTE: Pure /feedback arg parsing — mirrors validate/args.ts exactly
// (single ref, Jira-style or aven).

export type FeedbackArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseFeedbackArgs(raw: string): FeedbackArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 1) return { kind: 'help' }
  const ref = parts[0] ?? ''
  const match = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/.exec(ref)
  if (match) {
    return {
      kind: 'jira',
      jiraId: `${match[1].toUpperCase()}-${match[2]}`,
    }
  }
  return { kind: 'aven', ref }
}
