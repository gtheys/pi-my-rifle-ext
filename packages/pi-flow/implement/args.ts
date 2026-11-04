// AIDEV-NOTE: Pure /implement arg parsing — same shape as plan/args.ts.
// Jira-style ref (PROJECT-123) routes to work-mode tooling (jira_create_branch);
// anything else is a personal aven ref. (PMR-Z2K7: --skip-research removed
// with the research phase.)

import { parseRefKind } from '../flow/ref-kind.ts'

export type ImplementArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseImplementArgs(raw: string): ImplementArgs {
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 1 || parts[0] === '') return { kind: 'help' }
  const parsed = parseRefKind(parts[0] ?? '')
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId }
  }
  return { kind: 'aven', ref: parsed.ref }
}
