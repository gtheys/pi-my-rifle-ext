/**
 * advance_plan_state tool — set plan-state (and optional plan-path) metadata
 * on a feature ref. No gating here — the gate lives in create_feature_tree.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { avenEdit } from '../shared/aven.ts'

export async function advancePlanState(
  pi: ExtensionAPI,
  featureRef: string,
  state: 'review' | 'approved',
  planPath: string | undefined,
  cwd: string,
): Promise<void> {
  const metadata: Record<string, string> = { 'plan-state': state }
  if (planPath !== undefined) {
    metadata['plan-path'] = planPath
  }
  await avenEdit(pi, featureRef, { metadata }, cwd)
}

export function registerAdvancePlanState(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'advance_plan_state',
    label: 'Advance Plan State',
    description:
      'Set plan-state (review or approved) and optionally plan-path metadata on a feature ref.',
    promptSnippet: 'Advance a feature ticket plan-state',
    parameters: Type.Object({
      feature_ref: Type.String({ description: 'Feature ticket ref' }),
      state: Type.Union([Type.Literal('review'), Type.Literal('approved')]),
      plan_path: Type.Optional(
        Type.String({ description: 'Absolute path to plan.md' }),
      ),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
    }),
    async execute(_id, params) {
      await advancePlanState(
        pi,
        params.feature_ref,
        params.state,
        params.plan_path,
        params.cwd,
      )
      return {
        content: [
          {
            type: 'text',
            text: `${params.feature_ref}: plan-state=${params.state}`,
          },
        ],
        details: { feature_ref: params.feature_ref, state: params.state },
      }
    },
  })
}
