// AIDEV-NOTE: Pure next-phase resolver for /flow. Aven labels ARE the run
// state: the first phase whose completion label is missing is the one to run
// — that single rule gives resume (kill mid-phase -> label absent -> re-run
// the same phase) and no-duplicated-commits (label present -> phase skipped).
// The table below is the ONLY place the phase<->label lifecycle is mapped;
// reconcile with phase-state.ts LIFECYCLE_LABELS before renaming labels.
// Research is special: with --skip-research the missing 'researched' label is
// not a reason to run research — the orchestrator records the skip note and
// moves straight to plan (implement's own gate then accepts the recorded skip).

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

// Commands from `phase` onward, in order — the /flow handoff list.
export function remainingPhases(phase: Phase): readonly Phase[] {
  const idx = PHASE_ORDER.indexOf(phase)
  return PHASE_ORDER.slice(idx)
}

// AIDEV-NOTE: PMR-7HDW — --skip-research is appended to the IMPLEMENT entry
// only. The implement gate (routing.ts) reads labels + the CLI flag, never
// aven notes, so without this propagation /flow <ref> --skip-research halts
// at implement and re-running deadlocks. Other phases must NOT carry the
// flag: their arg parsers treat extra tokens as help.
export function phaseCommands(
  phase: Phase,
  ref: string,
  skipResearch: boolean,
): readonly string[] {
  return remainingPhases(phase).map((p) => {
    if (p === 'implement' && skipResearch) {
      return `/implement ${ref} --skip-research`
    }
    return `/${p} ${ref}`
  })
}

export function nextPhase(
  labels: readonly string[],
  skipResearch: boolean,
): NextPhase {
  const first = PHASE_ORDER.find(
    (phase) => !labels.includes(PHASE_LABEL[phase]),
  )
  if (first === undefined) return { kind: 'done' }
  if (first === 'research') {
    if (skipResearch) {
      return { kind: 'phase', phase: 'plan', researchSkip: true }
    }
    return { kind: 'phase', phase: 'research' }
  }
  return { kind: 'phase', phase: first }
}
