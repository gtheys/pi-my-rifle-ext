// AIDEV-NOTE (PMR-ZGPY 4.1, D3/D10): pure picker helpers over OpenGate[] —
// menu options, per-kind choice vocabularies (with a "show command instead"
// escape), and numbered fallback lines. The picker only ANSWERS gates via
// `/flow answer <ref> <choice>`; resuming paused runs is human-only and
// explicitly NOT this module's job (independent of T6). No IO here; the
// ctx.ui.select dispatch wiring lives in 4.2.

import type { AnswerChoice } from '../aven/client.ts'
import type { OpenGate } from './gates.ts'

const ANSWER_CHOICES: readonly AnswerChoice[] = [
  'approve',
  'reject',
  'pass',
  'fail',
]

function isAnswerChoice(value: string): value is AnswerChoice {
  return (ANSWER_CHOICES as readonly string[]).includes(value)
}

export interface PickerOption {
  label: string
  value: string
}

/** Escape value the caller (4.2) turns into printing the exact command. */
export const COMMAND_ESCAPE_VALUE = '__command__'

const COMMAND_ESCAPE_OPTION: PickerOption = {
  label: 'show command instead',
  value: COMMAND_ESCAPE_VALUE,
}

/** Choice vocabulary per gate kind (D5/D6): answer-gates default to approve/reject. */
function choiceValuesForKind(kind: OpenGate['kind']): string[] {
  if (kind === 'code-review') {
    return ['pass', 'fail']
  }
  // plan-review, flow-paused and answer-gate share the approve/reject
  // answer vocabulary (flow-paused answers close the gate; resuming
  // stays human-only).
  return ['approve', 'reject']
}

/** One select option per gate; label is the gate's single-line title, value the unique ref. */
export function buildGateMenuOptions(
  gates: readonly OpenGate[],
): PickerOption[] {
  const options: PickerOption[] = []
  for (const gate of gates) {
    options.push({ label: gate.title, value: gate.ref })
  }
  return options
}

/** Choice options for the second select (the answer step); escape option last. */
export function gateChoices(gate: OpenGate): PickerOption[] {
  const choices: PickerOption[] = []
  for (const value of choiceValuesForKind(gate.kind)) {
    choices.push({ label: value, value })
  }
  choices.push(COMMAND_ESCAPE_OPTION)
  return choices
}

/** Numbered plain-text fallback: one title line + one answer-with line per gate. */
export function buildGateFallbackLines(gates: readonly OpenGate[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < gates.length; i++) {
    const gate = gates[i]
    lines.push(`${i + 1}. ${gate.title}`)
    const values = choiceValuesForKind(gate.kind).join('|')
    lines.push(`   answer with: /flow answer ${gate.ref} ${values}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// PMR-ZGPY 4.2 (PMR-XQA1): pure dispatch table for the zero-arg /flow picker.
// index.ts stays thin: collect gates → planPickerOutcome → act on the plan.
// ---------------------------------------------------------------------------

/** Which step of the two-select interaction produced this state. */
export type PickerSelection =
  | { stage: 'gate-cancelled' }
  | { stage: 'gate-picked'; gateRef: string }
  | { stage: 'choice-cancelled'; gateRef: string }
  | { stage: 'answered'; gateRef: string; choice: string }

/**
 * The action the /flow handler should take. Pure — tests drive the full
 * matrix without any UI. 'answer' ref/choice feed executeFlowAnswer
 * directly (D10); 'print-command' is the cancel/escape escape hatch that
 * hands the user the exact /flow answer command instead.
 */
export type PickerPlan =
  | { kind: 'fallback'; lines: string[] }
  | { kind: 'empty' }
  | { kind: 'menu'; options: PickerOption[] }
  | { kind: 'choice-menu'; gateRef: string; options: PickerOption[] }
  | { kind: 'answer'; ref: string; choice: AnswerChoice }
  | { kind: 'print-command'; ref: string; choices: string[] }

export function planPickerOutcome(
  hasUI: boolean,
  gates: readonly OpenGate[],
  selection?: PickerSelection,
): PickerPlan {
  if (!hasUI) {
    return { kind: 'fallback', lines: buildGateFallbackLines(gates) }
  }
  if (selection === undefined) {
    if (gates.length === 0) {
      return { kind: 'empty' }
    }
    return { kind: 'menu', options: buildGateMenuOptions(gates) }
  }
  if (selection.stage === 'gate-cancelled') {
    // Cancel at the first select: notify nothing.
    return { kind: 'empty' }
  }
  const gate = gates.find((g) => g.ref === selection.gateRef)
  if (gate === undefined) {
    return { kind: 'empty' }
  }
  if (selection.stage === 'gate-picked') {
    return {
      kind: 'choice-menu',
      gateRef: gate.ref,
      options: gateChoices(gate),
    }
  }
  if (selection.stage === 'choice-cancelled') {
    // Cancel at the second select: print the exact command instead.
    return {
      kind: 'print-command',
      ref: gate.ref,
      choices: choiceValuesForKind(gate.kind),
    }
  }
  if (
    selection.choice === COMMAND_ESCAPE_VALUE ||
    !isAnswerChoice(selection.choice)
  ) {
    return {
      kind: 'print-command',
      ref: gate.ref,
      choices: choiceValuesForKind(gate.kind),
    }
  }
  return { kind: 'answer', ref: gate.ref, choice: selection.choice }
}
