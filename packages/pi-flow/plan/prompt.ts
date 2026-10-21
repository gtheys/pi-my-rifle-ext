// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after /plan
// resolves args/mode/path. Work mode routes to the user's existing
// feature-plan-aven skill BY NAME — its logic is never reimplemented here
// (regression-guarded by test). Personal mode is the new size-check flow;
// the decomposition gate lives in plan/split-gate.ts.

export interface PlanPromptInput {
  mode: 'work' | 'personal'
  ref: string
  planPath: string
}

const WORK_SUFFIX = `
When the skill workflow is FULLY complete — including the user's explicit
approval and the aven phase/subtask hierarchy — set the ticket status to
"todo" and ensure it carries the "planned" label. The "planned" label lands
ONLY after approval: /implement routes oneshot vs plan from the type labels,
and a premature "planned" would misroute the run. If the user does not
approve during this phase, leave the ticket at plan-state "review" WITHOUT
the "planned" label and end the phase — the flow halts and resumes at plan
via /flow once the tree exists.`

export function buildPlanPrompt(input: PlanPromptInput): string {
  const header = `Plan phase (RPIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'work') {
    return `${header}
Invoke the user's existing feature-plan-aven skill (engineering:feature-plan-aven)
for the Jira ticket ${input.ref}. Follow its workflow exactly — pickup,
interview, scout, planner, plan.md, aven phase/subtask hierarchy — unchanged.
${WORK_SUFFIX}`
  }
  return `${header}
Personal aven flow. Steps:

1. Fetch ticket ${input.ref} and any aven notes on it (extra info).
2. Run the size check (classifySize heuristic):
   - single-file / one-module change with one test surface → 'oneshot'
   - anything touching the data model, cross-package, or with multi-step
     test implications → 'plan'
3. Use ask_user_question to present the verdict with its reasons and let the
   human CONFIRM the split. Never decompose without explicit confirmation.
4. If confirmed as oneshot:
   - set the type label "oneshot" on the ticket (no epic),
   - enrich the description with any useful aven-note context,
   - the plan for this ticket IS its description; skip writing a plan file.
5. If confirmed as plan:
   - aven epic create for the ticket, decompose into subtasks (aven epic add),
   - set the "plan" label on the epic; subtasks inherit via epic membership,
   - write the plan.md to: ${input.planPath}
   - call the open_in_pane tool with that path to open it with nvim in a
     herdr review pane for the user to review. Skippable if herdr is
     unavailable or the user declines — never block on it.
6. Either way: set the ticket status to "todo" and ensure the "planned" label.

NEVER create an epic or subtasks before the explicit confirm answer.`
}
