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
// halt. Review P1 — the prompt ALSO reaches the standalone /plan command
// (phase-command.ts), which arms no loop: there nothing advances after the
// label lands. The advancement wording therefore covers BOTH delivery paths
// inline (prompt-only: no delivery-path input — the session knows which
// command started it and picks the matching branch).

export interface PlanPromptInput {
  mode: 'work' | 'personal'
  ref: string
  /** /flow --yolo run: gates are skipped and the agent acts autonomously. */
  yolo?: boolean
}

// AIDEV-NOTE: PMR-R5VB — approval is a HUMAN action (/flow answer <ref>
// approve, human-only; starts no model turn) that writes a durable receipt;
// the agent's spec_approve tool is receipt-gated and refuses without it.
// Raw aven plan-state edits are forbidden in flow context. flow_phase_complete
// instructions and the planned-label consequences are unchanged.
// PMR-C0YV — the suffix also carries the auto-advance/closing-message
// contract below, and the unapproved route says "pauses" (not "halts"),
// matching loop.ts's graceful-pause notify. Review P1 — the advancement
// paragraph covers both delivery paths: the /flow loop advances by itself;
// a standalone /plan command arms no loop, so there the human must run
// /flow <ref> to continue.
// AIDEV-NOTE: PMR-ZV9Y 1.2 step registry — the spec-approval wait below is
// the registered plan step, bound 1:1: approval wait = plan.spec-approval
// (flow/steps.ts STEP_REGISTRY.plan). The loop's spec-approval pause journals
// step-start{plan.spec-approval} (flow/loop.ts emitStep in the pause branch),
// and the matching step-stop{plan.spec-approval} is journaled by the LOOP
// RESTART path in flow/loop.ts — at the earliest faithful restart site in
// start(), before the running snapshot, with an idempotent fallback in
// advanceAfter (PMR-ZV9Y 2.1, fix round d4c8111). The /flow answer command
// itself does not journal it; it writes the approval receipt and restarts the
// loop, and that restart emits the stop. So this prompt wait and those events
// name the same step; rename in flow/steps.ts must be reflected here, and the
// start()/advanceAfter emission sites must keep the pairing.
// AIDEV-NOTE: PMR-S7FQ — the route gate in step 3 below is the OTHER
// journalable plan boundary and it binds 1:1 to the evidence-only registry
// name
//   route confirmation = plan.route-confirmed   (flow/steps.ts STEP_REGISTRY.plan)
// EVIDENCE-ONLY means no machine emits step-start/step-stop for it (unlike
// plan.spec-approval above): flow_submit's step-output row is the whole record.
// Name it in the prompt because flow/step-output.ts:301-308 hints on any
// unregistered label once the phase registry is non-empty — before PMR-S7FQ an
// honest route-gate submission could only ever warn. Rename in flow/steps.ts
// must be reflected here and in docs/pi-flow-observability.md §5.
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
When the label lands: if this phase was started by the /flow loop, the loop
advances <ticket ref> into the implement phase automatically (advancement is
code, not model) — it injects the implement prompt into this session, and
your closing message must say the implement phase starts automatically and
that no action is needed. If instead this phase was started by the
standalone /plan command, no flow loop is armed and nothing advances by
itself — your closing message must tell the human to run /flow <ticket ref>
to continue into the implement phase — never claim the flow halts. The "planned" label lands
ONLY after approval: /implement routes oneshot vs plan from the type labels,
and a premature "planned" would misroute the run. Direct aven label edits on
lifecycle labels are blocked. If the user does not
approve during this phase, leave the ticket at plan-state "review" WITHOUT
the "planned" label and end the phase — the flow pauses at plan and
resumes via /flow once the tree exists.`

export function buildPlanPrompt(input: PlanPromptInput): string {
  const header = `Plan phase (PIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'personal' && input.yolo === true) {
    return yoloPersonalPrompt(input.ref)
  }
  // PMR-C0YV review P1 — the closing-message contract covers both delivery
  // paths: the loop injects implement itself; standalone /plan arms no loop,
  // so there the human must be told to run /flow <ref> instead.
  const oneshotClosing = `right away — its result confirms the "planned" label landed. Closing
     message: when this phase runs under the /flow loop, tell the human the
     loop advances ${input.ref} into the implement phase automatically and
     that no action is needed; when this phase was started by the standalone
     /plan command, no loop is armed — tell the human to run /flow
     ${input.ref} to start the implement phase — never claim the flow halts.
     Skip step 5.`
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
     ${oneshotClosing}
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

// AIDEV-NOTE: yolo plan 4.1 — yolo variant of the personal plan prompt. The
// size-check verdict is applied AUTOMATICALLY (no ask_user_question step),
// the verdict + reasons go into an aven note, and on a 'plan' verdict the
// agent writes the plan and calls spec_approve ITSELF (the yolo exemption in
// tools/spec-approve.ts makes it receipt-free) before flow_phase_complete in
// the SAME turn — so the loop pause at plan-state=review (flow/loop.ts) is
// never reached. Oneshot keeps today's flow_phase_complete(plan) behavior.
function yoloPersonalPrompt(ref: string): string {
  return `Plan phase (PIV flow). Mode: personal. Ref: ${ref}. YOLO run: gates are skipped — act autonomously, no human confirmation steps.
Personal aven flow (yolo variant). Steps:

1. Fetch ticket ${ref} and any aven notes on it (extra info) with
   "aven show ${ref}" and "aven context ${ref} --full" (there is no
   "aven notes" subcommand; "aven note" only appends).
2. Run the size check (classifySize heuristic) on the ticket title and
   description:
   - single-file / one-module change with one test surface → 'oneshot'
   - anything touching the data model, cross-package, or with multi-step
     test implications → 'plan'
   Apply the verdict AUTOMATICALLY — NO ask_user_question, NO human
   confirmation. Immediately append an aven note recording the verdict and
   the reasons (or "no signals" for oneshot), e.g.
   "aven note ${ref} "size-check: <verdict> — <reasons>"".
3. If the verdict is oneshot:
   - set the type label "oneshot" on the ticket (no epic),
   - enrich the description with any useful aven-note context,
   - the plan for this ticket IS its description; skip writing a plan file,
   - set the ticket status to "todo",
   - skip spec approval ENTIRELY. Call the flow_phase_complete tool with
     ref=${ref} and phase="plan" right away — its result confirms the
     "planned" label landed. Skip the rest.
4. If the verdict is plan:
   - invoke the user's existing feature-plan-aven skill
     (engineering:feature-plan-aven) for ${ref} and follow its workflow
     (pickup, interview, scout, planner, plan.md, aven phase/subtask
     hierarchy). Where the skill would pause for human plan review, DO NOT
     wait: this is a yolo run — spec approval is self-serve.
   - write the plan, then call the spec_approve tool YOURSELF — in a yolo
     run it is receipt-exempt and succeeds without a human
     "/flow answer" receipt. Do NOT wait for the human to approve.
   - then, in the SAME turn, set the ticket status to "todo" and call the
     flow_phase_complete tool with ref=${ref} and phase="plan" — its
     result confirms the "planned" label landed. Completing all of this in
     one turn means the flow never pauses at plan-state "review".
When the label lands: the /flow loop advances ${ref} into the implement
phase automatically (advancement is code, not model) — it injects the
implement prompt into this session, and your closing message must say the
implement phase starts automatically and that no action is needed. If this
phase was started by the standalone /plan command, no loop is armed — tell
the human to run /flow ${ref} to start the implement phase.
Direct aven label edits on lifecycle labels are blocked.`
}
