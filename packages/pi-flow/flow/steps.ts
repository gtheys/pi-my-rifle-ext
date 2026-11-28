// AIDEV-NOTE: PMR-ZV9Y 1.1 — the registered step names (v2 vocabulary). Steps
// are the named boundaries INSIDE a phase. The registry CLOSES THE PROMETHEUS
// LABEL SURFACE ONLY: flow/state-metrics.ts drops any (phase, step) this map
// does not list before it reaches a `pi_flow_step` / `pi_flow_step_seconds`
// label (closed enum => bounded cardinality, ISC-A-1). The 'step-start'/
// 'step-stop' JOURNAL EVENTS and the Tempo step spans / Loki lines derived
// from them are NOT registry-closed — they keep the raw step name by design,
// so the cardinality bound lives only on the exported metric labels.
//
// `validate.spec-diff` and `validate.aven-notes` are documented names WITHOUT
// machine-emitted boundaries: no tool boundary exists for them (they are
// prose steps in validate/prompt.ts), so flow_submit evidence is all they get.
// Subtask 1.2 binds the prompt letters (D1/D2/D3/H1, the plan approval wait)
// to these names with AIDEV anchors and makes flow_submit warn (advisory,
// never reject) on an unregistered name.
//
// AIDEV-NOTE: PMR-S7FQ — three MORE evidence-only names follow that same shape
// (registered vocabulary, NO machine-emitted step-start/step-stop pair, so
// flow_submit evidence is all they ever get): `plan.route-confirmed` (the
// oneshot-vs-plan route gate in plan/prompt.ts step 3), `validate.review-tool`
// (the fresh-context review tool's blockers_count verdict) and `validate.land`
// (the flow_land authorization + landing command). They exist because
// flow/step-output.ts:301-308 only hints when the phase's registry is NON-empty
// and lists no name for those boundaries, so an honest submission could never
// pick a registered one — noise on every submission is what trains an agent to
// ignore the advisory. Adding a name widens the closed enum by exactly one
// label value (ISC-A-1/A-2: the map stays finite and phase-prefixed, pinned in
// test/flow-submit-evidence-steps.test.ts) and admits nothing to the Prometheus
// surface in practice: scanStepWindows reads only step-start/step-stop, which no
// tool emits for an evidence-only name.
//
// PURE module: only a type-only import of `Phase`, so it stays runtime
// dependency-free and daemon-reachable (the cost-rows closure guard).
import type { Phase } from './orchestrate.ts'

/** phase -> registered step names (empty array = no named steps in a phase). */
export const STEP_REGISTRY: Readonly<Record<Phase, readonly string[]>> = {
  plan: ['plan.spec-approval', 'plan.route-confirmed'],
  // AIDEV-NOTE: PMR-S7FQ — these two arrays are EMPTY ON PURPOSE. Do NOT
  // "fix" them by registering implement/feedback names: flow/step-output.ts
  // :301-308 skips the advisory whenever the phase registry is empty, so
  // free-form step labels in these phases are hint-free BY DESIGN (that is the
  // documented contract test/flow-submit-registry.test.ts pins, and the reason
  // the PMR-S7FR-era implement observations never warned). Registering even one
  // name here flips that guard on and starts nagging every other free-form
  // label — strictly MORE noise, which is the failure mode PMR-S7FQ exists to
  // remove. Boundaries in these phases need no registry entry to journal.
  implement: [],
  validate: [
    'validate.code-review',
    'validate.deviation',
    'validate.spec-diff',
    'validate.aven-notes',
    // PMR-S7FQ evidence-only names (no machine-emitted start/stop pair).
    'validate.review-tool',
    'validate.land',
  ],
  feedback: [],
}

/**
 * Is this step name registered for this phase? Defensive against a drifted
 * phase value (journals are parsed leniently): an unknown phase simply has
 * no registered steps instead of throwing.
 */
export function isRegisteredStep(phase: Phase, step: string): boolean {
  if (!Object.hasOwn(STEP_REGISTRY, phase)) return false
  return STEP_REGISTRY[phase].includes(step)
}
