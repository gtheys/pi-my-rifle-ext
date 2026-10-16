// AIDEV-NOTE: Work-mode handoff prompt for /validate, sent via
// sendUserMessage (same pattern as implement/prompt.ts). Runs the gate steps
// in validate/gate.ts order via bash, bounded minikube poll, deploy via the
// user's devctl skill BY NAME, manual-test results collected via
// ask_user_question, evidence comment posted via acli. Validation passes ONLY
// after the Jira comment lands. Personal mode is a clean seam: its flow is
// wired by ticket PMR-8449 and is never silently treated as work mode.

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
Personal-mode validation is wired by ticket PMR-8449 and is not implemented yet.
Record this on ${input.ref} as an aven note ("validate: personal flow pending (PMR-8449)") and stop — do NOT run the work-mode gate.`
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
