import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPhasePrompt } from '../flow/phase-prompts.ts'

const BASE = {
  mode: 'personal' as const,
  ref: 'TP-1',
  gitRoot: '/home/x/pi-flow-range',
  workRoots: [] as string[],
  labels: [] as string[],
}

test('brainstorm: defaults to feature flow with the ref as topic', async () => {
  const result = await buildPhasePrompt('brainstorm', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Brainstorm phase/)
  assert.match(result.prompt, /personal/)
  assert.doesNotMatch(result.prompt, /Debug flow/)
})

test('brainstorm: explicit debug override routes the debug flow', async () => {
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    brainstorm: { kind: 'debug', text: 'cart total wrong' },
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Debug flow/)
  assert.match(result.prompt, /cart total wrong/)
})

test('plan: prompt carries the plan.md path from gitRoot', async () => {
  const result = await buildPhasePrompt('plan', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /plan\.md/)
})

test('implement: refuses without the planned label', async () => {
  const result = await buildPhasePrompt('implement', BASE)
  assert.equal(result.kind, 'block')
})

test('implement: planned label only -> send (no research gate, PMR-Z2K7)', async () => {
  const result = await buildPhasePrompt('implement', {
    ...BASE,
    labels: ['planned'],
  })
  assert.equal(result.kind, 'send')
})

test('validate: personal mode sends without scripts dir', async () => {
  const result = await buildPhasePrompt('validate', BASE)
  assert.equal(result.kind, 'send')
})

test('validate: work mode without workRoots blocks loudly', async () => {
  const result = await buildPhasePrompt('validate', {
    ...BASE,
    mode: 'work',
    workRoots: [],
  })
  assert.equal(result.kind, 'block')
  if (result.kind !== 'block') return
  assert.match(result.reason, /workRoots/)
})

test('implement: oneshot route with open epic children forces plan route', async () => {
  const result = await buildPhasePrompt('implement', {
    ...BASE,
    labels: ['planned'],
    epicHasOpenChildren: true,
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /implement-plan-aven/)
  assert.match(result.prompt, /Route: plan/)
})

test('implement: oneshot route without children stays oneshot', async () => {
  const result = await buildPhasePrompt('implement', {
    ...BASE,
    labels: ['planned'],
    epicHasOpenChildren: false,
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Oneshot flow/)
})

test('validate: personal oneshot label names ticket description as spec source', async () => {
  const result = await buildPhasePrompt('validate', {
    ...BASE,
    labels: ['oneshot'],
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const gate = result.prompt.slice(result.prompt.indexOf('Deviation gate'))
  assert.match(gate, /ticket description/)
  assert.doesNotMatch(gate, /plan-path/)
})

test('validate: personal without oneshot label names plan-path as spec source', async () => {
  const result = await buildPhasePrompt('validate', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const gate = result.prompt.slice(result.prompt.indexOf('Deviation gate'))
  assert.match(gate, /plan-path/)
  assert.doesNotMatch(gate, /ticket description/)
})

test('feedback: work mode sends', async () => {
  const result = await buildPhasePrompt('feedback', { ...BASE, mode: 'work' })
  assert.equal(result.kind, 'send')
})

test('feedback: personal mode sends the wrap-up prompt (PMR-81SX)', async () => {
  const result = await buildPhasePrompt('feedback', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  // Matches the outcomeSummary() contract, orders --status done BEFORE
  // flow_phase_complete(phase="feedback"), and forbids re-landing/pushing.
  assert.match(result.prompt, /Mode: personal/)
  assert.match(result.prompt, /Outcome\s+summary/)
  assert.match(result.prompt, /Test evidence/)
  assert.match(result.prompt, /Review verdict/)
  assert.match(result.prompt, /review-feedback/)
  assert.match(
    result.prompt,
    /--status done[\s\S]*flow_phase_complete[\s\S]*phase="feedback"/,
  )
  assert.match(result.prompt, /NOT call the flow_land tool/)
  assert.match(result.prompt, /push stays blocked/)
})

test('validate: personal prompt no longer carries the close-out (moved to feedback, PMR-81SX)', async () => {
  const result = await buildPhasePrompt('validate', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.doesNotMatch(result.prompt, /Outcome\s+summary/)
  assert.doesNotMatch(result.prompt, /phase="feedback"/)
  assert.ok(!result.prompt.includes('status to done'))
})

test('yolo: the prompt input carries the yolo bit (PMR yolo plan 2.1)', async () => {
  // AIDEV-NOTE: yolo rides on PhasePromptInput so phase command builders can
  // observe the mode; the prompt text itself is yolo-agnostic here.
  const result = await buildPhasePrompt('plan', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /plan\.md/)
})

// AIDEV-NOTE: yolo plan 4.1 — byte-pin the non-yolo personal plan prompt so
// the yolo branch can never leak into it.
const NON_YOLO_PERSONAL_PLAN_PROMPT = `Plan phase (PIV flow). Mode: personal. Ref: TP-1.
Personal aven flow. Steps:

1. Fetch ticket TP-1 and any aven notes on it (extra info) with
   "aven show TP-1" and "aven context TP-1 --full" (there is no
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
     the flow_phase_complete tool with ref=TP-1 and phase="plan"
     right away — its result confirms the "planned" label landed. Closing
     message: when this phase runs under the /flow loop, tell the human the
     loop advances TP-1 into the implement phase automatically and
     that no action is needed; when this phase was started by the standalone
     /plan command, no loop is armed — tell the human to run /flow
     TP-1 to start the implement phase — never claim the flow halts.
     Skip step 5.
5. If confirmed as plan:
   Invoke the user's existing feature-plan-aven skill
   (engineering:feature-plan-aven) for the personal aven ticket TP-1.
   Follow its workflow exactly — pickup, interview, scout, planner, plan.md,
   approval, aven phase/subtask hierarchy — unchanged.
   The skill's resume ladder owns ALL resume states (no plan.md yet, draft,
   review, approved, existing children) — do NOT re-check the epic tree or
   parse plan-state here.
   Approval is receipt-gated in flow context: when the user says "approve",
   tell them to run "/flow answer TP-1 approve" first (human-only;
   writes the durable receipt), then call the spec_approve tool — it refuses
   without the receipt, so re-call it only once the human has answered. Do
   NOT run raw "aven edit --metadata plan-state=approved" in flow context
   (the feature-plan-aven skill's standalone approval outside a flow is
   unchanged). The flow_phase_complete gate checks only lifecycle-label
   order — it never reads plan-state — so call flow_phase_complete only
   after the receipt-gated spec_approve has succeeded.

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

test('plan: non-yolo personal prompt is byte-identical to the pre-yolo text (yolo 4.1)', async () => {
  const result = await buildPhasePrompt('plan', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.equal(result.prompt, NON_YOLO_PERSONAL_PLAN_PROMPT)
})

test('yolo plan: prompt auto-applies classifySize and self-approves (yolo 4.1)', async () => {
  const result = await buildPhasePrompt('plan', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const p = result.prompt
  // runs the classifySize heuristic and applies the verdict without asking
  assert.match(p, /classifySize/)
  assert.match(p, /NO ask_user_question/)
  // records verdict + reasons as an aven note
  assert.match(p, /aven note/)
  // oneshot route: label + flow_phase_complete directly, no spec_approve wait
  assert.match(p, /oneshot/)
  // plan route: write plan, spec_approve itself, then flow_phase_complete
  assert.match(p, /spec_approve/)
  assert.match(p, /flow_phase_complete/)
  assert.match(p, /SAME turn/)
})
