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
  /** Gate-time diff-base resolution. work: the flowbasesha recorded at
   *  worktree create (legacy fallback: the recorded branch). personal:
   *  merge-base of HEAD and the LOCAL flowbase branch at gate time —
   *  rebase-aware (PMR-7N3D); never the base's upstream ref (PMR-MH1Y,
   *  DQ7Z): personal never pushes, upstream lags local main. */
  baseResolution: 'recorded-sha' | 'merge-base-local'
  /** Env var naming the external notes/artifact root for this mode. */
  artifactRootEnv: 'LLM_NOTES_ROOT' | 'PERSONAL_FEATURES'
  /** Whether Jira IDs are valid flow/research refs (work repos sync Jira;
   *  personal repos are aven-only — PMR-PCVK ambiguity rule). */
  acceptsJiraRefs: boolean
  /** Branch derivation rule for the implement phase. Work mode derives via
   *  jira_create_branch; personal mode's worktree-tool branch carries the
   *  active flow ref — `<type>/<REF>-<slug>`, bare `<type>/<slug>` outside a
   *  flow (PMR-902B; prose lives in implement/prompt.ts). */
  branchRule: 'jira_create_branch' | 'ref-prefixed-slug'
  /** Phases /flow runs, in order. Both modes run the full PIV order —
   *  personal feedback is its own wrap-up phase (PMR-81SX, unfolding
   *  PMR-GFM5's earlier fold). */
  phases: readonly Phase[]
}

export const MODE_PROFILE: Record<WorkMode, ModeProfile> = {
  work: {
    landingRoute: 'pr',
    baseResolution: 'recorded-sha',
    artifactRootEnv: 'LLM_NOTES_ROOT',
    acceptsJiraRefs: true,
    branchRule: 'jira_create_branch',
    phases: ['plan', 'implement', 'validate', 'feedback'],
  },
  personal: {
    landingRoute: 'merge-main',
    baseResolution: 'merge-base-local',
    artifactRootEnv: 'PERSONAL_FEATURES',
    acceptsJiraRefs: false,
    branchRule: 'ref-prefixed-slug',
    phases: ['plan', 'implement', 'validate', 'feedback'],
  },
}
