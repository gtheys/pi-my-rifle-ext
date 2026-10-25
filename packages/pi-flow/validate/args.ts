// AIDEV-NOTE: Pure /validate arg parsing — mirrors implement/args.ts minus the
// --skip-research flag (validate has no skip; the Jira evidence comment is
// mandatory in work mode).

import { parseRefKind } from '../flow/ref-kind.ts'

export type ValidateArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseValidateArgs(raw: string): ValidateArgs {
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
