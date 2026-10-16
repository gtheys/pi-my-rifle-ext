// AIDEV-NOTE: Pure /flow arg parsing — ref + optional --skip-research
// passthrough. Same jira/aven split as implement/args.ts.

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
  const match = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/.exec(ref)
  if (match) {
    return {
      kind: 'jira',
      jiraId: `${match[1].toUpperCase()}-${match[2]}`,
      skipResearch,
    }
  }
  return { kind: 'aven', ref, skipResearch }
}
