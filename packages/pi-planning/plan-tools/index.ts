/**
 * Plan Tools Extension
 *
 * Provides typed taskwarrior tools for the create-plan and iterate-plan skills,
 * replacing raw bash command construction with validated, reusable tool calls.
 *
 * Tools (one per file):
 *   tw_get_ticket                       - get-ticket.ts
 *   tw_get_spec_task                    - get-spec-task.ts
 *   tw_get_phases / tw_get_impl_tasks   - get-phases-impl.ts
 *   resolve_spec_path                   - resolve-spec-path.ts
 *   tw_create_spec_task                 - create-spec-task.ts
 *   tw_create_phase                     - create-phase.ts
 *   tw_create_impl_task                 - create-impl-task.ts
 *
 * Command:
 *   /plan <JIRA_ID>  - smart routing: iterate if spec file exists, create otherwise
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { twExport } from '../shared/tw-utils.ts'
import { registerTwCreateImplTask } from './create-impl-task.ts'
import { registerTwCreatePhase } from './create-phase.ts'
import { registerTwCreateSpecTask } from './create-spec-task.ts'
import { registerGetPhasesAndImplTasks } from './get-phases-impl.ts'
import { registerTwGetSpecTask } from './get-spec-task.ts'
import { registerTwGetTicket } from './get-ticket.ts'
import { extractSpecPath, getRepoName } from './helpers.ts'
import { openFileInPane, registerOpenInPane } from './open-in-pane.ts'
import { registerResolveFeaturePath } from './resolve-feature-path.ts'
import { registerResolveSpecPath } from './resolve-spec-path.ts'

export default function (pi: ExtensionAPI) {
  registerTwGetTicket(pi)
  registerTwGetSpecTask(pi)
  registerGetPhasesAndImplTasks(pi)
  registerResolveSpecPath(pi)
  registerResolveFeaturePath(pi)
  registerTwCreateSpecTask(pi)
  registerTwCreatePhase(pi)
  registerTwCreateImplTask(pi)
  registerOpenInPane(pi)

  // AIDEV-NOTE: Smart routing — checks for existing spec file to decide
  // between create-plan and iterate-plan flows.
  pi.registerCommand('plan', {
    description:
      'Create or iterate on an implementation plan for a Jira ticket',
    handler: async (args, ctx) => {
      const jiraId = args.trim().toUpperCase()
      if (!jiraId) {
        ctx.ui.notify('Usage: /plan <JIRA_ID>  e.g. /plan IMP-7070', 'warning')
        return
      }

      ctx.ui.notify(`Checking spec for ${jiraId}...`, 'info')

      let hasSpecFile = false
      try {
        const tasks = await twExport(pi, [`jiraid:${jiraId}`, '+spec'])
        if (tasks.length > 0) {
          const specRelPath = extractSpecPath(tasks[0])
          if (specRelPath) {
            const notesRoot = process.env.LLM_NOTES_ROOT
            let fullPath: string
            if (notesRoot) {
              const repoName = await getRepoName(pi)
              fullPath = join(notesRoot, repoName, specRelPath)
            } else {
              const r = await pi.exec(
                'git',
                ['rev-parse', '--show-toplevel'],
                {},
              )
              fullPath = join(r.stdout.trim(), specRelPath)
            }
            hasSpecFile = existsSync(fullPath)
          }
        }
      } catch {
        // Default to create flow on any error
      }

      if (hasSpecFile) {
        ctx.ui.notify(`Spec exists → iterate-plan`, 'info')
        pi.sendUserMessage(`/skill:iterate-plan ${jiraId}`)
      } else {
        ctx.ui.notify(`No spec → create-plan`, 'info')
        pi.sendUserMessage(`/skill:create-plan ${jiraId}`)
      }
    },
  })

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
