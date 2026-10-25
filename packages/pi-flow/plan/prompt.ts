// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after /plan
// resolves args/mode/path. Work mode routes to the user's existing
// feature-plan-aven skill BY NAME — its logic is never reimplemented here
// (regression-guarded by test). Personal mode is the size-check flow;
// the decomposition gate lives in plan/split-gate.ts. Existing epics take
// the tree-refresh path (step 2): a ticket that already has children is
// confirmed/ordered, never decomposed again. Epic creation uses real aven
// commands only — `aven edit <ref> --epic on` converts the ticket itself;
// there is no "aven epic create".

export interface PlanPromptInput {
  mode: 'work' | 'personal'
  ref: string
  planPath: string
}

const WORK_SUFFIX = `
When the skill workflow is FULLY complete — including the user's explicit
approval and the aven phase/subtask hierarchy — set the ticket status to
"todo" and call the flow_phase_complete tool with ref=<ticket ref> and
phase="plan" — it applies the "planned" label after re-checking the gates,
and its result confirms the label landed. The "planned" label lands
ONLY after approval: /implement routes oneshot vs plan from the type labels,
and a premature "planned" would misroute the run. Direct aven label edits on
lifecycle labels are blocked. If the user does not
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
2. Existing-tree check: run \`aven epic list ${input.ref}\`. If the ticket
   already HAS children it is an existing epic — never decompose it again:
   - Present the child list (refs, titles, statuses) via ask_user_question
     and confirm the tree is current. Add or remove children first when the
     human asks (aven epic add <child> ${input.ref} /
     aven epic remove <child> ${input.ref}).
   - When execution order matters and is not yet encoded, confirm the order
     with the human and encode it as dependency links:
     aven dep add <blocked-child> <blocker-child>.
   - Write (or refresh) the plan.md to: ${input.planPath} — the tree, the
     execution order, and per-child intent — and record its location:
     aven edit ${input.ref} --metadata plan-path=${input.planPath}
   - call the open_in_pane tool with that path to open it with nvim in a
     herdr review pane for the user to review. Skippable if herdr is
     unavailable or the user declines — never block on it.
   - Skip to step 6.
3. No children yet — run the size check (classifySize heuristic):
   - single-file / one-module change with one test surface → 'oneshot'
   - anything touching the data model, cross-package, or with multi-step
     test implications → 'plan'
4. Use ask_user_question to present the verdict with its reasons and let the
   human CONFIRM the split. Never decompose without explicit confirmation.
5. If confirmed as oneshot:
   - set the type label "oneshot" on the ticket (no epic),
   - enrich the description with any useful aven-note context,
   - the plan for this ticket IS its description; skip writing a plan file.
   If confirmed as plan:
   - make the ticket itself the epic: aven edit ${input.ref} --epic on,
   - create each subtask (aven add "<title>" --status backlog) and link it:
     aven epic add <child-ref> ${input.ref},
   - set the "plan" label on the epic; subtasks inherit via epic membership,
   - write the plan.md to: ${input.planPath}
   - record its location: aven edit ${input.ref} --metadata
     plan-path=${input.planPath}
   - call the open_in_pane tool with that path to open it with nvim in a
     herdr review pane for the user to review. Skippable if herdr is
     unavailable or the user declines — never block on it.
6. Either way: set the ticket status to "todo" and call the flow_phase_complete tool with ref=<ticket ref> and phase="plan" (applies the "planned" label behind the gate).

NEVER convert the ticket to an epic or create subtasks before the explicit
confirm answer. NEVER decompose a ticket that already has children.`
}
