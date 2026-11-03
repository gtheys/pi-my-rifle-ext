/**
 * resolve_feature_path tool — compute the canonical feature plan path.
 * Moved from packages/pi-planning (PMR-XCA9).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { resolveFeaturePath } from './helpers.ts'

export function registerResolveFeaturePath(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'resolve_feature_path',
    label: 'Resolve Feature Path',
    description:
      'Compute the canonical plan.md path for a personal feature. If $PERSONAL_FEATURES is set, uses $PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md; otherwise falls back to <git-toplevel>/.pi/plans/<date>-<slug>/plan.md. Slug is generated from the summary (max 5 words, lowercase, dashes). Returns the full absolute path.',
    promptSnippet: 'Compute the canonical plan.md path for a personal feature',
    parameters: Type.Object({
      summary: Type.String({
        description: 'Feature summary/title used to generate the slug',
      }),
    }),
    async execute(_id, params) {
      const featurePath = await resolveFeaturePath(pi, params.summary)
      return {
        content: [{ type: 'text', text: featurePath }],
        details: { featurePath },
      }
    },
  })
}
