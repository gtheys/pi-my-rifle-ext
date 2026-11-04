// AIDEV-NOTE: W76D gate for the implement phase. PURE check function over a
// ticket's labels — the /implement ticket wires these; shipped here with
// tests only. canImplement refuses tickets without 'planned'. (PMR-Z2K7:
// needsResearchSkip and the research-skipped durable label were removed with
// the research phase.)

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
