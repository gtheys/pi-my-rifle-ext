// AIDEV-NOTE: Pure next-phase resolver for /flow. Aven labels ARE the run
// state: the first phase whose completion label is missing is the one to run
// — that single rule gives resume (kill mid-phase -> label absent -> re-run
// the same phase) and no-duplicated-commits (label present -> phase skipped).
// The table below is the ONLY place the phase<->label lifecycle is mapped;
// reconcile with phase-state.ts LIFECYCLE_LABELS before renaming labels.
// Lifecycle is PIV (PMR-Z2K7): plan -> implement -> validate -> feedback.
// Research is no longer a lifecycle phase — the /research and /brainstorm
// commands still exist outside the gates.

export type Phase = 'plan' | 'implement' | 'validate' | 'feedback'

// phase -> the aven label that marks this phase complete
export const PHASE_LABEL: Record<Phase, string> = {
  plan: 'planned',
  implement: 'active',
  validate: 'review-passed',
  feedback: 'done',
}

export type NextPhase = { kind: 'phase'; phase: Phase } | { kind: 'done' }

const PHASE_ORDER: readonly Phase[] = [
  'plan',
  'implement',
  'validate',
  'feedback',
]

export function nextPhase(labels: readonly string[]): NextPhase {
  const first = PHASE_ORDER.find(
    (phase) => !labels.includes(PHASE_LABEL[phase]),
  )
  if (first === undefined) return { kind: 'done' }
  return { kind: 'phase', phase: first }
}
