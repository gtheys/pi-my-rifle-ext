// AIDEV-NOTE: Feedback-phase handoff prompts (PMR-XDRB phase 5), sent via
// sendUserMessage (same pattern as validate/prompt.ts). Work mode runs
// /sonarqube and /pr-quality (pi-review) BY NAME — no imports of pi-review.
// The triage rules mirror classify() in feedback/triage.ts; the escalation
// rule (new work = new task through the gates) is stated as an absolute in
// the prompt so the agent can never fix silently or ignore a finding.
// Personal mode: re-run /review after validate's fixes, write the outcome
// summary aven note (outcomeSummary() shapes it), and only then set done —
// the completion guard canClose() is enforced here by prompt contract.

import { classify, FIX_NOW_SEVERITIES } from './triage.ts'

export interface FeedbackPromptInput {
  mode: 'work' | 'personal'
  ref: string
}

const MECHANICAL = [...FIX_NOW_SEVERITIES].join(', ')

function workSection(ref: string): string {
  return `Run the feedback work gate on ${ref}'s PR. Execute IN ORDER:

1. Run /sonarqube on the PR (pi-review, BY NAME) and read its report.
2. For EACH unresolved finding, triage it with these rules:
   - Mechanical findings (severity ${MECHANICAL}) that do NOT touch
     behavior, architecture, data, migrations, schema, or API contracts are
     fixed immediately.
   - Anything touching behavior/architecture/data — regardless of severity —
     and every major/critical/blocker, and every finding whose severity you
     cannot determine, becomes a NEW Jira/aven task that goes back through
     the flow gates (/research /plan /implement /validate). NEVER fix such a
     finding silently inside feedback. NEVER ignore a finding: every finding
     ends as either a fix commit or a new task. Nothing is left unresolved.
3. Fix-now findings: fix via /pr-quality semantics and COMMIT each fix.
4. Address all unresolved GitHub review comments on the PR (same triage
   rules; reply to comments you escalated, linking the new task).

Completion rule: every finding is fixed-and-committed or escalated as a new
task. Report the final counts in your reply, then transition ${ref} to status
done AND set the "done" label on ${ref} (aven edit ${ref} --label done) — the
flow's advance gate reads the label.`
}

function personalSection(ref: string): string {
  return `Run the feedback personal flow on ${ref}:

1. If the validate phase produced fixes after its /review, re-run /review
   (BY NAME) on the final state and address its blockers via the same rules
   as the work mode (mechanical fixes committed; bigger findings become new
   tasks through the gates — never silent, never ignored).
2. Write the outcome summary as an aven note on ${ref}: what shipped, the
   test evidence, and the review verdict (use the outcomeSummary shape:
   "## Outcome summary" with "### What shipped", "### Test evidence",
   "### Review verdict" sections).
3. ONLY once the outcome summary note exists, transition ${ref} to status
   done AND set the "done" label on ${ref} (aven edit ${ref} --label done) —
   the flow's advance gate reads the label.

Completion rule: the ticket is NEVER marked done without the outcome summary
note on it. If a section has no content, STOP and ask the human — never
invent filler.`
}

export function buildFeedbackPrompt(input: FeedbackPromptInput): string {
  const header = `Feedback phase (RPIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'personal') {
    return `${header}\n${personalSection(input.ref)}`
  }
  return `${header}\n${workSection(input.ref)}`
}

// AIDEV-NOTE: re-export so prompt consumers and tests share one classifier.
export { classify }
