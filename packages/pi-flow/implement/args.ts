// AIDEV-NOTE: Pure /implement arg parsing — same shape as plan/args.ts.
// Jira-style ref (PROJECT-123) routes to work-mode tooling (jira_create_branch);
// anything else is a personal aven ref. --skip-research is the explicit flag
// demanded by the W76D needsResearchSkip gate.

import { parseRefKind } from '../flow/ref-kind.ts'

export type ImplementArgs =
  | { kind: 'jira'; jiraId: string; skipResearch: boolean }
  | { kind: 'aven'; ref: string; skipResearch: boolean }
  | { kind: 'help' }

export function parseImplementArgs(raw: string): ImplementArgs {
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
