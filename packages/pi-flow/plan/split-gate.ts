// AIDEV-NOTE: Decomposition gate for the personal /plan flow. buildEpicSplitPlan
// is PURE and is the safety property: it returns an epic-split plan object ONLY
// when `confirmed === true` AND at least one subtask is present. The pi command
// must never instruct the agent to run aven epic create / subtask creation
// unless this returned a plan. Confirmation comes from ask_user_question
// BEFORE decomposition — same gate pattern as research/ticket-gate.ts.

export interface SplitInput {
  confirmed: boolean | undefined
  ref: string
  title: string
  subtasks: readonly string[]
}

export interface EpicSplitPlan {
  ref: string
  title: string
  subtasks: readonly string[]
}

export function buildEpicSplitPlan(input: SplitInput): EpicSplitPlan | null {
  if (input.confirmed !== true) return null
  if (input.subtasks.length === 0) return null
  return {
    ref: input.ref,
    title: input.title,
    subtasks: [...input.subtasks],
  }
}
