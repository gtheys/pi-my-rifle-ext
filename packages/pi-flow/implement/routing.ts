// AIDEV-NOTE: Pure routing for /implement. The gate wiring lives HERE, not in
// the command handler: canImplement refuses tickets without 'planned' (W76D);
// needsResearchSkip (no 'researched' label) returns 'skip-required' unless the
// caller passed the explicit --skip-research flag. When the skip is allowed it
// is surfaced as researchSkip: true so the prompt instructs the agent to
// record the skip as an aven note on the task (W76D gate wording).

import { canImplement, needsResearchSkip } from '../gates.ts'

export type Route = 'oneshot' | 'plan' | 'bug'
export type RefKind = 'jira' | 'aven'

export type RouteResult =
  | { kind: 'ok'; route: Route; researchSkip: boolean }
  | { kind: 'skip-required' }
  | { kind: 'refuse'; reason: string }

export function routeFor(
  refKind: RefKind,
  labels: readonly string[],
  skipResearch: boolean,
): RouteResult {
  void refKind
  const gate = canImplement(labels)
  if (!gate.ok) {
    return { kind: 'refuse', reason: gate.reason ?? 'cannot implement' }
  }
  if (needsResearchSkip(labels) && !skipResearch) {
    return { kind: 'skip-required' }
  }
  const researchSkip = needsResearchSkip(labels)
  if (labels.includes('bug')) {
    return { kind: 'ok', route: 'bug', researchSkip }
  }
  if (labels.includes('plan')) {
    return { kind: 'ok', route: 'plan', researchSkip }
  }
  return { kind: 'ok', route: 'oneshot', researchSkip }
}
