// AIDEV-NOTE: PMR-EZHA — pure decision module at the enforcement boundary of
// the flow_phase_complete tool. checkPhaseCompletion re-states the phase
// ordering (plan -> implement -> validate -> feedback; PMR-Z2K7 dropped the
// research stage) over the ticket's current labels; the implement case
// DELEGATES to the original gate (canImplement in gates.ts) so its reason
// stays the single source of refusal text. lifecycleLabelMutation is the
// matcher the bash tool_call interceptor uses to block direct `aven` writes
// of lifecycle labels. Both functions are pure — the tool in index.ts wraps
// them.
import { canImplement, type GateResult } from '../gates.ts'
import { LIFECYCLE_LABELS } from '../phase-state.ts'
import { PHASE_LABEL, type Phase } from './orchestrate.ts'

const PHASES: readonly Phase[] = ['plan', 'implement', 'validate', 'feedback']

function phaseComplete(phase: Phase, labels: readonly string[]): boolean {
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
    return canImplement(labels)
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
// allowed. Type labels (bug, oneshot, plan) stay agent-writable — only
// LIFECYCLE_LABELS are gated.
//
// AIDEV-NOTE: PMR-5RFR — the flag match only fires under `aven edit` (the
// mutating subcommand); read-only commands like `aven search --label done`
// must pass. The separator is (?:=|\s+) so `--label  done` (extra
// whitespace) cannot evade.
export function lifecycleLabelMutation(command: string): string | null {
  if (!command.includes('aven')) return null
  const lifecycle = new Set<string>(LIFECYCLE_LABELS)
  if (/\baven\s+edit\b/.test(command)) {
    const flag = command.match(/--(?:remove-)?label(?:=|\s+)["']?([\w-]+)/)
    if (flag !== null && lifecycle.has(flag[1])) return flag[1]
  }
  if (/\blabel\s+(add|remove|set|rm|delete)\b/.test(command)) {
    for (const token of command.split(/[\s,'"|;&]+/)) {
      if (lifecycle.has(token)) return token
    }
  }
  return null
}
