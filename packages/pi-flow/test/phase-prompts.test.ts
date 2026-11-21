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

// AIDEV-NOTE: yolo 4.2 — byte-pin the non-yolo personal validate prompt so
// the yolo branch can never leak into it.
const NON_YOLO_PERSONAL_VALIDATE_PROMPT = `Validate phase (PIV flow). Mode: personal. Ref: TP-1.
Personal-mode validation: there is no cluster — the human is the test
environment. Do NOT run the work-mode gate (no cluster tools, no devctl, no acli).

1. Locate the ticket's plan/research artifacts for TP-1: run
   \`aven show TP-1 --full\` and look for a \`metadata ... key=research-path\`
   block (set by /brainstorm on confirmed aven tickets). If present, read
   that file for the research findings. If absent, that is NORMAL — most
   tickets are never brainstormed; skip the research-findings section and
   continue (do NOT fail or stop because of it). Extract from the remaining
   artifacts (plan-path metadata): what changed, and the plan's validation
   notes.
2. Compose concrete runnable test instructions from those sections using the
   rules in validate/personal.ts (composeHumanTest): numbered steps the human
   can literally run, plus the expected outcome. If ALL sections are empty,
   STOP and tell the human the artifacts are missing — never invent generic
   filler steps.
3. Present the instructions to the human via ask_user_question with exactly
   two options: "pass" and "fail". WAIT for the answer — do not proceed until
   the human has run the steps and replied.
4. On "pass": record an aven note on TP-1 reading
   "validated by human, <today's date>" and report validation complete (the
   review gate runs next).
5. On "fail": ask the human for a short failure description, record it as an
   aven note on TP-1 (append "reviewed-at: <git rev-parse HEAD>") and
   STOP — the flow loop re-runs implement automatically.

Review gate (part 1: review tool + blockers) — run ONLY after validation has
fully passed:

6a. Pin the diff base ONCE, before the review gate: BASE_SHA is the
   flow base recorded at worktree create — read it with
   \`git config branch.$(git branch --show-current).flowbasesha\` (this is the
   same base the deviation gate resolves, so the two gates agree by
   construction). NEVER resolve against the base's upstream ref: personal
   mode never pushes, so the upstream lags local main and would sweep
   unrelated commits into the review. If flowbasesha is unset (legacy worktree), fall
   back to \`git merge-base HEAD <base>\` where <base> is the recorded flow
   base branch (\`git config branch.$(git branch --show-current).flowbase\`).
   Record the SHA as BASE_SHA, then run \`git log BASE_SHA..HEAD --oneline\`
   and \`git diff --stat BASE_SHA..HEAD\`. Use this BASE_SHA for the review
   (7). The deviation gate resolves its own range (base recorded at worktree
   create) and reports the base SHA: if it differs from BASE_SHA, or the
   range the reviewer describes differs from the recorded one, ASK the human
   — never call it a reviewer or tool error. If <base> cannot be resolved
   unambiguously, STOP and ask the human.
7. Call the review tool on this change (the fresh-context reviewer) with target
   { type: "branch", branch: BASE_SHA } — the tool accepts any ref, and the
   pinned SHA keeps the reviewer range identical to 6a even on a legacy
   worktree without a recorded flow base (a branch-NAME target would
   re-resolve through the base's upstream ref, which lags local main in
   personal mode — PMR-DQ7Z).
   When it returns,
   write the review artifact's verdict as machine-readable lines — exactly
   one line "blockers_count: <N>" (N = number of must-fix blockers, integer,
   0 when clean) plus one "- blocker: <description>" line per blocker:
   blockers_count: 0
   - blocker: <description> (omit this line entirely when N is 0)
7a. Fix round? Check the aven notes on TP-1 (read via "aven context TP-1 --full") for a prior review-blockers
   note carrying "reviewed-at: <sha>" (use the MOST RECENT one). If none, the step 7 full review stands.
   If one exists, run the review as a DELTA instead: call the review tool with custom
   instructions containing (i) the recorded blockers and (ii) the output of
   "git diff <sha>..HEAD". The reviewer must verify each recorded blocker is
   resolved (an unresolved one counts as a blocker) and scan the fix diff for
   new blockers, then emit the same blockers_count verdict as above. If the
   sha is missing or unresolvable, or the diff is empty, run the full review.
8. Read the count. NEVER treat a missing or malformed count as 0 — a
   malformed artifact means call the review tool again, not silent landing.
   On blockers_count > 0: record each blocker as an aven note on TP-1
   (append "reviewed-at: <git rev-parse HEAD>" to the note) and STOP — the
   flow loop re-runs implement automatically (retry budget applies); do not
   run implement yourself. When
   blockers_count is 0, the deviation gate below runs next, THEN the human
   code-review gate at the end of this prompt.

Deviation gate — run ONLY after the review gate returned blockers_count: 0,
and BEFORE the code_review call named in review-gate
   step 9. Steps, in order:

D1. Resolve the spec source. Read the plan: run \`aven show TP-1 --full\` and trust ONLY
   the \`metadata field_id=... key=plan-path\` / value<<EOF heredoc blocks
   (same parsing as spec-review/aven-spec.ts). NEVER use \`aven show --json\`
   for metadata — aven 0.1.39 omits it. Read plan.md from the resolved
   plan-path. If the plan-path metadata is missing or the plan file is
   unreadable: STOP and report to the human — never invent a spec, never
   proceed without one.
D2. Mine the why-inputs: recent aven notes on TP-1 via
   "aven context TP-1 --full" (interview note, worktree note, oneshot outcome,
   escalation notes). Commit messages are resolved by the tool itself.
D3. Run the deviation reviewer: call the deviation_review tool with
   mode="personal", the resolved spec text (D1) and the mined aven notes (D2).
   Do NOT pass a diff or commit messages: the tool resolves the base, diff
   and commits itself in the flow worktree and reports the base SHA and
   range in its result. Compare that base SHA to BASE_SHA (6a); if it
   differs, or the tool errors on a missing base / empty range, STOP and ask
   the human. Await its result.
D4. Read the tool result. The tool already parses the artifact STRICTLY
   (deviations_count contract). An ERROR tool result (spawn failure or
   malformed artifact) means re-run deviation_review — NEVER treat it as 0
   deviations, never silent landing. On ok, continue with the returned
deviations_count.
D5. Route on the returned deviations_count:
   - 0 deviations: record an aven note on TP-1 reading
     "no deviation from spec", then continue to the human code-review gate
     (review-gate step 9: the code_review tool with ref=TP-1).
   - more than 0: present the full deviation report to the human via
     ask_user_question with exactly two options: "accept" and "fix". WAIT
     for the answer. Record the human decision as an aven note on TP-1
     either way. On "accept": proceed to the human code-review gate
     (review-gate step 9). On "fix": record the deviation
     report as an aven note on TP-1 (append "reviewed-at: <git rev-parse
     HEAD>") and STOP — do not land. The flow loop re-runs implement
     automatically and points the agent at that note.

Human code-review gate — run ONLY after the deviation gate returned
0 deviations (or the human accepted the deviations):

9. Call the code_review tool with ref=TP-1 — it opens tuicr on the flow
   worktree and waits for the human's pass/fail.
   On pass: call the flow_phase_complete tool with ref=TP-1 and
   phase="validate" — it applies the "review-passed" label after
   re-checking the gates; without it the flow halts at validate. Then call
   the flow_land tool with ref=TP-1 and the route (merge-main). After it
   returns ok, merge the flow branch into main LOCALLY: first run
   \`git worktree list\` — its first entry is the MAIN (non-worktree)
   checkout — then run \`git -C <main repo path> merge --ff-only <branch>\`
   ALONE, nothing appended: flow_land pinned that exact command and a
   compound command (e.g. appending && git log) is refused.
   NEVER push; git push stays blocked for the whole flow. No PR, no Jira
   link step. If the ff-only merge fails, STOP and ask the human — do not
   force, reset or rebase. After the merge succeeds, the flow loop advances
   TP-1 into its personal feedback phase (wrap-up: outcome summary,
   review-feedback tickets, done — PMR-81SX); do not do that close-out here.
10. On fail: the code_review tool already recorded the tuicr findings as an
   aven note on TP-1. Add your own note on TP-1 containing
   "reviewed-at: <git rev-parse HEAD>" and STOP — do not land. The flow loop
   re-runs implement automatically (retry budget applies).`

test('validate: non-yolo personal prompt is byte-identical to the pre-yolo text (yolo 4.2)', async () => {
  const result = await buildPhasePrompt('validate', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.equal(result.prompt, NON_YOLO_PERSONAL_VALIDATE_PROMPT)
})

test('yolo validate: agent runs tests itself, no human gates (yolo 4.2)', async () => {
  const result = await buildPhasePrompt('validate', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const p = result.prompt
  assert.match(p, /run_tests/)
  assert.doesNotMatch(p, /ask_user_question/)
  assert.doesNotMatch(p, /code_review/)
  assert.doesNotMatch(p, /tuicr/)
  assert.doesNotMatch(p, /merge --ff-only/)
  // spec-source resolution still works in yolo (plan-path for planned runs)
  const gate = p.slice(p.indexOf('Deviation gate'))
  assert.match(gate, /plan-path/)
})

test('yolo validate: deviations always fix, lands via flow_land route=pr (yolo 4.2)', async () => {
  const result = await buildPhasePrompt('validate', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const p = result.prompt
  assert.match(p, /never auto-accept/)
  assert.match(p, /flow_phase_complete/)
  assert.match(p, /flow_land/)
  assert.match(p, /route=pr/)
  // landing happens in the feedback phase, not in validate (double-authorize guard)
  assert.match(p, /feedback lands via/)
  assert.match(p, /Do NOT land here/)
  // fail paths keep the loop's reviewed-at marker contract
  assert.match(p, /reviewed-at/)
})

test('yolo validate: oneshot label names ticket description as spec source (yolo 4.2)', async () => {
  const result = await buildPhasePrompt('validate', {
    ...BASE,
    yolo: true,
    labels: ['oneshot'],
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const gate = result.prompt.slice(result.prompt.indexOf('Deviation gate'))
  assert.match(gate, /ticket description/)
  assert.doesNotMatch(gate, /plan-path/)
})

// AIDEV-NOTE: yolo 4.3 — byte-pin the non-yolo personal feedback prompt so
// the yolo branch can never leak into it.
const NON_YOLO_PERSONAL_FEEDBACK_PROMPT =
  'Feedback phase (PIV flow). Mode: personal. Ref: TP-1.\nClose out the personal-mode flow on TP-1. The validate phase\'s\nhuman code-review gate has already merged the flow branch into main with a\nlocal ff-only merge. The flow is STILL loop-active: push stays blocked, and\nyou must NOT call the flow_land tool again — its landing state is already\nconsumed. Execute IN ORDER:\n\n1. Verify the merge actually landed: run\n   `git -C <main repo> merge-base --is-ancestor <flow branch> main`\n   (main repo = first entry of `git worktree list`). If it fails (exit\n   code non-zero), write an aven note on TP-1 containing\n   "reviewed-at: <git rev-parse HEAD>" plus a one-line description of the\n   missing merge, and STOP and ask the human — do not merge yourself, do\n   not force anything, do not continue to the next steps.\n2. Write the outcome summary as an aven note on TP-1, following this\n   contract exactly: a "## Outcome summary" heading with "### What\n   shipped", "### Test evidence" and "### Review verdict" sections\n   (whatShipped / testEvidence / reviewVerdict). Gather the content from\n   this run\'s notes, commits, and test output. If any section has no\n   content, write an aven note on TP-1 containing\n   "reviewed-at: <git rev-parse HEAD>" instead and STOP and ask the human —\n   never invent filler. The outcome-summary note MUST exist before TP-1\n   can be set to done (canClose contract) — never skip it.\n3. Review-feedback triage: collect every non-blocking review observation\n   (P2/P3, "for later", "non-blocking", "worth knowing") recorded in the\n   review notes and artifacts on TP-1 during this flow, and file each\n   actionable one as its OWN backlog ticket: aven add "<sentence-case\n   title>" --label review-feedback --status backlog --priority\n   <medium|low> --description "..." (create the label first with\n   `aven label create` if missing). Each description carries the finding,\n   the source note/artifact id, file references, and a done-when; skip\n   purely informational/self-healing notes and anything an open ticket\n   already covers; mention siblings ("related to PMR-XXXX") when one\n   exists. If there are no non-blocking observations, skip silently.\n4. Wrap up IN ORDER: first set TP-1 to done with\n   `aven edit TP-1 --status done`, THEN call the flow_phase_complete\n   tool with ref=TP-1 and phase="feedback" — it applies the "done" label\n   after re-checking the gates, and its result confirms the label landed.\n   The aven edit is the verified last step; do not run them in the other\n   order.\n5. Idempotency: if TP-1 is already status done, or a step above was\n   already recorded (outcome-summary note exists, review-feedback tickets\n   already filed), treat that step as success and move on — never fail the\n   close-out because a step already ran. This flow may be a oneshot with no\n   plan artifact: do not assume or look for a plan.md; the ticket\n   description is the spec.\n6. After flow_phase_complete returns ok, report the outcome counts (what\n   shipped, review verdict, review-feedback ticket refs) in your reply.\n   The harness removes the flow worktree automatically — no manual\n   `git worktree remove` is needed.'

test('feedback: non-yolo personal prompt is byte-identical to the pre-yolo text (yolo 4.3)', async () => {
  const result = await buildPhasePrompt('feedback', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.equal(result.prompt, NON_YOLO_PERSONAL_FEEDBACK_PROMPT)
})

test('yolo feedback: lands via flow_land route=pr then push, PR, verify, note, complete (yolo 4.3)', async () => {
  const result = await buildPhasePrompt('feedback', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const p = result.prompt
  // landing sequence, in order: land gate -> push -> pr create -> verify -> note -> complete
  const iLand = p.indexOf('flow_land')
  const iRoute = p.indexOf('route=pr')
  const iPush = p.indexOf('git push -u origin')
  const iCreate = p.indexOf('gh pr create', iPush)
  const iView = p.indexOf('gh pr view --json url')
  const iNote = p.indexOf('aven note', iView)
  const iDone = p.indexOf('--status done')
  const iComplete = p.indexOf('flow_phase_complete')
  const orderProbes: [string, number][] = [
    ['flow_land', iLand],
    ['route=pr', iRoute],
    ['push', iPush],
    ['gh pr create', iCreate],
    ['gh pr view --json url', iView],
    ['note', iNote],
    ['done', iDone],
    ['complete', iComplete],
  ]
  for (const [name, i] of orderProbes) {
    assert.ok(i >= 0, `missing ${name} in yolo feedback prompt`)
  }
  assert.ok(
    iLand < iRoute &&
      iRoute < iPush &&
      iPush < iCreate &&
      iCreate < iView &&
      iView < iNote,
    'landing sequence must be in order',
  )
  assert.ok(iDone < iComplete, 'done edit must precede flow_phase_complete')
  assert.match(p, /phase="feedback"/)
  // PR body conventions: ticket context + what changed + test evidence
  assert.match(p, /ticket context/)
  assert.match(p, /what changed/)
  assert.match(p, /test evidence/)
  // no merge-verification step, no push-blocked language
  assert.doesNotMatch(p, /merge-base --is-ancestor/)
  assert.doesNotMatch(p, /ff-only/)
  assert.doesNotMatch(p, /NOT call the flow_land tool/)
  assert.doesNotMatch(p, /push stays blocked/)
  // the PR is the end state: no merge of the PR
  assert.doesNotMatch(p, /gh pr merge/)
})

test('yolo feedback: keeps wrap-up steps (outcome summary, review-feedback) (yolo 4.3)', async () => {
  const result = await buildPhasePrompt('feedback', { ...BASE, yolo: true })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  const p = result.prompt
  assert.match(p, /Outcome summary/)
  assert.match(p, /Test evidence/)
  assert.match(p, /review-feedback/)
  assert.match(p, /Idempoten/)
})
