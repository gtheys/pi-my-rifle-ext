// AIDEV-NOTE: Feedback-phase handoff prompts (PMR-XDRB phase 5), sent via
// sendUserMessage (same pattern as validate/prompt.ts). Work mode runs
// the sonarqube and pr_quality TOOLS (PMR-69V8: agents cannot invoke slash
// commands).
// The triage rules mirror classify() in feedback/triage.ts; the escalation
// rule (new work = new task through the gates) is stated as an absolute in
// the prompt so the agent can never fix silently or ignore a finding.
// Personal mode DOES have a feedback phase (PMR-81SX): it runs after
// validate's human code-review gate already ff-only merged the flow branch
// into main and consumed the landing state. The prompt verifies the merge
// landed (PMR-69V8 fail-closed), writes the outcome summary via the
// outcomeSummary() contract (feedback/triage.ts), files review-feedback
// backlog tickets, then transitions done and completes the phase. flow_land
// must never be called here — the landing is already done and pushes stay
// blocked for the whole flow.

import { classify, FIX_NOW_SEVERITIES } from './triage.ts'

export interface FeedbackPromptInput {
  /** 'work' gates a PR; 'personal' closes out an already-merged local flow (PMR-81SX). */
  mode: 'work' | 'personal'
  ref: string
  // AIDEV-NOTE: /flow --yolo run: gates are skipped and the agent acts
  // autonomously. Personal-only — the work-mode prompt ignores this bit.
  yolo?: boolean
}

const MECHANICAL = [...FIX_NOW_SEVERITIES].join(', ')

function workSection(ref: string): string {
  return `Run the feedback work gate on ${ref}'s PR. Execute IN ORDER:

1. Call the sonarqube tool on the PR and read its report.
2. For EACH unresolved finding, triage it with these rules:
   - Mechanical findings (severity ${MECHANICAL}) that do NOT touch
     behavior, architecture, data, migrations, schema, or API contracts are
     fixed immediately.
   - Anything touching behavior/architecture/data — regardless of severity —
     and every major/critical/blocker, and every finding whose severity you
     cannot determine, becomes a NEW Jira/aven task (plan it via the
     normal flow phases). NEVER fix such a
     finding silently inside feedback. NEVER ignore a finding: every finding
     ends as either a fix commit or a new task. Nothing is left unresolved.
   - Non-blocking review observations (P2/P3, "for later", "non-blocking",
     "worth knowing") each become their OWN backlog ticket labeled
     review-feedback (aven add "<sentence-case title>" --label
     review-feedback --status backlog --priority <medium|low>; create the
     label first with aven label create if missing), carrying the finding,
     the source artifact, file references, and a done-when. Skip purely
     informational/self-healing notes and anything an open ticket already
     covers; mention siblings ("related to PMR-XXXX") when one exists.
     Skip silently when there are none.
3. Fix-now findings: use the pr_quality tool for review-thread context, fix, and COMMIT each fix.
4. Address all unresolved GitHub review comments on the PR (same triage
   rules; reply to comments you escalated, linking the new task).

Completion rule: every finding is fixed-and-committed or escalated as a new
task. Report the final counts in your reply, then transition ${ref} to status
done AND call the flow_phase_complete tool with ref=${ref} and
phase="feedback" — it applies the "done" label after re-checking the gates,
and its result confirms the label landed.`
}

// AIDEV-NOTE: PMR-81SX — the personal feedback section. Runs AFTER validate's
// human code-review gate already called flow_land (merge-main) and ff-only
// merged the flow branch into main, so the flow is still loop-active but the
// landing state is CONSUMED: push stays blocked and flow_land must NOT be
// called again. Every fail path writes an aven note carrying
// "reviewed-at: <git rev-parse HEAD>" and STOPs (PMR-69V8) so the loop can
// retry. The outcome summary follows the outcomeSummary() contract in
// feedback/triage.ts and must exist before done (canClose(), prompt
// contract only). Idempotent and oneshot-tolerant: already-done or
// already-recorded steps count as success, and no plan artifact is assumed.
function personalSection(ref: string): string {
  return `Close out the personal-mode flow on ${ref}. The validate phase's
human code-review gate has already merged the flow branch into main with a
local ff-only merge. The flow is STILL loop-active: push stays blocked, and
you must NOT call the flow_land tool again — its landing state is already
consumed. Execute IN ORDER:

1. Verify the merge actually landed: run
   \`git -C <main repo> merge-base --is-ancestor <flow branch> main\`
   (main repo = first entry of \`git worktree list\`). If it fails (exit
   code non-zero), write an aven note on ${ref} containing
   "reviewed-at: <git rev-parse HEAD>" plus a one-line description of the
   missing merge, and STOP and ask the human — do not merge yourself, do
   not force anything, do not continue to the next steps.
2. Write the outcome summary as an aven note on ${ref}, following this
   contract exactly: a "## Outcome summary" heading with "### What
   shipped", "### Test evidence" and "### Review verdict" sections
   (whatShipped / testEvidence / reviewVerdict). Gather the content from
   this run's notes, commits, and test output. If any section has no
   content, write an aven note on ${ref} containing
   "reviewed-at: <git rev-parse HEAD>" instead and STOP and ask the human —
   never invent filler. The outcome-summary note MUST exist before ${ref}
   can be set to done (canClose contract) — never skip it.
3. Review-feedback triage: collect every non-blocking review observation
   (P2/P3, "for later", "non-blocking", "worth knowing") recorded in the
   review notes and artifacts on ${ref} during this flow, and file each
   actionable one as its OWN backlog ticket: aven add "<sentence-case
   title>" --label review-feedback --status backlog --priority
   <medium|low> --description "..." (create the label first with
   \`aven label create\` if missing). Each description carries the finding,
   the source note/artifact id, file references, and a done-when; skip
   purely informational/self-healing notes and anything an open ticket
   already covers; mention siblings ("related to PMR-XXXX") when one
   exists. If there are no non-blocking observations, skip silently.
4. Wrap up IN ORDER: first set ${ref} to done with
   \`aven edit ${ref} --status done\`, THEN call the flow_phase_complete
   tool with ref=${ref} and phase="feedback" — it applies the "done" label
   after re-checking the gates, and its result confirms the label landed.
   The aven edit is the verified last step; do not run them in the other
   order.
5. Idempotency: if ${ref} is already status done, or a step above was
   already recorded (outcome-summary note exists, review-feedback tickets
   already filed), treat that step as success and move on — never fail the
   close-out because a step already ran. This flow may be a oneshot with no
   plan artifact: do not assume or look for a plan.md; the ticket
   description is the spec.
6. After flow_phase_complete returns ok, report the outcome counts (what
   shipped, review verdict, review-feedback ticket refs) in your reply.
   The harness removes the flow worktree automatically — no manual
   \`git worktree remove\` is needed.`
}

// AIDEV-NOTE: yolo 4.3 — yolo variant of the personal feedback section. It
// REPLACES the merge-verification flow: validate completes with
// flow_phase_complete(validate) only (it never lands), so feedback owns the
// WHOLE landing sequence: flow_land(route=pr) FIRST (it re-checks the
// review-passed label, runs the land suite itself as the final integrity
// gate, declares the push effects, and authorizes exactly one
// git push + one gh pr create), then the authorized push, then gh pr create
// with a detailed body, then verify via gh pr view --json url, then the PR
// URL is recorded in an aven note. Merge stays manual on GitHub — the PR is
// the end state. The non-landing wrap-up steps of personalSection are kept
// (outcome summary, review-feedback triage, done + complete, idempotency).
function yoloPersonalFeedbackSection(ref: string): string {
  return `Close out the personal-mode flow on ${ref}. YOLO run: gates are
skipped — act autonomously, no human confirmation steps. The validate phase
completed WITHOUT landing, so this phase owns the entire landing sequence.
Execute IN ORDER:

1. Call the flow_land tool with ref=${ref} and route=pr. This is the final
   integrity gate: it re-checks the review-passed label, runs the land test
   suite itself, declares the git-push and gh-pr-create effects, and on ok
   authorizes exactly ONE git push and ONE gh pr create for this flow. If
   flow_land refuses (missing label, red suite), write an aven note on ${ref}
   with the refusal reason plus "reviewed-at: <git rev-parse HEAD>" and STOP
   — the flow loop routes back to implement; never push or open a PR without
   the authorization, never retry blindly.
2. On flow_land ok: push the flow branch with
   \`git push -u origin <flow branch>\` (the exact branch the flow worktree
   is on — the single push flow_land authorized).
3. Open the pull request with \`gh pr create\` targeting main. Write a
   detailed body following the pr-description conventions: ticket context
   (the ${ref} description and plan summary), what changed (the substantive
   changes, not a commit dump), and test evidence (the suites that ran and
   their results, including the flow_land land-suite run).
4. Verify the PR exists: run \`gh pr view --json url\` on the branch. If the
   URL is missing or the command fails, treat step 3 as failed: fix the
   cause (do not open duplicate PRs) and re-verify.
5. Record the PR URL as an aven note on ${ref} together with a one-line
   summary of what shipped.
6. Write the outcome summary as an aven note on ${ref}, following this
   contract exactly: a "## Outcome summary" heading with "### What
   shipped", "### Test evidence" and "### Review verdict" sections
   (whatShipped / testEvidence / reviewVerdict). Gather the content from
   this run's notes, commits, and test output. If any section has no
   content, write an aven note on ${ref} containing
   "reviewed-at: <git rev-parse HEAD>" instead and STOP — never invent
   filler. The outcome-summary note MUST exist before ${ref} can be set to
   done (canClose contract) — never skip it.
7. Review-feedback triage: collect every non-blocking review observation
   (P2/P3, "for later", "non-blocking", "worth knowing") recorded in the
   review notes and artifacts on ${ref} during this flow, and file each
   actionable one as its OWN backlog ticket: aven add "<sentence-case
   title>" --label review-feedback --status backlog --priority
   <medium|low> --description "..." (create the label first with
   \`aven label create\` if missing). Each description carries the finding,
   the source note/artifact id, file references, and a done-when; skip
   purely informational/self-healing notes and anything an open ticket
   already covers; mention siblings ("related to PMR-XXXX") when one
   exists. If there are no non-blocking observations, skip silently.
8. Wrap up IN ORDER: first set ${ref} to done with
   \`aven edit ${ref} --status done\`, THEN call the flow_phase_complete
   tool with ref=${ref} and phase="feedback" — it applies the "done" label
   after re-checking the gates, and its result confirms the label landed.
   The aven edit is the verified last step; do not run them in the other
   order.
9. Idempotency: if ${ref} is already status done, or a step above was
   already recorded (PR URL note exists, outcome-summary note exists,
   review-feedback tickets already filed), treat that step as success and
   move on — never fail the close-out because a step already ran. NEVER
   re-run the push or gh pr create outside the single authorization from
   step 1, and never merge the PR — merging stays manual on GitHub; the
   open PR is the end state of a yolo run. This flow may be a oneshot with
   no plan artifact: do not assume or look for a plan.md; the ticket
   description is the spec.
10. After flow_phase_complete returns ok, report the outcome counts (what
   shipped, review verdict, PR URL, review-feedback ticket refs) in your
   reply. The harness removes the flow worktree automatically — no manual
   \`git worktree remove\` is needed.`
}

export function buildFeedbackPrompt(input: FeedbackPromptInput): string {
  const header = `Feedback phase (PIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  let section: string
  if (input.mode === 'personal') {
    if (input.yolo === true) {
      section = yoloPersonalFeedbackSection(input.ref)
    } else {
      section = personalSection(input.ref)
    }
  } else {
    section = workSection(input.ref)
  }
  return `${header}\n${section}`
}

// AIDEV-NOTE: re-export so prompt consumers and tests share one classifier.
export { classify }
