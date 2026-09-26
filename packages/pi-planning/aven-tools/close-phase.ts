/**
 * close_phase tool — mark a phase ticket done, then re-read the feature
 * tree to compute the next open phase ref (reuses get_feature_tree logic).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { avenEdit } from '../shared/aven.ts'
import { getFeatureTree } from './get-feature-tree.ts'

export interface ClosePhaseResult {
  nextPhaseRef: string | null
}

export async function closePhase(
  pi: ExtensionAPI,
  phaseRef: string,
  featureRef: string,
  cwd: string,
): Promise<ClosePhaseResult> {
  await avenEdit(pi, phaseRef, { status: 'done' }, cwd)
  const tree = await getFeatureTree(pi, featureRef, cwd)
  return { nextPhaseRef: tree.resumeRef }
}

export function registerClosePhase(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'close_phase',
    label: 'Close Phase',
    description:
      'Mark a phase ticket done, then return the next open phase ref (or null when all phases are done).',
    promptSnippet: 'Close a phase and get the next open phase ref',
    parameters: Type.Object({
      phase_ref: Type.String({ description: 'Phase ticket ref to close' }),
      feature_ref: Type.String({ description: 'Feature ticket ref' }),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
    }),
    async execute(_id, params) {
      const result = await closePhase(
        pi,
        params.phase_ref,
        params.feature_ref,
        params.cwd,
      )
      return {
        content: [
          {
            type: 'text',
            text: `${params.phase_ref}: closed, next=${result.nextPhaseRef ?? 'none'}`,
          },
        ],
        details: result,
      }
    },
  })
}
