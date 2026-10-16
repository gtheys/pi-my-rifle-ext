// AIDEV-NOTE: W76D gates for the implement phase. PURE check functions over a
// ticket's labels — the /implement ticket wires these; shipped here with tests
// only. canImplement refuses tickets without 'planned';
// needsResearchSkip flags the missing-'researched' case, which requires an
// explicit recorded skip before implementing.

export interface GateResult {
  ok: boolean
  reason?: string
}

export function canImplement(labels: readonly string[]): GateResult {
  if (labels.includes('planned')) {
    return { ok: true }
  }
  return {
    ok: false,
    reason: 'ticket has no "planned" label — run /plan first',
  }
}

export function needsResearchSkip(labels: readonly string[]): boolean {
  return !labels.includes('researched')
}
