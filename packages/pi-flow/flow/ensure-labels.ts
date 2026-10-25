// AIDEV-NOTE: Pure failure classification for the best-effort label
// bootstrap (PMR-SE93). No I/O — the boundary in index.ts shells out and
// feeds the thrown error here, then acts on the kind:
//   aven-missing    → one visible warning; gates will fail-closed later
//   already-exists  → fine, silent
//   other           → surfaced warning with stderr included
// Classification stays best-effort: any of these must never break startup.

export type LabelFailureKind = 'aven-missing' | 'already-exists' | 'other'

export interface LabelFailure {
  kind: LabelFailureKind
  /** stderr or message text, for the "other" surface-the-error warning. */
  detail?: string
}

function errorText(error: unknown): string | undefined {
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.length > 0) return stderr
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return undefined
}

export function classifyLabelFailure(error: unknown): LabelFailure {
  const code = (error as { code?: unknown })?.code
  if (code === 'ENOENT') {
    return { kind: 'aven-missing' }
  }
  const text = errorText(error)
  if (text?.includes('already exists')) {
    return { kind: 'already-exists' }
  }
  if (text !== undefined) {
    return { kind: 'other', detail: text }
  }
  return { kind: 'other' }
}
