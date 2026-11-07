// AIDEV-NOTE: ONE place that decides an agent's "role" — the short, groupable
// label used in trace session-span names ("<ref> - <role>") and in the cost
// dashboards (pi_flow_run_role_info). Source order:
//   1. the agent TYPE (PI_SUBAGENT_AGENT / AssignmentRecord.agent: scout,
//      worker, reviewer, planner...) — stable, chosen by the spawner;
//   2. else the agent NAME before its first colon ("Review: changes against
//      'abc'" -> "review") — names are free text, so this is the fallback;
//   3. else "worker".
// Lowercased and capped so Grafana groups cleanly.
export const ROLE_MAX = 40

function clean(value: string | null | undefined): string {
  if (value === undefined || value === null) return ''
  let out = value.trim().toLowerCase()
  if (out.length > ROLE_MAX) out = out.slice(0, ROLE_MAX).trimEnd()
  return out
}

export function agentRole(
  agentType: string | null | undefined,
  agentName: string | null | undefined,
): string {
  const fromType = clean(agentType)
  if (fromType.length > 0) return fromType
  const fromName = clean((agentName ?? '').split(':')[0])
  if (fromName.length > 0) return fromName
  return 'worker'
}

/** Role of the orchestrator = the main pi session that runs the flow. */
export const ORCHESTRATOR_ROLE = 'orchestrator'
