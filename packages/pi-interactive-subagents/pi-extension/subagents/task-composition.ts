// AIDEV-NOTE: Pure task-composition module. Split into a stable layer (the
// wrapper/role strings: identity, flag, modeHint, summaryInstruction —
// deterministic given the same role inputs, safe to cache/prefix-stabilize
// across spawns) and a dynamic layer (the task body, which differs per
// spawn). No fs/process/env access by design so it stays unit-testable and
// side-effect free. Extracted from subagents/index.ts spawn logic (PMR-ECJK
// removed the originals). The wrapper strings below are load-bearing: the
// byte-exactness invariant is enforced by the top-level asserts in
// test/task-composition.test.ts.

export type SystemPromptMode = 'append' | 'replace'

export interface ComposeChildTaskInput {
  task: string
  identity: string | null
  systemPromptMode: 'append' | 'replace' | undefined
  autoExit: boolean
  inheritsConversationContext: boolean
}

export interface ComposeChildTaskResult {
  systemPromptIdentity: string | null
  systemPromptFlag: '--system-prompt' | '--append-system-prompt' | null
  taskMessage: string
}

// Historical: copied byte-for-byte from subagents/index.ts (~2502–2507),
// since removed (PMR-ECJK). The byte-exact values are pinned by the
// top-level asserts in test/task-composition.test.ts — change them together.
export const AUTO_EXIT_HINT = 'Complete your task autonomously.'
export const DEFAULT_HINT =
  'Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.'
export const AUTO_EXIT_SUMMARY_INSTRUCTION =
  'Your FINAL assistant message should summarize what you accomplished.'
export const DEFAULT_SUMMARY_INSTRUCTION =
  'Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.'

function isExplicitMode(
  mode: 'append' | 'replace' | undefined,
): mode is SystemPromptMode {
  return mode === 'append' || mode === 'replace'
}

function flagForMode(
  mode: SystemPromptMode,
): '--system-prompt' | '--append-system-prompt' {
  if (mode === 'replace') {
    return '--system-prompt'
  }
  return '--append-system-prompt'
}

function modeHintFor(autoExit: boolean): string {
  if (autoExit) {
    return AUTO_EXIT_HINT
  }
  return DEFAULT_HINT
}

function summaryInstructionFor(autoExit: boolean): string {
  if (autoExit) {
    return AUTO_EXIT_SUMMARY_INSTRUCTION
  }
  return DEFAULT_SUMMARY_INSTRUCTION
}

export function composeChildTask(
  input: ComposeChildTaskInput,
): ComposeChildTaskResult {
  const { task, systemPromptMode, autoExit, inheritsConversationContext } =
    input

  // AIDEV-NOTE: PMR-W2EP — normalize '' to null up front, matching the old
  // consumer truthiness in index.ts: an empty identity must not produce a
  // system-prompt flag (a `!== null` consumer would otherwise write an empty
  // sysprompt file).
  const identity = input.identity === '' ? null : input.identity

  const explicitMode = isExplicitMode(systemPromptMode)

  // Identity flag routing.
  let systemPromptFlag: ComposeChildTaskResult['systemPromptFlag'] = null
  if (identity === null) {
    systemPromptFlag = null
  } else if (explicitMode) {
    systemPromptFlag = flagForMode(systemPromptMode)
  } else if (inheritsConversationContext) {
    // Fork with no explicit mode keeps existing semantics: identity is dropped.
    systemPromptFlag = null
  } else {
    // Non-fork with no/invalid mode: append is the new default.
    systemPromptFlag = '--append-system-prompt'
  }

  let systemPromptIdentity: string | null = null
  if (systemPromptFlag !== null) {
    systemPromptIdentity = identity
  }

  const modeHint = modeHintFor(autoExit)
  const summaryInstruction = summaryInstructionFor(autoExit)

  let taskMessage: string
  if (inheritsConversationContext) {
    // Fork: bare task; identity (if any) is delivered only via an explicit
    // mode flag above.
    taskMessage = task
  } else {
    taskMessage = `${modeHint}\n\n${task}\n\n${summaryInstruction}`
  }

  return { systemPromptIdentity, systemPromptFlag, taskMessage }
}
