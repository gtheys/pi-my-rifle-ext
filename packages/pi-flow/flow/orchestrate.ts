// AIDEV-NOTE: Pure next-phase resolver for /flow. Aven labels ARE the run
// state: the first phase whose completion label is missing is the one to run
// — that single rule gives resume (kill mid-phase -> label absent -> re-run
// the same phase) and no-duplicated-commits (label present -> phase skipped).
// The table below is the ONLY place the phase<->label lifecycle is mapped;
// reconcile with phase-state.ts LIFECYCLE_LABELS before renaming labels.
// Research is special: it is satisfied by 'researched', by the durable
// 'research-skipped' label, or by the skipResearch flag. The SAME rule must
// govern /flow start AND loop advance — resolving "first missing" over the
// full order while research is only flag-satisfied would re-run completed
// phases. researchSkip=true only when a skip needs RECORDING (flag given,
// neither label present).

export type Phase = 'research' | 'plan' | 'implement' | 'validate' | 'feedback'

// phase -> the aven label that marks this phase complete
export const PHASE_LABEL: Record<Phase, string> = {
  research: 'researched',
  plan: 'planned',
  implement: 'active',
  validate: 'review-passed',
  feedback: 'done',
}

export type NextPhase =
  | { kind: 'phase'; phase: Phase; researchSkip?: boolean }
  | { kind: 'done' }

const PHASE_ORDER: readonly Phase[] = [
  'research',
  'plan',
  'implement',
  'validate',
  'feedback',
]

// AIDEV-NOTE: research is satisfied by either durable label or the flag —
// keep in sync with needsResearchSkip in gates.ts (inverted predicate).
export function researchSatisfied(
  labels: readonly string[],
  skipResearch: boolean,
): boolean {
  return (
    labels.includes(PHASE_LABEL.research) ||
    labels.includes('research-skipped') ||
    skipResearch
  )
}

export function nextPhase(
  labels: readonly string[],
  skipResearch: boolean,
): NextPhase {
  if (!researchSatisfied(labels, skipResearch)) {
    return { kind: 'phase', phase: 'research' }
  }
  const first = PHASE_ORDER.slice(1).find(
    (phase) => !labels.includes(PHASE_LABEL[phase]),
  )
  if (first === undefined) return { kind: 'done' }
  const researchSkip =
    skipResearch &&
    !labels.includes(PHASE_LABEL.research) &&
    !labels.includes('research-skipped')
  return {
    kind: 'phase',
    phase: first,
    ...(researchSkip ? { researchSkip } : {}),
  }
}
