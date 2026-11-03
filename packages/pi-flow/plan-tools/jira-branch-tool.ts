/**
 * jira_create_branch tool — thin registerTool wrapper around
 * jira-branch.ts. Shared by the implement-plan and debug skills, replacing
 * the formerly-duplicated scripts/jira-branch.sh in each skill directory.
 * Moved from packages/pi-planning/implement-plan (PMR-XCA9).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { createJiraBranch } from './jira-branch.ts'

export function registerJiraCreateBranch(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'jira_create_branch',
    label: 'Jira: Create Branch',
    description: [
      'Derive a git branch name from a Jira issue (type → prefix, summary → slug),',
      'and unless dry_run, create it in the given repo and set its git-town parent',
      "to 'develop'. Requires acli and git-town on PATH. Run with cwd set to the target repo.",
    ].join(' '),
    promptSnippet: 'Derive/create a git branch from a Jira issue',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID, e.g. DP-121' }),
      cwd: Type.String({
        description: 'Absolute path to the target repo (its git root)',
      }),
      dry_run: Type.Optional(
        Type.Boolean({
          description: 'Preview the derived branch name without creating it',
          default: false,
        }),
      ),
    }),
    async execute(_id, params) {
      const result = await createJiraBranch(
        pi,
        params.jira_id,
        params.cwd,
        params.dry_run ?? false,
      )

      let text: string
      if (params.dry_run) {
        text = `[dry-run] Branch: ${result.branch} (type '${result.issueType}' → prefix '${result.prefix}')`
      } else if (result.alreadyExisted) {
        text = `Branch '${result.branch}' already exists — not created.`
      } else {
        text = `Created branch '${result.branch}' and set git-town parent to 'develop'.`
      }

      return { content: [{ type: 'text', text }], details: result }
    },
  })
}
