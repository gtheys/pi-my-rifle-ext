// AIDEV-NOTE: Pure routing for /implement. The gate wiring lives HERE, not in
// the command handler: canImplement refuses tickets without 'planned' (W76D).
// (PMR-Z2K7: the research skip gate ('skip-required') was removed with the
// research phase.)

import { canImplement } from '../gates.ts'

export type Route = 'oneshot' | 'plan' | 'bug'
export type RefKind = 'jira' | 'aven'

export type RouteResult =
  | { kind: 'ok'; route: Route }
  | { kind: 'refuse'; reason: string }

export function routeFor(
  refKind: RefKind,
  labels: readonly string[],
): RouteResult {
  void refKind
  const gate = canImplement(labels)
  if (!gate.ok) {
    return { kind: 'refuse', reason: gate.reason ?? 'cannot implement' }
  }
  if (labels.includes('bug')) {
    return { kind: 'ok', route: 'bug' }
  }
  if (labels.includes('plan')) {
    return { kind: 'ok', route: 'plan' }
  }
  return { kind: 'ok', route: 'oneshot' }
}
