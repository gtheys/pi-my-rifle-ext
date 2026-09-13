/**
 * Plan Tools Extension (aven edition)
 *
 * Remaining non-taskwarrior planning helpers used by the aven skills:
 *
 * Tools (one per file):
 *   resolve_spec_path     - resolve-spec-path.ts
 *   resolve_feature_path  - resolve-feature-path.ts
 *   open_in_pane          - open-in-pane.ts
 *
 * Command:
 *   /review-spec  - open a spec/plan file with nvim in a herdr review pane
 *
 * (/plan is registered by pi-interactive-subagents and routes to
 * feature-plan-aven; taskwarrior tools were removed — aven is the task
 * store. jira_create_branch lives in the implement-plan entrypoint.)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { openFileInPane, registerOpenInPane } from './open-in-pane.ts'
import { registerResolveFeaturePath } from './resolve-feature-path.ts'
import { registerResolveSpecPath } from './resolve-spec-path.ts'

export default function (pi: ExtensionAPI) {
  registerResolveSpecPath(pi)
  registerResolveFeaturePath(pi)
  registerOpenInPane(pi)

  pi.registerCommand('review-spec', {
    description: 'Open a spec/plan file with nvim in a herdr review pane',
    handler: async (args, ctx) => {
      const path = args.trim()
      if (!path) {
        ctx.ui.notify('Usage: /review-spec <path>', 'warning')
        return
      }

      const result = await openFileInPane(pi, path)
      const text = result.content[0]?.text ?? ''
      if (result.details.ok) {
        ctx.ui.notify(text, 'info')
      } else {
        ctx.ui.notify(text, 'error')
      }
    },
  })
}
