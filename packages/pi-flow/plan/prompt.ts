// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after /plan
// resolves args/mode/path. BOTH modes delegate planning to the user's
// existing feature-plan-aven skill BY NAME — its logic is never
// reimplemented here (regression-guarded by test). Personal mode keeps only
// the size check + ONESHOT escape inline (PMR-3HMZ); on a 'plan' verdict it
// delegates to the skill exactly like work mode (PMR-T6KF). The plan route
// ends in plan-state=review; flow_phase_complete (and the "planned" label)
// runs only after spec approval (PMR-QRJA) — the skill's resume ladder owns
// all resume states, so there is no tree-refresh or plan-state parsing here.
// PMR-C0YV — the prompt must describe the loop's post-label behavior: once
// the "planned" label lands, flow/loop.ts injects the implement prompt
// itself ("advancement is code, not model"), so the session's closing
// message must say the implement phase starts automatically and needs no
// action — never a halt claim or a manual next-phase instruction. The
// unapproved plan route is a graceful pause (loop.ts pauses at plan), not a
// halt.

export interface PlanPromptInput {
  mode: 'work' | 'personal'
  ref: string
}

// AIDEV-NOTE: PMR-R5VB — approval is a HUMAN action (/flow answer <ref>
// approve, human-only; starts no model turn) that writes a durable receipt;
// the agent's spec_approve tool is receipt-gated and refuses without it.
// Raw aven plan-state edits are forbidden in flow context. flow_phase_complete
// instructions and the planned-label consequences are unchanged.
// PMR-C0YV — the suffix also carries the auto-advance/closing-message
// contract below, and the unapproved route says "pauses" (not "halts"),
// matching loop.ts's graceful-pause notify.
const APPROVAL_SUFFIX = `
Approval is recorded by the HUMAN, not the agent: the human runs
"/flow answer <ticket ref> approve" (a human-only slash command — it starts
no model turn and writes the durable approval receipt). Your spec_approve
tool is receipt-gated: it refuses until that receipt exists, so call it only
AFTER the human has answered. Never run raw
"aven edit --metadata plan-state=approved" in flow context.
When the receipt exists and the skill workflow is FULLY complete — including
the aven phase/subtask hierarchy — set the ticket status to
"todo" and call the flow_phase_complete tool with ref=<ticket ref> and
phase="plan" — it applies the "planned" label after re-checking the gates,
and its result confirms the label landed.
When the label lands, the /flow loop advances <ticket ref> into the
implement phase automatically (advancement is code, not model): it
injects the implement prompt into this session. Your closing message must
say the implement phase starts automatically and that no action is needed
— never claim the flow halts or ask the human to start the next phase
manually. The "planned" label lands
ONLY after approval: /implement routes oneshot vs plan from the type labels,
and a premature "planned" would misroute the run. Direct aven label edits on
lifecycle labels are blocked. If the user does not
approve during this phase, leave the ticket at plan-state "review" WITHOUT
the "planned" label and end the phase — the flow pauses at plan and
resumes via /flow once the tree exists.`

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

1. Fetch ticket ${input.ref} and any aven notes on it (extra info) with
   "aven show ${input.ref}" and "aven context ${input.ref} --full" (there is no
   "aven notes" subcommand; "aven note" only appends).
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
     right away — its result confirms the "planned" label landed. In your
     closing message tell the human the /flow loop advances ${input.ref}
     into the implement phase automatically and that no action is needed —
     never claim the flow halts. Skip step 5.
5. If confirmed as plan:
   Invoke the user's existing feature-plan-aven skill
   (engineering:feature-plan-aven) for the personal aven ticket ${input.ref}.
   Follow its workflow exactly — pickup, interview, scout, planner, plan.md,
   approval, aven phase/subtask hierarchy — unchanged.
   The skill's resume ladder owns ALL resume states (no plan.md yet, draft,
   review, approved, existing children) — do NOT re-check the epic tree or
   parse plan-state here.
   Approval is receipt-gated in flow context: when the user says "approve",
   tell them to run "/flow answer ${input.ref} approve" first (human-only;
   writes the durable receipt), then call the spec_approve tool — it refuses
   without the receipt, so re-call it only once the human has answered. Do
   NOT run raw "aven edit --metadata plan-state=approved" in flow context
   (the feature-plan-aven skill's standalone approval outside a flow is
   unchanged). The flow_phase_complete gate checks only lifecycle-label
   order — it never reads plan-state — so call flow_phase_complete only
   after the receipt-gated spec_approve has succeeded.
${APPROVAL_SUFFIX}`
}
