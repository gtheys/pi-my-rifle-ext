// AIDEV-NOTE (PMR-ZGPY 3.1, D1/D2): pure render helpers for the flow-status
// widget — no IO, no Pi imports. D1 (register-when-content): the widget shows
// iff state, subtasks, or gates exist (shouldShowWidget). D2 (output shape):
// phase lines mirror flow-viewer.mjs renderState (PMR-Z2K7 lifecycle, no
// research row): `[x]`/`[ ]` marks plus ` <- running` on the current phase;
// the `-> /flow answer <ref>` hint is only for answerCommand gates — the
// picker (3.2 wiring) supplies the choices, so we never invent vocabulary
// here. Presentation (✅/emoji/SGR) lives in frame.ts (PMR-X7BH); this module
// stays ASCII by contract. Subtasks use a minimal structural AssignmentSummary mapped from
// pi-interactive-subagents listAssignments by the 3.2 lifecycle caller.

import type { FlowRunState } from '../run-state.ts'
import type { OpenGate } from './gates.ts'

/** Minimal structural slice of a subagents assignment record. */
export interface AssignmentSummary {
  name: string
  status: string
}

export interface StatusInput {
  state: FlowRunState | null
  subtasks: AssignmentSummary[]
  gates: OpenGate[]
}

const PHASES: readonly {
  phase: FlowRunState['completedPhases'][number]
  label: string
}[] = [
  { phase: 'plan', label: 'planned' },
  { phase: 'implement', label: 'active' },
  { phase: 'validate', label: 'review-passed' },
  { phase: 'feedback', label: 'done' },
]

/** D1: widget registers only when there is something to show. */
export function shouldShowWidget(input: StatusInput): boolean {
  if (input.state !== null) return true
  if (input.subtasks.length > 0) return true
  if (input.gates.length > 0) return true
  return false
}

export function renderFlowStatusLines(input: StatusInput): string[] {
  const lines: string[] = []
  if (input.state !== null) {
    lines.push(`flow ${input.state.ref} · ${input.state.mode}`)
    for (const { phase, label } of PHASES) {
      const completed = input.state.completedPhases.includes(phase)
      let mark: string
      if (completed) {
        mark = '[x]'
      } else {
        mark = '[ ]'
      }
      let running: string
      if (input.state.currentPhase === phase) {
        running = ' <- running'
      } else {
        running = ''
      }
      lines.push(`${mark} ${phase.padEnd(11)} (${label})${running}`)
    }
  }
  if (input.subtasks.length > 0) {
    lines.push('subtasks:')
    for (const subtask of input.subtasks) {
      lines.push(`  ${subtask.name} — ${subtask.status}`)
    }
  }
  if (input.gates.length > 0) {
    lines.push('gates:')
    for (const gate of input.gates) {
      if (gate.answerCommand !== undefined) {
        lines.push(`  ${gate.title} → ${gate.answerCommand}`)
      } else {
        lines.push(`  ${gate.title}`)
      }
    }
  }
  return lines
}
