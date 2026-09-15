/**
 * Implement Plan Extension (aven edition)
 *
 * Remaining non-taskwarrior pieces:
 *
 * Tool:
 *   jira_create_branch    - jira-branch-tool.ts (used by implement-plan-aven
 *                           Step 3 for Jira-synced tickets)
 *
 * Command:
 *   /implement <JIRA-ID | AVEN-REF>  - route to the implement-plan-aven skill
 *
 * (tw_execution_plan / tw_advance_task / tw_phase_checkpoint were removed
 * with the taskwarrior flow — aven is the task store; the aven skills call
 * `aven` CLI directly.)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerJiraCreateBranch } from './jira-branch-tool.ts'

export default function (pi: ExtensionAPI) {
  registerJiraCreateBranch(pi)

  // ── /implement command ─────────────────────────────────────────────────────

  // AIDEV-NOTE: Entry point for implement-plan-aven. Routes straight to the
  // aven skill — it resolves aven refs and jira-key-synced Jira IDs itself
  // and discovers the execution tree from the aven epic.
  pi.registerCommand('implement', {
    description: 'Implement an aven feature (aven ref or synced Jira ID)',
    handler: async (args, ctx) => {
      const ref = args.trim()
      if (!ref) {
        ctx.ui.notify(
          'Usage: /implement <AVEN-REF | JIRA_ID>  e.g. /implement PMR-ZTVG',
          'warning',
        )
        return
      }

      pi.sendUserMessage(`/skill:implement-plan-aven ${ref}`)
    },
  })
}
