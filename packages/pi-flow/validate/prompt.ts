// AIDEV-NOTE: Work-mode handoff prompt for /validate, sent via
// sendUserMessage (same pattern as implement/prompt.ts). Runs the gate steps
// in validate/gate.ts order via bash, bounded minikube poll, deploy via the
// user's devctl skill BY NAME, manual-test results collected via
// ask_user_question, evidence comment posted via acli. Validation passes ONLY
// after the Jira comment lands. Personal mode (PMR-8449): the human runs the
// test themselves — the agent locates the artifacts, composes instructions via
// validate/personal.ts, asks pass/fail via ask_user_question, then records and
// routes per routePersonalOutcome. Personal mode is never treated as work mode.

import { DEFAULT_POLL_CONFIG } from './gate.ts'

export interface ValidatePromptInput {
  mode: 'work' | 'personal'
  ref: string
  scriptsDir: string | null
}

export function buildValidatePrompt(input: ValidatePromptInput): string {
  const header = `Validate phase (RPIV flow). Mode: ${input.mode}. Ref: ${input.ref}.`
  if (input.mode === 'personal') {
    return `${header}
Personal-mode validation: there is no cluster — the human is the test
environment. Do NOT run the work-mode gate (no cluster tools, no devctl, no acli).

1. Locate the ticket's plan/research artifacts for ${input.ref} (the plan-path
   metadata / research dir from earlier phases) and extract: what changed,
   the plan's validation notes, and the research findings.
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
   retry budget resets for the new attempt.`
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
Never continue past a failed step, never mark the phase validated.`
}
