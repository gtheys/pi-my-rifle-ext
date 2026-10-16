// AIDEV-NOTE: Ticket-creation gate. buildTicketPlan is PURE and is the safety
// property: it returns a plan object ONLY when `confirmed === true` AND the
// destination details are present. The pi command must not invoke acli/aven
// create unless this returned a plan. Confirmation is always obtained via an
// explicit ask-user-question ("confirm") from the human BEFORE creation.

export interface GateInput {
  kind: 'feature' | 'debug'
  mode: 'work' | 'personal'
  confirmed: boolean | undefined
  projectKey?: string
  workspace?: string
  project?: string
}

export interface TicketPlan {
  destination: 'jira' | 'aven'
  projectKey?: string
  workspace?: string
  project?: string
  typeLabel: 'bug' | 'feature'
  summary: string
}

export function buildTicketPlan(input: GateInput): TicketPlan | null {
  if (input.confirmed !== true) return null

  let typeLabel: 'bug' | 'feature'
  if (input.kind === 'debug') {
    typeLabel = 'bug'
  } else {
    typeLabel = 'feature'
  }

  if (input.mode === 'work') {
    if (!input.projectKey) return null
    return {
      destination: 'jira',
      projectKey: input.projectKey,
      typeLabel,
      summary: `confirmed by user, destination Jira project ${input.projectKey}`,
    }
  }

  if (!input.workspace || !input.project) return null
  return {
    destination: 'aven',
    workspace: input.workspace,
    project: input.project,
    typeLabel,
    summary: `confirmed by user, destination aven workspace '${input.workspace}', project '${input.project}'`,
  }
}
