/**
 * Aven Tools Extension
 *
 * Tools:
 *   find_or_create_epic - find-or-create-epic.ts
 *   advance_plan_state - advance-plan-state.ts
 *   create_feature_tree - create-feature-tree.ts
 *   get_feature_tree - get-feature-tree.ts
 *   close_phase - close-phase.ts
 *   delivery_mode - delivery-mode.ts
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerAdvancePlanState } from './advance-plan-state.ts'
import { registerClosePhase } from './close-phase.ts'
import { registerCreateFeatureTree } from './create-feature-tree.ts'
import { registerDeliveryMode } from './delivery-mode.ts'
import { registerFindOrCreateEpic } from './find-or-create-epic.ts'
import { registerGetFeatureTree } from './get-feature-tree.ts'

export default function (pi: ExtensionAPI) {
  registerFindOrCreateEpic(pi)
  registerAdvancePlanState(pi)
  registerCreateFeatureTree(pi)
  registerGetFeatureTree(pi)
  registerClosePhase(pi)
  registerDeliveryMode(pi)
}
