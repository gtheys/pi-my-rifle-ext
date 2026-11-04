/**
 * Pure branch-delete decision for worktree remove.
 * Merge state is checked on GitHub because squash merges leave the local
 * branch looking unmerged (see plan 2026-09-07, remove step 4).
 */

export type PrState = 'MERGED' | 'OPEN' | 'CLOSED' | 'NO_PR' | 'GH_MISSING'

export type BranchDeleteDecision =
  | { action: 'delete' }
  | { action: 'refuse'; reason: string }
  | { action: 'skip'; reason: string }

export function decideBranchDelete(input: {
  deleteBranchRequested: boolean
  prState: PrState
  force: boolean
}): BranchDeleteDecision {
  if (!input.deleteBranchRequested) {
    return { action: 'skip', reason: 'delete_branch not requested' }
  }
  if (input.prState === 'MERGED' || input.force) {
    return { action: 'delete' }
  }
  if (input.prState === 'GH_MISSING') {
    return {
      action: 'refuse',
      reason: 'gh CLI unavailable — cannot verify merge state',
    }
  }
  if (input.prState === 'NO_PR') {
    return {
      action: 'refuse',
      reason: 'no PR found for branch — refusing to delete an unmerged branch',
    }
  }
  return {
    action: 'refuse',
    reason: `PR for branch is ${input.prState} — refusing to delete an unmerged branch`,
  }
}
