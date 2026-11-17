// AIDEV-NOTE (PMR-ZGPY 2.1, D4/D5/D6): pure open-gate derivation over run
// projections — the shared data source for the flow-status widget and the
// answer picker. No IO here beyond the GateDeps interface declaration (2.2
// wires real IO); D4: the code-review gate is journal-derived (receipt
// presence), no in-memory state. D6 anti-false-open: a gate is closed when
// EITHER record mechanism says answered — gateDecisions by targetId is
// primary, gateAnswers by gate kind is the fallback (applyEvent keeps only
// the latest answer per gate kind). Paused runs whose ref also has
// plan-state=review are deduped in collectOpenGates (2.2), not here — no
// aven knowledge in this module.

import type { FlowRunState } from '../run-state.ts'

/** One actionable gate the user can open or answer. */
export interface OpenGate {
  ref: string
  kind: 'plan-review' | 'flow-paused' | 'code-review' | 'answer-gate'
  /** Single-line, lead with the ref. */
  title: string
  /** Only for answer-gates; the choice itself is supplied by the picker menu. */
  answerCommand?: string
}

// AIDEV-NOTE: IO seam only — implemented and wired by collectOpenGates in 2.2.
export interface GateDeps {
  /** Refs of plan-state=review tickets (aven list; --all-projects). */
  listPlansAtReview(): Promise<string[]>
  /** Validated FlowRunState projections from the local runs dir. */
  readRuns(): Promise<FlowRunState[]>
}

function hasCodeReviewReceipt(state: FlowRunState): boolean {
  const receipts = state.receipts ?? []
  return receipts.some((r) => r.command === 'code_review')
}

function isAnswered(
  state: FlowRunState,
  targetId: string,
  gate: GateTargetGate,
): boolean {
  const decisions = state.gateDecisions ?? []
  const answers = state.gateAnswers ?? []
  // D6 conservative OR: either record closes the gate.
  return (
    decisions.some((d) => d.targetId === targetId) ||
    answers.some((a) => a.gate === gate)
  )
}

type GateTargetGate = NonNullable<FlowRunState['gateTargets']>[number]['gate']

/** Pure derivation: one or more open gates per run projection, in input order. */
export function deriveRunGates(states: readonly FlowRunState[]): OpenGate[] {
  const gates: OpenGate[] = []
  for (const state of states) {
    if (state.loop?.status === 'paused') {
      gates.push({
        ref: state.ref,
        kind: 'flow-paused',
        title: `${state.ref} — flow run paused`,
      })
    }
    if (state.currentPhase === 'validate' && !hasCodeReviewReceipt(state)) {
      gates.push({
        ref: state.ref,
        kind: 'code-review',
        title: `${state.ref} — validate phase awaiting code review`,
      })
    }
    const targets = state.gateTargets ?? []
    for (const target of targets) {
      if (!isAnswered(state, target.targetId, target.gate)) {
        gates.push({
          ref: state.ref,
          kind: 'answer-gate',
          title: `${state.ref} — ${target.gate} gate awaiting answer`,
          answerCommand: `/flow answer ${state.ref}`,
        })
      }
    }
  }
  return gates
}
