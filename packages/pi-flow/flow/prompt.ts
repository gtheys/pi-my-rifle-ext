// AIDEV-NOTE: /flow orchestrator handoff prompt. The agent acts as the flow
// driver: it runs the REMAINING phases in order by invoking the phase commands
// EXACTLY as a human would (/research <ref>, /plan <ref>, ...), so each phase
// keeps its own gates, prompts, and human confirmations. Stop-on-fail: any
// phase that fails or is refused -> write a failure note on the ref, leave the
// last good label untouched, STOP (no phase-skipping, no manual gate bypass).
// After each phase completes, verify its label actually landed before
// advancing — the label is the resume point.

export interface FlowPromptInput {
  mode: 'work' | 'personal'
  ref: string
  startPhase: string
  commands: string[]
  researchSkip: boolean
}

const STOP_RULE = `
STOP-ON-FAIL RULE: if any phase command fails, is refused, or its gate blocks:
1. Write an aven note on the ref: "flow halted at <phase>: <reason>".
2. Do NOT remove or downgrade any existing label — the ref stays at its last
   good label.
3. STOP. Do not try workarounds, do not run later phases, do not bypass gates.
The user re-runs /flow; it resumes at the failed phase.`

export function buildFlowPrompt(input: FlowPromptInput): string {
  const header = `RPIV flow orchestration. Mode: ${input.mode}. Ref: ${input.ref}. Starting phase: ${input.startPhase}.`
  const skip =
    input.researchSkip === true
      ? '\nResearch was explicitly skipped by the user (--skip-research). Before starting the plan phase, record an aven note on the ref: "research skip confirmed by user, no researched label". Then continue with /plan.'
      : ''
  const commands = input.commands.map((cmd) => `- ${cmd}`).join('\n')
  return `${header}
You are the flow driver. Run the remaining phases IN ORDER by invoking each
phase command exactly as a human would. Never reimplement a phase's logic —
always delegate to its command so its gates and human confirmations apply.

Remaining commands, in order:
${commands}

Rules:
- Run each command, wait for it to fully complete, then verify the phase's
  completion label actually landed on the ref (aven show) BEFORE running the
  next command. If the label did not land, treat the phase as failed (see
  STOP-ON-FAIL RULE).
- All gates stay with the human — the phase commands ask for confirmation
  themselves. Never answer those gates on the user's behalf.
- Do not re-run a phase whose completion label is already present.
${STOP_RULE}${skip}

Start now with the first remaining command.`
}
