// AIDEV-NOTE: Feedback-phase handoff prompts (PMR-XDRB phase 5), sent via
// sendUserMessage (same pattern as validate/prompt.ts). Work mode runs
// the sonarqube and pr_quality TOOLS (PMR-69V8: agents cannot invoke slash
// commands).
// The triage rules mirror classify() in feedback/triage.ts; the escalation
// rule (new work = new task through the gates) is stated as an absolute in
// the prompt so the agent can never fix silently or ignore a finding.
// Personal mode has no feedback phase (PMR-GFM5): validate's personal gate
// writes the outcome summary note (outcomeSummary() shapes it) and sets done
// after the push — the canClose() guard is enforced there by prompt contract.

import { classify, FIX_NOW_SEVERITIES } from './triage.ts'

export interface FeedbackPromptInput {
  /** Work only: personal folds feedback into validate (PMR-GFM5). */
  mode: 'work'
  ref: string
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
3. Fix-now findings: use the pr_quality tool for review-thread context, fix, and COMMIT each fix.
4. Address all unresolved GitHub review comments on the PR (same triage
   rules; reply to comments you escalated, linking the new task).

Completion rule: every finding is fixed-and-committed or escalated as a new
task. Report the final counts in your reply, then transition ${ref} to status
done AND call the flow_phase_complete tool with ref=${ref} and
phase="feedback" — it applies the "done" label after re-checking the gates,
and its result confirms the label landed.`
}

export function buildFeedbackPrompt(input: FeedbackPromptInput): string {
  const header = `Feedback phase (PIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  return `${header}\n${workSection(input.ref)}`
}

// AIDEV-NOTE: re-export so prompt consumers and tests share one classifier.
export { classify }
