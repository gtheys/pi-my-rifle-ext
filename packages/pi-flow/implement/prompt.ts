// AIDEV-NOTE: Handoff prompts per route, sent via sendUserMessage from the
// /implement command (same pattern as plan/prompt.ts). Plan routing hands off
// to the implement-plan-aven skill BY NAME — never reimplemented here. Oneshot
// and bug routing are pi-flow's own playbooks: worktree isolation (PMR-NJYY),
// branch derivation (jira_create_branch for work refs, conventional slug
// branch for personal), per-task test+commit cycle, retry budget, escalation.

export interface ImplementPromptInput {
  mode: 'work' | 'personal'
  ref: string
  route: 'oneshot' | 'plan' | 'bug'
  researchSkip?: boolean
}

function commonRules(ref: string): string {
  return `
Hard rules for every task in this phase:
- Implement ONLY inside an isolated git worktree (PMR-NJYY rule). The main checkout is read-only.
- Retry budget: at most 3 attempts per task. If a test still fails after 3 attempts: STOP. Write the failure evidence as an aven note on the task (commands run, last error, hypothesis), set the task status to "blocked", and escalate to the human. NEVER silently continue past a red test.
- Each task = implement -> run tests -> commit. A task is done only when its test run is green AND the commit landed in the worktree.
- Follow the repo's commit discipline; use conventional commit subjects.
- PHASE COMPLETION LABEL: when ALL work for this phase is green and committed, call the flow_phase_complete tool with ref=${ref} and phase="implement" — it applies the "active" label after re-checking the gates, and its result confirms the label landed. NEVER set the ticket status to "done" in this phase; later phases own that. Direct aven label edits on lifecycle labels are blocked.
`
}

const BRANCH_RULES = `
Branch derivation:
- Work mode: create the branch via the jira_create_branch tool for the ticket ref.
- Personal mode: create a conventional branch from the ticket slug (e.g. feat/<slug>).`

const SKIP_RULE = `
The research phase was explicitly skipped (--skip-research). Record this skip as an aven note on the task ("research skip confirmed by user, no researched label") BEFORE implementing.`

export function buildImplementPrompt(input: ImplementPromptInput): string {
  const header = `Implement phase (RPIV flow). Mode: ${input.mode}. Ref: ${input.ref}. Route: ${input.route}.`
  const skip = input.researchSkip === true ? SKIP_RULE : ''

  if (input.route === 'plan') {
    return `${header}
Invoke the user's implement-plan-aven skill (engineering:implement-plan-aven)
for ${input.ref} and follow its workflow exactly.
${BRANCH_RULES}${commonRules(input.ref)}
- Walk the epic's subtasks IN ORDER (aven epic list), but NEVER start a
  subtask that is blocked by an open dependency (check each subtask's
  blocked state before starting it) — finish its blockers first.
- EACH subtask gets its own test run + commit; mark it done only then.
- Keep working until ALL subtasks are done (each marked done only after its own test run + commit); then set the "active" label on ${input.ref} — never mark the epic status done in this phase.${skip}`
  }

  if (input.route === 'bug') {
    return `${header}
Reproduce-first bug flow for ${input.ref}:
1. Read the research artifact's evidence and REPRODUCE the bug first — write a failing test that demonstrates it.
2. Fix the bug; the test must turn green and prove the fix.
3. Run the full test suite, then commit.
${BRANCH_RULES}${commonRules(input.ref)}${skip}`
  }

  return `${header}
Oneshot flow for ${input.ref}:
1. Implement the change in a single implement -> test -> commit cycle.
2. Run the test suite; it must be green before the commit lands.
3. Once tests are green AND the commit landed, apply the PHASE COMPLETION LABEL rule above (flow_phase_complete with phase="implement").
${BRANCH_RULES}${commonRules(input.ref)}${skip}`
}
