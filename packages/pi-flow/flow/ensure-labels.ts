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

// AIDEV-NOTE: PMR-XQ7Y — the 'already exists' text match is legacy
// defence only: current `aven label create` is idempotent (a duplicate
// prints created-label and exits 0, verified), so this branch is normally
// unreachable. aven exposes no distinct exit code for it.
// AIDEV-TODO: drop the message match if aven stays idempotent; key off an
// exit code if aven ever reintroduces a duplicate error with one.
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
