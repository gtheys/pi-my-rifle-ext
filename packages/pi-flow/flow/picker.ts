// AIDEV-NOTE (PMR-ZGPY 4.1, D3/D10; 2.1 adds the ticket sentinel row and
// the 'tickets' plan kind): pure picker helpers over OpenGate[] —
// menu options, per-kind choice vocabularies (with a "show command instead"
// escape), and numbered fallback lines. The picker only ANSWERS gates via
// `/flow answer <ref> <choice>`; resuming paused runs is human-only and
// explicitly NOT this module's job (independent of T6). No IO here; the
// ctx.ui.select dispatch wiring lives in 4.2.

import type { AnswerChoice, ReadyTicket } from '../aven/client.ts'
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

// AIDEV-NOTE (fix round 2): menu option values are the composite
// `${ref}|${kind}` — deriveRunGates can emit two gates with the SAME ref
// (code-review + answer-gate), and a bare ref value would make the menu
// resolve first-match, presenting row B's vocabulary for row A. Refs cannot
// contain '|' (runFileName charset), so '|' is an unambiguous separator.
const GATE_VALUE_SEPARATOR = '|'

/** Split a composite menu value back into its ref + kind parts. A value
 * without a separator yields an empty kind — ref+kind lookups then simply
 * miss (fail-closed), never first-match another row. */
export function splitGateValue(value: string): { ref: string; kind: string } {
  const idx = value.lastIndexOf(GATE_VALUE_SEPARATOR)
  if (idx === -1) {
    return { ref: value, kind: '' }
  }
  return { ref: value.slice(0, idx), kind: value.slice(idx + 1) }
}

// AIDEV-NOTE (fix round 2, /flow dispatch): the zero-arg /flow picker must not
// swallow other arg shapes — /flow X Y etc. keep parseFlowArgs's usage notify.
// The dispatch condition is this pure predicate so tests drive it directly.
export function isPickerInvocation(args: string): boolean {
  return args.trim().length === 0
}

/** Escape value the caller (4.2) turns into printing the exact command. */
export const COMMAND_ESCAPE_VALUE = '__command__'

const COMMAND_ESCAPE_OPTION: PickerOption = {
  label: 'show command instead',
  value: COMMAND_ESCAPE_VALUE,
}

/** Sentinel value marking the ready-ticket picker row (2.1); the caller
 * (2.2+) turns this selection into the ticket-picker flow. */
export const TICKET_ROW_VALUE = '__tickets__'

export const TICKET_ROW_OPTION: PickerOption = {
  label: 'Start a flow on a ready ticket…',
  value: TICKET_ROW_VALUE,
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

/** One select option per gate; label is the gate's single-line title, value
 * the composite ref|kind (fix round 2 — same-ref rows stay distinct). */
export function buildGateMenuOptions(
  gates: readonly OpenGate[],
): PickerOption[] {
  const options: PickerOption[] = []
  for (const gate of gates) {
    options.push({
      label: gate.title,
      value: `${gate.ref}${GATE_VALUE_SEPARATOR}${gate.kind}`,
    })
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

/** Which step of the two-select interaction produced this state. gateKind
 * threads the composite value's kind half so ref+kind lookups can never
 * resolve a different row sharing the same ref (fix round 2). */
export type PickerSelection =
  | { stage: 'gate-cancelled' }
  | { stage: 'ticket-row-picked' }
  | { stage: 'gate-picked'; gateRef: string; gateKind: string }
  | { stage: 'choice-cancelled'; gateRef: string; gateKind: string }
  | { stage: 'answered'; gateRef: string; gateKind: string; choice: string }

/**
 * The action the /flow handler should take. Pure — tests drive the full
 * matrix without any UI. 'answer' ref/choice feed executeFlowAnswer
 * directly (D10); 'print-command' is the cancel/escape escape hatch that
 * hands the user the exact /flow answer command instead.
 */
export type PickerPlan =
  | { kind: 'fallback'; lines: string[] }
  | { kind: 'empty' }
  | { kind: 'tickets' }
  | { kind: 'menu'; options: PickerOption[] }
  | {
      kind: 'choice-menu'
      gateRef: string
      gateKind: string
      options: PickerOption[]
    }
  | { kind: 'answer'; ref: string; choice: AnswerChoice }
  | { kind: 'print-command'; ref: string; choices: string[] }

export function planPickerOutcome(
  hasUI: boolean,
  gates: readonly OpenGate[],
  selection?: PickerSelection,
): PickerPlan {
  // Zero gates → 'tickets' (PMR-ZGPY 2.1): with no ready gates the bare
  // /flow picker jumps straight to the ready-ticket picker (built in 2.2).
  // Supersedes the fix-round-2 'empty' behavior; a selection can never
  // coexist with zero gates (the menu requires gates to render).
  if (gates.length === 0) {
    return { kind: 'tickets' }
  }
  if (!hasUI) {
    return { kind: 'fallback', lines: buildGateFallbackLines(gates) }
  }
  if (selection === undefined) {
    // Zero gates cannot reach here: the hoisted guard above returns 'tickets'
    // before any selection branch, and a selection can never coexist with
    // zero gates (the menu requires gates to render).
    return {
      kind: 'menu',
      options: [...buildGateMenuOptions(gates), TICKET_ROW_OPTION],
    }
  }
  if (selection.stage === 'ticket-row-picked') {
    // Sentinel row chosen: hand off to the ready-ticket picker (2.2).
    return { kind: 'tickets' }
  }
  if (selection.stage === 'gate-cancelled') {
    // Cancel at the first select: notify nothing.
    return { kind: 'empty' }
  }
  // Ref+kind lookup (fix round 2): the kind half guarantees the vocabulary
  // always matches the exact row the user picked, even across same-ref rows.
  const gate = gates.find(
    (g) => g.ref === selection.gateRef && g.kind === selection.gateKind,
  )
  if (gate === undefined) {
    return { kind: 'empty' }
  }
  if (selection.stage === 'gate-picked') {
    return {
      kind: 'choice-menu',
      gateRef: gate.ref,
      gateKind: gate.kind,
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

// AIDEV-NOTE (PMR-3E1Z 2.2; PMR-W60H / ISC-A-1 picker invariants): pure
// decision table for the ready-ticket picker — the 'run' kind only RETURNS a
// ref for the handler to start the flow with; this module never resumes a
// paused run or emits messages (PMR-W60H / ISC-A-1 picker invariants).

// ---------------------------------------------------------------------------
// PMR-3E1Z 2.2: ready-ticket picker (the 'tickets' handoff from above).

export type TicketSelection =
  | { stage: 'ticket-cancelled' }
  | { stage: 'ticket-picked'; ref: string }

export type TicketPickerPlan =
  | { kind: 'fallback'; lines: string[] }
  | { kind: 'none'; line: string }
  | { kind: 'failed' }
  | { kind: 'menu'; options: PickerOption[] }
  | { kind: 'silent' }
  | { kind: 'run'; ref: string }

/** One select option per ready ticket; value is the ref itself so the
 * handler's Map resolves label→ref without slicing (refs are unique here —
 * unlike gates, tickets have no per-ref kind collision). */
export function buildTicketMenuOptions(
  tickets: readonly ReadyTicket[],
): PickerOption[] {
  const options: PickerOption[] = []
  for (const ticket of tickets) {
    options.push({
      label: `${ticket.ref} — ${ticket.title}`,
      value: ticket.ref,
    })
  }
  return options
}

/** Numbered plain-text fallback mirroring buildGateFallbackLines: one title
 * line + one start-with line per ticket. */
export function buildTicketFallbackLines(
  tickets: readonly ReadyTicket[],
): string[] {
  const lines: string[] = []
  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i]
    lines.push(`${i + 1}. ${ticket.ref} — ${ticket.title}`)
    lines.push(`   start with: /flow ${ticket.ref}`)
  }
  return lines
}

/** Pure decision table for the ready-ticket picker. Null/empty checks come
 * FIRST — a null/empty list has no menu to render regardless of selection
 * state; the handler re-calls with the selection only after a valid menu
 * resolved. Unknown-ref picked → 'silent', mirroring the gate lookup-miss
 * rule above. */
export function planTicketPickerOutcome(
  hasUI: boolean,
  hadGates: boolean,
  tickets: ReadyTicket[] | null,
  selection?: TicketSelection,
): TicketPickerPlan {
  // classifyReadyTickets signals aven failure with null — the handler warns.
  if (tickets === null) {
    return { kind: 'failed' }
  }
  if (tickets.length === 0) {
    // Notify once; the message depends on whether the user came from an
    // empty gate menu or a bare /flow invocation.
    if (hadGates) {
      return { kind: 'none', line: 'No ready tickets.' }
    }
    return { kind: 'none', line: 'No open gates or ready tickets.' }
  }
  if (!hasUI) {
    return { kind: 'fallback', lines: buildTicketFallbackLines(tickets) }
  }
  if (selection === undefined) {
    return { kind: 'menu', options: buildTicketMenuOptions(tickets) }
  }
  if (selection.stage === 'ticket-cancelled') {
    // Cancel at the ticket select: notify nothing.
    return { kind: 'silent' }
  }
  const ticket = tickets.find((t) => t.ref === selection.ref)
  if (ticket === undefined) {
    // Lookup miss (stale list between menu render and pick): stay silent,
    // same fail-closed rule as the gate picker.
    return { kind: 'silent' }
  }
  return { kind: 'run', ref: ticket.ref }
}
