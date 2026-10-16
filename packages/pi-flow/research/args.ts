// AIDEV-NOTE: Pure /research arg parsing — unit-testable without pi.

export type ResearchArgs =
  | { kind: 'feature'; topic: string }
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
  return { kind: 'feature', topic: trimmed }
}
