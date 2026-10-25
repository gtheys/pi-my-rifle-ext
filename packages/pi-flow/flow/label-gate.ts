// AIDEV-NOTE: PMR-EZHA — pure decision module at the enforcement boundary of
// the flow_phase_complete tool. checkPhaseCompletion re-states the phase
// ordering (research -> plan -> implement -> validate -> feedback) over the
// ticket's current labels; the implement case DELEGATES to the original gates
// (canImplement / needsResearchSkip in gates.ts) so their reasons stay the
// single source of refusal text. lifecycleLabelMutation is the matcher the
// bash tool_call interceptor uses to block direct `aven` writes of lifecycle
// labels. Both functions are pure — the tool in index.ts wraps them.
import { canImplement, type GateResult, needsResearchSkip } from '../gates.ts'
import { LIFECYCLE_LABELS } from '../phase-state.ts'
import { PHASE_LABEL, type Phase, researchSatisfied } from './orchestrate.ts'

const PHASES: readonly Phase[] = [
  'research',
  'plan',
  'implement',
  'validate',
  'feedback',
]

function phaseComplete(phase: Phase, labels: readonly string[]): boolean {
  if (phase === 'research') return researchSatisfied(labels, false)
  return labels.includes(PHASE_LABEL[phase])
}

// The gate flow_phase_complete consults before writing PHASE_LABEL[phase].
// Idempotent: an already-complete phase returns ok and the tool reports
// "already recorded" instead of re-writing.
export function checkPhaseCompletion(
  phase: Phase,
  labels: readonly string[],
): GateResult {
  if (phaseComplete(phase, labels)) return { ok: true }
  if (phase === 'implement') {
    const planned = canImplement(labels)
    if (!planned.ok) return planned
    if (needsResearchSkip(labels)) {
      return {
        ok: false,
        reason:
          'ticket has no "researched" label and no recorded research skip — run /research or pass --skip-research first',
      }
    }
    return { ok: true }
  }
  const missing = PHASES.slice(0, PHASES.indexOf(phase)).find(
    (p) => !phaseComplete(p, labels),
  )
  if (missing === undefined) return { ok: true }
  return {
    ok: false,
    reason: `phase "${missing}" is not complete — "${PHASE_LABEL[missing]}" label missing on the ticket; run the phases in order`,
  }
}

// Matches bash commands that directly mutate a lifecycle label (aven edit
// --label X, aven label add/remove X). Returns the offending label so the
// interceptor can name it in the block reason; null when the command is
// allowed. Type/skip labels (bug, oneshot, plan, research-skipped) stay
// agent-writable — only LIFECYCLE_LABELS are gated.
export function lifecycleLabelMutation(command: string): string | null {
  if (!command.includes('aven')) return null
  const lifecycle = new Set<string>(LIFECYCLE_LABELS)
  const flag = command.match(/--(?:remove-)?label[= ]["']?([\w-]+)/)
  if (flag !== null && lifecycle.has(flag[1])) return flag[1]
  if (/\blabel\s+(add|remove|set|rm|delete)\b/.test(command)) {
    for (const token of command.split(/[\s,'"|;&]+/)) {
      if (lifecycle.has(token)) return token
    }
  }
  return null
}
