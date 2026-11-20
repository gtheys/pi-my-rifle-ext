/**
 * Pure branch-delete decisions for worktree remove.
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

// AIDEV-NOTE: PMR-81SX — auto-cleanup (flow done) decision for branch removal.
// Unlike the manual helper above, the auto path never refuses or aborts: it
// defers to the human instead. keep-all (worktree AND branch kept) is used
// when personal-mode merged-proof fails — a human must investigate the
// unproven merge. decideBranchDelete above (manual path, :17–46) must stay
// untouched: its refusal semantics are pinned by tests and user-facing.
export type AutoBranchDeleteDecision =
  | { action: 'delete' }
  | { action: 'keep-branch'; reason: string }
  | { action: 'keep-all'; reason: string }

export function decideAutoBranchDelete(input: {
  mode: 'work' | 'personal'
  prState: PrState
  localMergedProof: boolean
  force?: boolean
}): AutoBranchDeleteDecision {
  if (input.force) {
    return { action: 'delete' }
  }
  if (input.mode === 'personal') {
    if (input.localMergedProof) {
      return { action: 'delete' }
    }
    return {
      action: 'keep-all',
      reason:
        'personal merged-proof failed: git merge-base --is-ancestor <branch> main did not pass in the main checkout — keeping worktree and branch for human investigation',
    }
  }
  if (input.prState === 'MERGED') {
    return { action: 'delete' }
  }
  if (input.prState === 'OPEN') {
    return {
      action: 'keep-branch',
      reason:
        'PR still open — removing worktree, keeping branch until the human merges',
    }
  }
  if (input.prState === 'CLOSED') {
    return {
      action: 'keep-branch',
      reason: 'PR closed without merge — cannot prove merge, keeping branch',
    }
  }
  if (input.prState === 'GH_MISSING') {
    return {
      action: 'keep-branch',
      reason: 'gh CLI unavailable — cannot verify merge state, keeping branch',
    }
  }
  return {
    action: 'keep-branch',
    reason: 'no PR found for branch — cannot prove merge, keeping branch',
  }
}

// AIDEV-NOTE: herdr panes may lack SSH_AUTH_SOCK, so the post-remove
// `git fetch --prune` can fail with publickey even when the user's keys are
// fine (PMR-8JQ8). Classify auth failures as a skip instead of a scary
// failure line; the fetch stays best-effort either way.
export function describePruneFailure(output: string): string {
  if (/Permission denied \(publickey\)/.test(output)) {
    return 'prune skipped: git fetch --prune could not authenticate (ssh publickey) in this environment; remote refs may be stale'
  }
  return `git fetch --prune failed (non-fatal): ${output}`
}
