// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after /plan
// resolves args/mode/path. BOTH modes delegate planning to the user's
// existing feature-plan-aven skill BY NAME — its logic is never
// reimplemented here (regression-guarded by test). Personal mode keeps only
// the size check + ONESHOT escape inline (PMR-3HMZ); on a 'plan' verdict it
// delegates to the skill exactly like work mode (PMR-T6KF). The plan route
// ends in plan-state=review; flow_phase_complete (and the "planned" label)
// runs only after spec approval (PMR-QRJA) — the skill's resume ladder owns
// all resume states, so there is no tree-refresh or plan-state parsing here.

export interface PlanPromptInput {
  mode: 'work' | 'personal'
  ref: string
}

const APPROVAL_SUFFIX = `
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
  const header = `Plan phase (PIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'work') {
    return `${header}
Invoke the user's existing feature-plan-aven skill (engineering:feature-plan-aven)
for the Jira ticket ${input.ref}. Follow its workflow exactly — pickup,
interview, scout, planner, plan.md, aven phase/subtask hierarchy — unchanged.
${APPROVAL_SUFFIX}`
  }
  return `${header}
Personal aven flow. Steps:

1. Fetch ticket ${input.ref} and any aven notes on it (extra info).
2. Run the size check (classifySize heuristic):
   - single-file / one-module change with one test surface → 'oneshot'
   - anything touching the data model, cross-package, or with multi-step
     test implications → 'plan'
3. Use ask_user_question to present the verdict with its reasons and let the
   human CONFIRM the route. Never proceed past this gate without explicit
   confirmation.
4. If confirmed as oneshot:
   - set the type label "oneshot" on the ticket (no epic),
   - enrich the description with any useful aven-note context,
   - the plan for this ticket IS its description; skip writing a plan file,
   - set the ticket status to "todo",
   - skip spec approval ENTIRELY: do NOT send the ticket into spec review
     (no plan-state metadata, no spec_approve or /spec-review wait). Call
     the flow_phase_complete tool with ref=${input.ref} and phase="plan"
     right away — its result confirms the "planned" label landed — then end
     the phase. Skip step 5.
5. If confirmed as plan:
   Invoke the user's existing feature-plan-aven skill
   (engineering:feature-plan-aven) for the personal aven ticket ${input.ref}.
   Follow its workflow exactly — pickup, interview, scout, planner, plan.md,
   approval, aven phase/subtask hierarchy — unchanged.
   The skill's resume ladder owns ALL resume states (no plan.md yet, draft,
   review, approved, existing children) — do NOT re-check the epic tree or
   parse plan-state here.
   In personal mode the skill's own approval (plan-state=approved, set when
   the user says "approve") is authoritative; the flow_phase_complete gate
   checks only lifecycle-label order — it never reads plan-state — so call
   flow_phase_complete ONLY after the skill's approval has set
   plan-state=approved. /spec-review and the spec_approve tool stay
   compatible with this flow.
${APPROVAL_SUFFIX}`
}
