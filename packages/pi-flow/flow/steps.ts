// AIDEV-NOTE: PMR-ZV9Y 1.1 — the registered step names (v2 vocabulary). Steps
// are the named boundaries INSIDE a phase; only these strings may appear in a
// 'step-start'/'step-stop' journal event, a `pi_flow_step` label or a Tempo
// step span (closed enum => bounded cardinality, ISC-A-1/A-2).
//
// `validate.spec-diff` and `validate.aven-notes` are documented names WITHOUT
// machine-emitted boundaries: no tool boundary exists for them (they are
// prose steps in validate/prompt.ts), so flow_submit evidence is all they get.
// Subtask 1.2 binds the prompt letters (D1/D2/D3/H1, the plan approval wait)
// to these names with AIDEV anchors and makes flow_submit warn (advisory,
// never reject) on an unregistered name.
//
// PURE module: only a type-only import of `Phase`, so it stays runtime
// dependency-free and daemon-reachable (the cost-rows closure guard).
import type { Phase } from './orchestrate.ts'

/** phase -> registered step names (empty array = no named steps in a phase). */
export const STEP_REGISTRY: Readonly<Record<Phase, readonly string[]>> = {
  plan: ['plan.spec-approval'],
  implement: [],
  validate: [
    'validate.code-review',
    'validate.deviation',
    'validate.spec-diff',
    'validate.aven-notes',
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
