/**
 * delivery_mode tool — classify or set a feature's delivery mode
 * (oneshot | investigate | planned).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { avenEdit, avenEpicList, avenShowFull } from '../shared/aven.ts'

export type DeliveryMode = 'oneshot' | 'investigate' | 'planned'

/**
 * AIDEV-NOTE: classify precedence — explicit metadata['delivery-mode']
 * always wins. Only when absent do we infer: non-empty epic list or
 * plan-state metadata present implies 'planned', otherwise 'oneshot'.
 * 'investigate' is never inferred, only ever set explicitly.
 */
export function classifyDeliveryMode(
  metadata: Record<string, string>,
  hasEpicChildren: boolean,
): DeliveryMode {
  const explicit = metadata['delivery-mode']
  if (
    explicit === 'oneshot' ||
    explicit === 'investigate' ||
    explicit === 'planned'
  ) {
    return explicit
  }
  if (hasEpicChildren || metadata['plan-state'] !== undefined) {
    return 'planned'
  }
  return 'oneshot'
}

export async function deliveryMode(
  pi: ExtensionAPI,
  featureRef: string,
  cwd: string,
  action: 'classify' | 'set',
  mode: DeliveryMode | undefined,
): Promise<{ mode: DeliveryMode }> {
  if (action === 'set') {
    if (mode === undefined) {
      throw new Error('delivery_mode: mode is required for action=set')
    }
    await avenEdit(pi, featureRef, { metadata: { 'delivery-mode': mode } }, cwd)
    return { mode }
  }
  const ticket = await avenShowFull(pi, featureRef, cwd)
  const epicChildren = await avenEpicList(pi, featureRef, cwd)
  return {
    mode: classifyDeliveryMode(ticket.metadata, epicChildren.length > 0),
  }
}

export function registerDeliveryMode(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'delivery_mode',
    label: 'Delivery Mode',
    description:
      'Classify (metadata wins over inference) or explicitly set a feature\u2019s delivery mode (oneshot, investigate, planned).',
    promptSnippet: 'Classify or set a feature\u2019s delivery mode',
    parameters: Type.Object({
      feature_ref: Type.String({ description: 'Feature ticket ref' }),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
      action: Type.Optional(
        Type.Union([Type.Literal('classify'), Type.Literal('set')]),
      ),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('oneshot'),
          Type.Literal('investigate'),
          Type.Literal('planned'),
        ]),
      ),
    }),
    async execute(_id, params) {
      const action = params.action ?? 'classify'
      const result = await deliveryMode(
        pi,
        params.feature_ref,
        params.cwd,
        action,
        params.mode,
      )
      return {
        content: [
          {
            type: 'text',
            text: `${params.feature_ref}: delivery-mode=${result.mode}`,
          },
        ],
        details: result,
      }
    },
  })
}
