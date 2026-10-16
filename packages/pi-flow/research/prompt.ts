// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after the
// command resolves args/mode/path. The agent drives the question loop
// (ask_user_question), scouts (subagent tool from pi-interactive-subagents),
// writes the artifact, then runs the ticket-creation gate. Routing-only reuse
// of the user's debug skill (referenced by name, never imported).

export interface PromptInput {
  kind: 'feature' | 'debug'
  input: string
  artifactPath: string
  mode: 'work' | 'personal'
}

const GATE_INSTRUCTIONS = `
TICKET CREATION GATE — after the artifact is written:
1. Use the ask_user_question tool to propose a ticket destination and require an
   explicit "Confirm" before anything is created. Propose:
   - work mode: the Jira project (pick the most likely project key, let the user
     confirm or override).
   - personal mode: the aven workspace AND project (a named project may exist in
     several workspaces — confirm both).
2. ONLY if the user explicitly confirms, create the ticket:
   - work mode: acli jira workitem create in the confirmed project.
   - personal mode: aven ticket create in the confirmed workspace+project.
3. Set the type label at creation: "bug" for debug flow, "feature" for the
   feature flow (default).
4. Record the confirmation: aven tickets get a note "confirmed by user,
   destination <destination>"; for Jira tickets append a line
   "> confirmed by user, destination <destination>" to the artifact header.
5. If the user declines, create nothing and say so.
NEVER call acli or aven create before the explicit confirm answer.`

export function buildResearchPrompt(input: PromptInput): string {
  const header = `Research phase (RPIV flow). Mode: ${input.mode}.`
  if (input.kind === 'debug') {
    return `${header}
Debug flow: symptom = "${input.input}".

Drive the user's existing debug skill (invoke /engineering:debug) to find the
root cause of the symptom. Follow its workflow; use ask_user_question whenever
you need information from the user.

When the root cause is understood:
1. Optionally spawn scout subagents (subagent tool, parallel) to gather
   evidence from the codebase.
2. Write a markdown artifact to: ${input.artifactPath}
   Sections: Questions, Findings, Hypothesis chain (ordered hypotheses with
   the root cause marked), Evidence (logs, traces, code refs).
${GATE_INSTRUCTIONS}`
  }
  return `${header}
Feature flow: topic = "${input.input}".

Understand the mechanism before proposing anything:
1. Use the ask_user_question tool in a loop, one question at a time, until the
   mechanism, scope, and constraints are understood.
2. Spawn scout subagents (subagent tool, in parallel) to map the relevant code
   and report findings.
3. Write a markdown artifact to: ${input.artifactPath}
   Sections: Questions (with answers), Findings, Diagrams (mermaid code fences
   for architecture/data/flow diagrams), Ticket implications (what the future
   ticket must contain: scope, risks, touched areas).
${GATE_INSTRUCTIONS}`
}
