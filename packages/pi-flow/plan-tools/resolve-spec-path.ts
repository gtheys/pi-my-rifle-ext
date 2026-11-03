/**
 * resolve_spec_path tool — compute the canonical spec file path for a Jira ticket.
 * Moved from packages/pi-planning (PMR-XCA9).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { resolveSpecPath } from './helpers.ts'

export function registerResolveSpecPath(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'resolve_spec_path',
    label: 'Resolve Spec Path',
    description:
      'Compute the canonical spec file path for a Jira ticket. Resolves repo name from git remote, applies $LLM_NOTES_ROOT if set, generates a slug from the summary (max 5 words, lowercase, dashes). Returns the full absolute path.',
    promptSnippet: 'Compute the canonical spec file path for a Jira ticket',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID, e.g. IMP-7070' }),
      summary: Type.String({
        description: 'Jira summary/title used to generate the slug',
      }),
    }),
    async execute(_id, params) {
      const specPath = await resolveSpecPath(pi, params.jira_id, params.summary)
      return {
        content: [{ type: 'text', text: specPath }],
        details: { specPath },
      }
    },
  })
}
