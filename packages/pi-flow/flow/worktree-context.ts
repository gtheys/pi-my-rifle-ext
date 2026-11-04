// AIDEV-NOTE: PMR-1CCT — flow worktree context. The review tool resolves its
// diff in ctx.cwd (the session checkout), but flow work lands in an isolated
// Herdr worktree — so a review from the main checkout diffs main..main (empty
// range, silent pass). This module is the bridge: the flow loop owns the
// active ref, the worktree tool binds the created path/branch to it, and the
// review tool prefers this cwd for branch/uncommitted targets.
// Process-global, last-writer-wins across concurrent sessions — same known
// limit as avenSessionCwd (tracked separately, PMR-7ZEE).

export interface FlowWorktree {
  ref: string
  path: string
  branch: string
}

let activeRef: string | null = null
let worktree: FlowWorktree | null = null

/** Set (or clear, null) the active flow ref. Clearing the ref clears the binding. */
export function setActiveFlowRef(ref: string | null): void {
  activeRef = ref
  if (ref === null) {
    worktree = null
  }
}

export function getActiveFlowRef(): string | null {
  return activeRef
}

/** Bind a created worktree to the active flow ref. No-op when no flow runs. */
export function setFlowWorktree(path: string, branch: string): void {
  if (activeRef === null) return
  worktree = { ref: activeRef, path, branch }
}

export function getFlowWorktree(): FlowWorktree | null {
  return worktree
}

/** Drop the worktree binding (e.g. the path no longer exists). Keeps the ref. */
export function clearFlowWorktree(): void {
  worktree = null
}
