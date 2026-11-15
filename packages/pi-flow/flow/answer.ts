// AIDEV-NOTE: PMR-R5VB — `/flow answer <ref> <choice>` parser + orchestration.
// HUMAN-ONLY GUARANTEE: this module must NEVER trigger a model turn. It has
// no pi import, no model-turn API of any kind, and no ctx parameter — the
// injected AnswerDeps object is the only side-effect surface, so the agent structurally
// cannot invoke this path on its own behalf (subtask 1.4 wires the /flow
// handler dispatch on the leading `answer` token BEFORE parseFlowArgs).

import type { AnswerChoice, AnswerGate } from '../aven/client.ts'
import { parseRefKind } from './ref-kind.ts'

export type FlowAnswerArgs =
  | { kind: 'not-answer' }
  | { kind: 'answer-help' }
  | { kind: 'answer'; ref: string; choice: AnswerChoice }

export const answerUsageText =
  'Usage: /flow answer <aven-ref> <choice>\n' +
  'Records a protected human decision on the aven ticket.\n' +
  'Choices — spec gate: approve | reject; review gate: pass | fail\n' +
  'Example: /flow answer PMR-ZTVG approve'

const CHOICE_GATE: Record<AnswerChoice, AnswerGate> = {
  approve: 'spec',
  reject: 'spec',
  pass: 'review',
  fail: 'review',
}

const GATE_JOURNAL: Record<AnswerGate, 'spec-review' | 'code-review'> = {
  spec: 'spec-review',
  review: 'code-review',
}

export function parseFlowAnswerArgs(raw: string): FlowAnswerArgs {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts[0] !== 'answer') return { kind: 'not-answer' }
  if (parts.length !== 3) return { kind: 'answer-help' }
  const refPart = parts[1] ?? ''
  const choice = parts[2] ?? ''
  const parsed = parseRefKind(refPart)
  if (parsed.kind === 'jira') return { kind: 'answer-help' }
  if (
    choice !== 'approve' &&
    choice !== 'reject' &&
    choice !== 'pass' &&
    choice !== 'fail'
  ) {
    return { kind: 'answer-help' }
  }
  return { kind: 'answer', ref: parsed.ref, choice }
}

export interface AnswerDeps {
  notify(message: string, level: 'info' | 'warning' | 'error'): void
  /** Guarded aven metadata write; false = failed (metadata is authoritative). */
  writeGateAnswer(
    ref: string,
    gate: AnswerGate,
    choice: AnswerChoice,
  ): Promise<boolean>
  /** Aven note write; false = failed (audit only — the answer still stands). */
  writeAvenNote(ref: string, text: string): Promise<boolean>
  /** Best-effort local journal append; may throw, callers swallow. */
  appendJournal(event: FlowRunEventSubset): Promise<void>
  now(): string
}

// AIDEV-NOTE: structural subset of run-state.ts's FlowRunEvent 'gate-answer'
// member — avoids importing run-state (and its transitive graph) into this
// model-turn-free module. run-state's own member narrows this shape.
type FlowRunEventSubset = {
  kind: 'gate-answer'
  at: string
  ref: string
  gate: 'spec-review' | 'code-review'
  choice: AnswerChoice
}

export async function executeFlowAnswer(
  args: { ref: string; choice: AnswerChoice },
  deps: AnswerDeps,
): Promise<void> {
  const { ref, choice } = args
  const gate = CHOICE_GATE[choice]

  // 1. Metadata write — authoritative. On failure nothing else is attempted.
  const metadataOk = await deps.writeGateAnswer(ref, gate, choice)
  if (!metadataOk) {
    deps.notify(
      `flow answer NOT recorded: ${ref} ${choice} — aven write failed; fix and re-run /flow answer ${ref} ${choice}`,
      'error',
    )
    return
  }

  // 2. Audit note (marker-note precedent: hasBlockersNoteSince, aven/client.ts).
  const noteOk = await deps.writeAvenNote(
    ref,
    `flow-answer: ${gate}=${choice}\nanswered-at: ${deps.now()}\nanswered-by: human (/flow answer)`,
  )
  if (!noteOk) {
    deps.notify(
      `flow answer note failed for ${ref} — metadata answer still stands`,
      'warning',
    )
  }

  // 3. Local journal projection — best effort.
  try {
    await deps.appendJournal({
      kind: 'gate-answer',
      at: deps.now(),
      ref,
      gate: GATE_JOURNAL[gate],
      choice,
    })
  } catch {
    // Swallowed: journal is a projection, the aven metadata is authoritative.
  }

  deps.notify(
    `flow answer: ${ref} ${gate}=${choice} recorded (aven metadata + note + journal)`,
    'info',
  )
}
