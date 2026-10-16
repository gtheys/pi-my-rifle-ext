// AIDEV-NOTE: Pure /validate arg parsing — mirrors implement/args.ts minus the
// --skip-research flag (validate has no skip; the Jira evidence comment is
// mandatory in work mode).

export type ValidateArgs =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }
  | { kind: 'help' }

export function parseValidateArgs(raw: string): ValidateArgs {
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
