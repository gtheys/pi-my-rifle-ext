// AIDEV-NOTE: Prompt handed to the pi agent via sendUserMessage after the
// command resolves args/mode/path. The agent drives the question loop
// (ask_user_question), scouts (subagent tool from pi-interactive-subagents),
// writes the artifact, then runs the ticket-creation gate. Routing-only reuse
// of the user's debug skill (referenced by name, never imported).
// Ticket research (research/refs.ts classified a jira-shaped ref) SKIPS the
// creation gate: the ticket exists — aven epic first, acli fallback.

export interface PromptInput {
  kind: 'feature' | 'debug'
  input: string
  artifactPath: string
  mode: 'work' | 'personal'
}

export interface TicketPromptInput {
  jiraId: string
  /** Resolved local epic ref; null when the ticket is not aven-managed. */
  epicRef: string | null
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
NEVER call acli or aven create before the explicit confirm answer.

COMPLETION LABEL — when the research phase is fully done (artifact written,
gate answered): ensure the ticket this research ran against — the one
confirmed at the gate, or the existing ticket when the flow already provided
one — carries the "researched" label (aven edit <ref> --label researched).
The RPIV flow advances by reading lifecycle labels; without "researched" the
flow halts at research. If the gate declined ticket creation, skip this.`

// AIDEV-NOTE: scout fan-out contract — codegraph MCP, when available, must
// be initialized and fresh (codegraph init on "not initialized", then sync)
// and named in scout tasks so scouts use codegraph_explore instead of a
// ripgrep-only sweep.
const CODEGRAPH_INSTRUCTIONS = `
CODEGRAPH — before spawning scouts: if the mcp__codegraph__codegraph_explore
tool is available, run "codegraph sync" (bash) in the repo so the index is
current. If sync fails with "CodeGraph not initialized", run "codegraph init
-y" once, then sync again. Then mention in each scout task that
codegraph_explore is available and preferred for code search. If the tool is
not available, skip this and let scouts fall back to ripgrep.`

// AIDEV-NOTE: shared feature steps so the topic flow and the ticket flow can
// never drift on the loop/scouts/artifact instructions.
function featureSteps(artifactPath: string): string {
  return `1. Use the ask_user_question tool in a loop, one question at a time, until the
   mechanism, scope, and constraints are understood.
2. Spawn scout subagents (subagent tool, in parallel) to map the relevant code
   and report findings.
${CODEGRAPH_INSTRUCTIONS}
3. Write a markdown artifact to: ${artifactPath}
   Sections: Questions (with answers), Findings, Diagrams (mermaid code fences
   for architecture/data/flow diagrams), Ticket implications (what the future
   ticket must contain: scope, risks, touched areas).`
}

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
${CODEGRAPH_INSTRUCTIONS}
2. Write a markdown artifact to: ${input.artifactPath}
   Sections: Questions, Findings, Hypothesis chain (ordered hypotheses with
   the root cause marked), Evidence (logs, traces, code refs).
${GATE_INSTRUCTIONS}`
  }
  return `${header}
Feature flow: topic = "${input.input}".

Understand the mechanism before proposing anything:
${featureSteps(input.artifactPath)}
${GATE_INSTRUCTIONS}`
}

export function buildTicketResearchPrompt(input: TicketPromptInput): string {
  const header = `Research phase (RPIV flow). Mode: ${input.mode}. Ticket: ${input.jiraId}.`
  const noCreate = `The ticket already exists. Do NOT run the ticket-creation gate and do
NOT create anything.

Brief: fetch the research subject FIRST. Quote its summary/description in the
artifact's Ticket section.`
  if (input.epicRef !== null) {
    return `${header}
The ticket exists as local epic ${input.epicRef} (jira-ref metadata,
dep-linked to the synced Jira ticket).
${noCreate}
Run \`aven show ${input.epicRef} --json\` for the epic and, when more detail
helps, \`acli jira workitem view ${input.jiraId}\` for the synced ticket.

${featureSteps(input.artifactPath)}

COMPLETION LABEL — this phase advances the RPIV flow. When the artifact is
written, run \`aven edit ${input.epicRef} --label researched\`. Without the
label /flow halts at research.`
  }
  return `${header}
The ticket exists in Jira but is not aven-managed (no local epic).
${noCreate}
Run \`acli jira workitem view ${input.jiraId}\`. If that fails, stop and
report the failure — do not guess the contents and do not create any ticket.

${featureSteps(input.artifactPath)}

COMPLETION — no aven ref exists, so no "researched" label can land. Append a
line "> researched by pi-flow on <today's date>" to the artifact header, and
note under Ticket implications that a later \`/flow ${input.jiraId}\` will
create the local epic and re-run research once.`
}
