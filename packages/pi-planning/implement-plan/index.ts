/**
 * Implement Plan Extension (aven edition)
 *
 * Tool:
 *   jira_create_branch    - jira-branch-tool.ts (used by implement-plan-aven
 *                           Step 3 and pi-flow's /implement prompt for
 *                           Jira-synced tickets)
 *
 * AIDEV-NOTE: The old ungated /implement command was removed — it collided
 * with pi-flow's gated RPIV /implement phase (pi suffixes duplicates as
 * /implement:1 and /implement:2, making the gated and ungated variants
 * indistinguishable in the command list). The implement-plan-aven skill
 * stays reachable via natural phrases ("implement PMR-ZTVG") or
 * /skill:implement-plan-aven <ref>.
 *
 * (tw_execution_plan / tw_advance_task / tw_phase_checkpoint were removed
 * with the taskwarrior flow — aven is the task store; the aven skills call
 * `aven` CLI directly.)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerJiraCreateBranch } from './jira-branch-tool.ts'

export default function (pi: ExtensionAPI) {
  registerJiraCreateBranch(pi)
}
