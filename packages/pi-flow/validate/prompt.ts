// AIDEV-NOTE: Work-mode handoff prompt for /validate, sent via
// sendUserMessage (same pattern as implement/prompt.ts). Runs the gate steps
// in validate/gate.ts order via bash, bounded minikube poll, deploy via the
// user's devctl skill BY NAME, manual-test results collected via
// ask_user_question, evidence comment posted via acli. Validation passes ONLY
// after the Jira comment lands. Personal mode (PMR-8449): the human runs the
// test themselves — the agent locates the artifacts, composes instructions via
// validate/personal.ts, asks pass/fail via ask_user_question, then records and
// routes per routePersonalOutcome. Personal mode is never treated as work mode.

import { MODE_PROFILE } from '../mode-profile.ts'
import { DEFAULT_POLL_CONFIG } from './gate.ts'
import { REVIEW_CONTRACT_PROMPT } from './review-gate.ts'

// AIDEV-NOTE: PMR-PKSS — delta re-review on fix rounds. Detection is
// prompt-level (no run-state): a prior blockers aven note carrying
// "reviewed-at: <sha>" marks a fix round. Fail-closed toward MORE review: a
// missing sha or empty diff falls back to a full /review. The verdict
// contract (blockers_count) and every later gate are unchanged, so
// review-passed still only comes from a fresh 0 against the current tree.
function buildDeltaReviewStep(ref: string): string {
  return `7a. Fix round? Check the aven notes on ${ref} for a prior review-blockers
   note carrying "reviewed-at: <sha>" (use the MOST RECENT one). If none, the step 7 full review stands.
   If one exists, run the review as a DELTA instead: /review with custom
   instructions containing (i) the recorded blockers and (ii) the output of
   "git diff <sha>..HEAD". The reviewer must verify each recorded blocker is
   resolved (an unresolved one counts as a blocker) and scan the fix diff for
   new blockers, then emit the same blockers_count verdict as above. If the
   sha is missing or unresolvable, or the diff is empty, run the full review.`
}

// AIDEV-NOTE: Review gate section (PMR-JTAM) — appended to BOTH validate
// prompts. Runs after the env/human gate passes: /review (fresh-context
// reviewer, in-package since PMR-W8SG) -> parse blockers_count artifact ->
// route. The contract wording lives in review-gate.ts; review/verdict.ts
// emits the verdict section natively from those shared constants
// (PMR-5PCB), and this prompt restates it for artifacts written by hand.
// AIDEV-NOTE: PMR-C6AK — the personal branch's step 9 is the HUMAN
// code-review gate: the agent calls the code_review tool (tuicr on the flow
// worktree), and only a human pass unlocks flow_phase_complete -> flow_land
// (push-main) -> push. Ordering: human test gate -> /review blockers ->
// deviation gate -> code_review -> labels/land/push, so review-passed can
// only land after the human pass and the loop cannot advance to feedback
// before the push.
function buildReviewGateSection(
  mode: 'work' | 'personal',
  ref: string,
): string {
  // AIDEV-NOTE: the landing route is data (mode-profile.ts); only the prose
  // below is mode-keyed here.
  const landingRoute = MODE_PROFILE[mode].landingRoute
  if (mode === 'personal') {
    return `
Review gate (part 1: /review + blockers) — run ONLY after validation has
fully passed:

7. Run /review on this change (the fresh-context reviewer). When it returns,
   write the review artifact's verdict as machine-readable lines — exactly
   one line "blockers_count: <N>" (N = number of must-fix blockers, integer,
   0 when clean) plus one "- blocker: <description>" line per blocker:
${REVIEW_CONTRACT_PROMPT}
${buildDeltaReviewStep(ref)}
8. Read the count. NEVER treat a missing or malformed count as 0 — a
   malformed artifact means re-run /review, not silent landing.
   On blockers_count > 0: record each blocker as an aven note on ${ref}
   (append "reviewed-at: <git rev-parse HEAD>" to the note),
   route back to /implement ${ref} (retry budget applies), and STOP. When
   blockers_count is 0, the deviation gate below runs next, THEN the human
   code-review gate at the end of this prompt.`
  }
  let landing: string
  if (mode === 'work') {
    landing = `push the branch and create a PR via
   the gh CLI, then post a Jira comment on
   ${ref} linking the PR URL.`
  } else {
    landing = `push the branch straight to main —
   the standing no-PR rule on own repos. No PR, no Jira link step.`
  }
  return `
Review gate — run ONLY after validation has fully passed:

7. Run /review on this change (the fresh-context reviewer). When it returns,
   write the review artifact's verdict as machine-readable lines — exactly
   one line "blockers_count: <N>" (N = number of must-fix blockers, integer,
   0 when clean) plus one "- blocker: <description>" line per blocker:
${REVIEW_CONTRACT_PROMPT}
${buildDeltaReviewStep(ref)}
8. Read the count. NEVER treat a missing or malformed count as 0 — a
   malformed artifact means re-run /review, not silent landing.
9. If blockers_count is 0: call the flow_phase_complete tool with ref=${ref}
   and phase="validate" — it applies the "review-passed" label after
   re-checking the gates, and its result confirms the label landed; without
   it the flow halts at validate. Then call the flow_land tool with
   ref=${ref} and the route (${landingRoute}) — it authorizes the landing;
   while the flow is active, direct git push / gh pr create are BLOCKED
   until flow_land returns ok. On ok, run the landing step:
   ${landing}
10. If blockers_count > 0: record each blocker as an aven note on ${ref}
   (append "reviewed-at: <git rev-parse HEAD>" to the note),
   route back to /implement ${ref} (retry budget applies), and STOP — do
   not land.`
}

// AIDEV-NOTE: PMR-C6AK — the personal human code-review gate, appended AFTER
// the deviation gate so the textual order matches the execution order:
// human test gate -> /review blockers -> deviation gate -> code_review ->
// labels/land/push. Only a human pass unlocks flow_phase_complete ->
// flow_land (push-main) -> push, so review-passed cannot land before the
// human has seen the final state and the loop cannot reach feedback before
// the push.
function buildPersonalCodeReviewGate(ref: string): string {
  return `
Human code-review gate — run ONLY after the deviation gate returned
0 deviations (or the human accepted the deviations):

9. Call the code_review tool with ref=${ref} — it opens tuicr on the flow
   worktree and waits for the human's pass/fail.
   On pass: call the flow_phase_complete tool with ref=${ref} and
   phase="validate" — it applies the "review-passed" label after
   re-checking the gates; without it the flow halts at validate. Then call
   the flow_land tool with ref=${ref} and the route (push-main) — direct
   git push is BLOCKED until flow_land returns ok. On ok, push the branch
   straight to main — the standing no-PR rule on own repos. No PR, no Jira
   link step.
   After the push succeeds (personal mode has no separate feedback phase —
   PMR-GFM5), close out the ticket IN ORDER:
   a. Write the outcome summary as an aven note on ${ref}: "## Outcome
      summary" with "### What shipped", "### Test evidence" and "### Review
      verdict" sections. If a section has no content, STOP and ask the
      human — never invent filler.
   b. ONLY once that note exists: set ${ref} status to done, then call the
      flow_phase_complete tool with ref=${ref} and phase="feedback" — it
      applies the "done" label after re-checking the gates.
10. On fail: the code_review tool already recorded the tuicr findings as an
   aven note on ${ref}. Route back to /implement ${ref} (retry budget
   applies), and STOP — do not land.`
}

// AIDEV-NOTE: Deviation gate section (PMR-BAGD) — appended to BOTH validate
// prompts, AFTER the review gate section. Ordering contract: it runs once the
// review gate returned blockers_count: 0, and BEFORE the flow_phase_complete
// (phase="validate") / flow_land calls that review-gate step 9 describes —
// the prose below restates that ordering explicitly since the review section
// already names those tools. Spec-source resolution is mode-keyed:
//   - work: spec file via resolve_spec_path + Jira text via acli
//   - personal planned: plan.md read from plan-path metadata (aven show --full
//     heredoc parsing per spec-review/aven-spec.ts — NEVER `aven show --json`,
//     metadata is omitted on aven 0.1.39)
//   - personal oneshot (oneshot=true): the ticket description itself
// Artifact parsing and routing delegate to the contracts the agent runs in
// the deviation_review tool (tools/deviation.ts, which wraps
// review/deviation.ts's startDeviationReview and
// validate/deviation-gate.ts's parseDeviationArtifact).
// Fail-closed everywhere: a missing/malformed spec source or artifact stops
// the flow — never a silent pass.
// AIDEV-NOTE: PMR-C6AK — mode-keyed routing targets. Work: unchanged (D5
// continues into flow_phase_complete -> flow_land). Personal: the deviation
// gate runs BEFORE the human code-review gate, so the 0-deviation and
// "accept" routes continue into review-gate step 9's code_review call, not
// straight to flow_land — the human still sees the final state.
export function buildDeviationGateSection(
  mode: 'work' | 'personal',
  ref: string,
  oneshot = false,
): string {
  let specSource: string
  if (mode === 'work') {
    specSource = `Resolve the spec file path via the resolve_spec_path tool
   (repo from the git remote, slug from the Jira summary) and read that spec
   file. Also fetch the Jira ticket text via acli.`
  } else if (oneshot) {
    specSource = `This is a personal-mode oneshot with no plan: the spec is the
   ticket description itself, read from \`aven show ${ref} --full\`.`
  } else {
    specSource = `Read the plan: run \`aven show ${ref} --full\` and trust ONLY
   the \`metadata field_id=... key=plan-path\` / value<<EOF heredoc blocks
   (same parsing as spec-review/aven-spec.ts). NEVER use \`aven show --json\`
   for metadata — aven 0.1.39 omits it. Read plan.md from the resolved
   plan-path. If the plan-path metadata is missing or the plan file is
   unreadable: STOP and report to the human — never invent a spec, never
   proceed without one.`
  }
  let gateBefore: string
  let continueTarget: string
  let acceptTarget: string
  if (mode === 'work') {
    gateBefore = `and BEFORE the flow_phase_complete(phase="validate") / flow_land calls named
in review-gate step 9`
    continueTarget = `then continue to flow_phase_complete with
     ref=${ref} and phase="validate", then flow_land (review-gate step 9).`
    acceptTarget = `On "accept": proceed to flow_phase_complete with ref=${ref}
     and phase="validate", then flow_land.`
  } else {
    gateBefore = `and BEFORE the code_review call named in review-gate
   step 9`
    continueTarget = `then continue to the human code-review gate
     (review-gate step 9: the code_review tool with ref=${ref}).`
    acceptTarget = `On "accept": proceed to the human code-review gate
     (review-gate step 9).`
  }
  return `
Deviation gate — run ONLY after the review gate returned blockers_count: 0,
${gateBefore}. Steps, in order:

D1. Resolve the spec source. ${specSource}
D2. Mine the why-inputs: commit messages via git log against the flow's base
   (the commit flow started from), and recent aven notes on ${ref} via the
   existing aven client (interview note, worktree note, oneshot outcome,
   escalation notes).
D3. Run the deviation reviewer: call the deviation_review tool with
   mode="${mode}", the resolved spec text (D1), the git diff vs base, and
   the mined commit messages and aven notes (D2). Await its result.
D4. Read the tool result. The tool already parses the artifact STRICTLY
   (deviations_count contract). An ERROR tool result (spawn failure or
   malformed artifact) means re-run deviation_review — NEVER treat it as 0
   deviations, never silent landing. On ok, continue with the returned
deviations_count.
D5. Route on the returned deviations_count:
   - 0 deviations: record an aven note on ${ref} reading
     "no deviation from spec", ${continueTarget}
   - more than 0: present the full deviation report to the human via
     ask_user_question with exactly two options: "accept" and "fix". WAIT
     for the answer. Record the human decision as an aven note on ${ref}
     either way. ${acceptTarget} On "fix": record the deviation
     report as an aven note on ${ref}, route back to /implement ${ref} with
     the deviation report, and STOP — do not land.`
}

export interface ValidatePromptInput {
  mode: 'work' | 'personal'
  ref: string
  scriptsDir: string | null
  // AIDEV-NOTE: personal mode only — a oneshot ticket has no plan.md, so the
  // deviation gate resolves the spec from the ticket description instead.
  oneshot?: boolean
}

export function buildValidatePrompt(input: ValidatePromptInput): string {
  const header = `Validate phase (PIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'personal') {
    let isOneshot: boolean
    if (input.oneshot === true) {
      isOneshot = true
    } else {
      isOneshot = false
    }
    return `${header}
Personal-mode validation: there is no cluster — the human is the test
environment. Do NOT run the work-mode gate (no cluster tools, no devctl, no acli).

1. Locate the ticket's plan/research artifacts for ${input.ref}: run
   \`aven show ${input.ref} --full\` and look for a \`metadata ... key=research-path\`
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
4. On "pass": record an aven note on ${input.ref} reading
   "validated by human, <today's date>" and report validation complete (the
   review gate runs next).
5. On "fail": ask the human for a short failure description, record it as an
   aven note on ${input.ref}, and route back to /implement ${input.ref} — the
   retry budget resets for the new attempt.
${buildReviewGateSection('personal', input.ref)}
${buildDeviationGateSection('personal', input.ref, isOneshot)}
${buildPersonalCodeReviewGate(input.ref)}`
  }
  const scripts = input.scriptsDir
  return `${header}
Run the work-mode validation gate. Execute these steps IN ORDER and do not skip
or reorder any of them. Every step must succeed before the next one starts.

1. Minikube (bounded): run \`minikube status\`. If it is not Running:
   run \`minikube start\`, then poll \`minikube status\` until Running —
   at most ${DEFAULT_POLL_CONFIG.maxAttempts} attempts,
   ${DEFAULT_POLL_CONFIG.intervalMs / 1000}s apart. If it is still not
   Running after the bound, the gate FAILS (never hang the flow).
2. Connectivity: run \`${scripts}/test-services-connectivity.sh\` — must exit 0.
3. SQS queues: run \`${scripts}/add-sqs-queues.sh\` — must exit 0.
4. Deploy: use the user's devctl skill to deploy the affected services
   (from the plan's validation notes) to the local cluster.
5. Manual tests: read the plan's validation notes for the manual checks.
   Collect each check's result from the human via ask_user_question
   (pass/fail + evidence). A single fail fails the gate.
6. Jira evidence comment: via acli, post a comment on ${input.ref} describing
   HOW the change was validated — what was deployed, which tests ran, and the
   evidence from steps 1-5.

Completion rule: the phase passes ONLY after the Jira comment from step 6 has
landed. Track progress against the ordered gate steps
(minikube, connectivity, queues, deploy, manual-tests, jira-comment).

On ANY step failure: STOP. Write the failing step's name and its full failing
output as an aven note on ${input.ref}, and report the failure to the human.
Never continue past a failed step, never mark the phase validated.
${buildReviewGateSection('work', input.ref)}
${buildDeviationGateSection('work', input.ref, false)}`
}
