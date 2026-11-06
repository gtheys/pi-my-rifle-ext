import { existsSync } from 'node:fs'

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
let lastWorktree: FlowWorktree | null = null

// AIDEV-NOTE: PMR-PJM0 — module state dies on pi reload/restart. index.ts
// persists every change as a session entry (appendEntry) and replays the last
// one on session_start via restoreFlowBinding.
export interface FlowBindingSnapshot {
  ref: string | null
  worktree: FlowWorktree | null
}
let changeListener: ((snapshot: FlowBindingSnapshot) => void) | null = null

export function setBindingChangeListener(
  fn: ((snapshot: FlowBindingSnapshot) => void) | null,
): void {
  changeListener = fn
}

function notifyChange(): void {
  changeListener?.({ ref: activeRef, worktree })
}

// AIDEV-NOTE: PMR-P2MK — session entry data is untrusted (old/hand-edited
// sessions). Validate before restoring; a bad shape yields null, never a throw.
export function parseFlowBindingSnapshot(
  value: unknown,
): FlowBindingSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.ref !== null && typeof v.ref !== 'string') return null
  const wt = v.worktree
  if (wt === null || wt === undefined) {
    return { ref: v.ref, worktree: null }
  }
  if (typeof wt !== 'object') return null
  const w = wt as Record<string, unknown>
  if (
    typeof w.ref !== 'string' ||
    typeof w.path !== 'string' ||
    typeof w.branch !== 'string'
  ) {
    return null
  }
  return {
    ref: v.ref,
    worktree: { ref: w.ref, path: w.path, branch: w.branch },
  }
}

/** Restore a persisted snapshot. Does not fire the change listener. */
export function restoreFlowBinding(snapshot: FlowBindingSnapshot): void {
  activeRef = snapshot.ref
  worktree = null
  if (snapshot.ref !== null && snapshot.worktree?.ref === snapshot.ref) {
    worktree = snapshot.worktree
  }
}

/** Set (or clear, null) the active flow ref. Clearing the ref clears the binding. */
export function setActiveFlowRef(ref: string | null): void {
  // AIDEV-NOTE: the loop clears the ref on every halt/pause; remember the
  // cleared binding so a rerun can restore it via reactivateFlowRef (PMR-182S).
  if (ref === null && worktree !== null) {
    lastWorktree = worktree
  }
  activeRef = ref
  if (ref === null) {
    worktree = null
  }
  notifyChange()
}

/**
 * Loop entry point for /flow: activate the ref and, when the SAME ref's
 * worktree was dropped by a halt/pause and its path still exists, restore it.
 * Kept separate from setActiveFlowRef so plain activation stays a clean slate.
 */
export function reactivateFlowRef(ref: string): void {
  const remembered = lastWorktree
  setActiveFlowRef(ref)
  if (remembered?.ref === ref && existsSync(remembered.path)) {
    worktree = remembered
    notifyChange()
  }
}

export function getActiveFlowRef(): string | null {
  return activeRef
}

// AIDEV-NOTE: PMR-2424 — a skipped bind used to be silent, so the review tool
// diffed the main checkout and returned a bogus pass. Callers surface this.
export const NO_ACTIVE_FLOW_WARNING =
  'WARNING: no active flow — the worktree was NOT bound to a flow, so review/land gates will not apply to it. Tell the human to run `/flow aven:<ref>` (or `/flow <ref>`) before continuing with implement/validate.'

/**
 * Bind a created worktree to the active flow ref. Returns false (and binds
 * nothing) when no flow runs, so callers can warn instead of failing silently.
 */
export function setFlowWorktree(path: string, branch: string): boolean {
  if (activeRef === null) return false
  worktree = { ref: activeRef, path, branch }
  notifyChange()
  return true
}

export function getFlowWorktree(): FlowWorktree | null {
  return worktree
}

/** Drop the worktree binding (e.g. the path no longer exists). Keeps the ref. */
export function clearFlowWorktree(): void {
  worktree = null
  notifyChange()
}
