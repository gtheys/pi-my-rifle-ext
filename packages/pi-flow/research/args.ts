// AIDEV-NOTE: Pure /research arg parsing — unit-testable without pi.
// `ID=<jira-id>` marks the topic as a known Jira ID (forceRef): the target
// classifier (research/refs.ts) then takes the ticket path in any mode.

export type ResearchArgs =
  | { kind: 'feature'; topic: string; forceRef?: boolean }
  | { kind: 'debug'; symptom: string }
  | { kind: 'help' }

export function parseResearchArgs(raw: string): ResearchArgs {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'help' }
  if (trimmed.startsWith('--debug')) {
    const symptom = trimmed.slice('--debug'.length).trim()
    if (symptom === '') return { kind: 'help' }
    return { kind: 'debug', symptom }
  }
  if (trimmed.startsWith('ID=')) {
    const topic = trimmed.slice('ID='.length).trim()
    if (topic === '') return { kind: 'help' }
    return { kind: 'feature', topic, forceRef: true }
  }
  return { kind: 'feature', topic: trimmed }
}
