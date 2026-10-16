// AIDEV-NOTE: Work-mode validation gate — a pure, ordered state machine over
// the six mandatory steps (minikube -> connectivity -> queues -> deploy ->
// manual-tests -> jira-comment). Success advances; failure records
// {step, output} for the aven note and FREEZES the gate: no step can advance
// past a recorded failure (the agent must re-run /validate after fixing).
// The phase counts as validated only when every step has completed — the
// Jira evidence comment is the LAST step, so validation can never pass
// without it.

export const GATE_STEPS = [
  'minikube',
  'connectivity',
  'queues',
  'deploy',
  'manual-tests',
  'jira-comment',
] as const

export type GateStep = (typeof GATE_STEPS)[number]

// AIDEV-NOTE: Bounded-poll config for the minikube start loop. Tests pass
// intervalMs: 0 — the agent-side poller never sleeps in tests.
export interface PollConfig {
  maxAttempts: number
  intervalMs: number
}

export interface StepFailure {
  step: GateStep
  output: string
}

export interface GateState {
  step: GateStep
  completed: readonly GateStep[]
  failed: StepFailure | null
}

export const DEFAULT_POLL_CONFIG: PollConfig = {
  maxAttempts: 12,
  intervalMs: 10_000,
}

export function initialGateState(): GateState {
  return { step: 'minikube', completed: [], failed: null }
}

export function gatePassed(state: GateState): boolean {
  return state.completed.length === GATE_STEPS.length && state.failed === null
}

// AIDEV-NOTE: Refusal is the safety property: once failed !== null the state
// is returned unchanged — no success can silently clear a failure.
export function stepSucceeds(state: GateState): GateState {
  if (state.failed !== null) return state
  const idx = GATE_STEPS.indexOf(state.step)
  const completed = [...state.completed, state.step]
  const next = GATE_STEPS[idx + 1]
  if (next === undefined) {
    return { step: state.step, completed, failed: null }
  }
  return { step: next, completed, failed: null }
}

export function stepFails(state: GateState, output: string): GateState {
  if (state.failed !== null) return state
  return {
    step: state.step,
    completed: state.completed,
    failed: { step: state.step, output },
  }
}

// AIDEV-NOTE: Pure bounded-poll predicate — attempt is 1-based "attempts made
// so far". The agent loop is: poll status -> if running, done; else if
// pollExhausted, fail the gate (never hang); else wait intervalMs and retry.
export function pollExhausted(attempts: number, config: PollConfig): boolean {
  return attempts >= config.maxAttempts
}
