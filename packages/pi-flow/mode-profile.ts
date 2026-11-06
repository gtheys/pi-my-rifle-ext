// AIDEV-NOTE: PMR-T22H — data-only mode table. Every mode-keyed decision
// value lives here so prompts and gates read the value instead of
// re-deriving it from `mode === 'work'`; the prompt prose itself stays in
// the prompt modules. Add a row here when a mode decision is data, not
// prose.
import type { Phase } from './flow/orchestrate.ts'
import type { WorkMode } from './work-mode.ts'

export interface ModeProfile {
  /** flow_land route for the landing step: work lands via PR, personal
   *  merges the flow branch into main LOCALLY in the main (non-worktree)
   *  checkout — never a push (PMR-HYZA). */
  landingRoute: 'pr' | 'merge-main'
  /** Env var naming the external notes/artifact root for this mode. */
  artifactRootEnv: 'LLM_NOTES_ROOT' | 'PERSONAL_FEATURES'
  /** Whether Jira IDs are valid flow/research refs (work repos sync Jira;
   *  personal repos are aven-only — PMR-PCVK ambiguity rule). */
  acceptsJiraRefs: boolean
  /** Branch derivation rule for the implement phase. */
  branchRule: 'jira_create_branch' | 'conventional-slug'
  /** Phases /flow runs, in order. Personal folds feedback (summary note +
   *  done) into validate/land (PMR-GFM5). */
  phases: readonly Phase[]
}

export const MODE_PROFILE: Record<WorkMode, ModeProfile> = {
  work: {
    landingRoute: 'pr',
    artifactRootEnv: 'LLM_NOTES_ROOT',
    acceptsJiraRefs: true,
    branchRule: 'jira_create_branch',
    phases: ['plan', 'implement', 'validate', 'feedback'],
  },
  personal: {
    landingRoute: 'merge-main',
    artifactRootEnv: 'PERSONAL_FEATURES',
    acceptsJiraRefs: false,
    branchRule: 'conventional-slug',
    phases: ['plan', 'implement', 'validate'],
  },
}
