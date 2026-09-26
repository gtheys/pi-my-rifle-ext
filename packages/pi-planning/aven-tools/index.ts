/**
 * Aven Tools Extension
 *
 * Tools:
 *   find_or_create_epic - find-or-create-epic.ts
 *   advance_plan_state - advance-plan-state.ts
 *   create_feature_tree - create-feature-tree.ts
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerAdvancePlanState } from './advance-plan-state.ts'
import { registerCreateFeatureTree } from './create-feature-tree.ts'
import { registerFindOrCreateEpic } from './find-or-create-epic.ts'

export default function (pi: ExtensionAPI) {
  registerFindOrCreateEpic(pi)
  registerAdvancePlanState(pi)
  registerCreateFeatureTree(pi)
}
