import {
  type ResolvedWorktree,
  type ReviewDeps,
  resolveReviewWorktree,
} from '../tools/code-review-parse.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from './worktree-context.ts'

export type HealResult =
  | { ok: true; worktree: ResolvedWorktree; healed: boolean }
  | { ok: false; reason: string; recovery: string }

/** Recovery hint surfaced to the human/agent when healing fails. */
export function recoveryCommand(ref: string): string {
  return `/flow ${ref}`
}

// AIDEV-NOTE: PMR-DRKH — heal primitive for a lost/stale flow binding
// (module state dies on pi reload, PMR-PJM0). Resolve-only rule: when a
// DIFFERENT ref is live, we resolve for informational purposes but never
// mutate — the live flow owns the binding (PMR-1CCT/PMR-7ZEE). Mutation
// happens only when mayMutate (no live ref, or the ref we were asked to
// heal) AND needsRebind (the current binding differs from the resolution).
export async function healFlowBinding(
  ref: string,
  deps: ReviewDeps,
): Promise<HealResult> {
  let resolved: ResolvedWorktree
  try {
    resolved = await resolveReviewWorktree(ref, deps)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason, recovery: recoveryCommand(ref) }
  }

  const live = getActiveFlowRef()
  const mayMutate = live === null || live === ref

  const binding = getFlowWorktree()
  let needsRebind = true
  if (
    binding !== null &&
    binding.ref === ref &&
    binding.path === resolved.path &&
    binding.branch === resolved.branch
  ) {
    needsRebind = false
  }

  if (mayMutate) {
    if (needsRebind) {
      setActiveFlowRef(ref)
      setFlowWorktree(resolved.path, resolved.branch)
      return { ok: true, worktree: resolved, healed: true }
    }
    return { ok: true, worktree: resolved, healed: false }
  }
  return { ok: true, worktree: resolved, healed: false }
}
