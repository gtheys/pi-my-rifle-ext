// AIDEV-NOTE: PMR-VDVJ phase 2 — pure effect gate. The validation seam
// (buildEffectDeclaration) lives in run-state.ts since PMR-5ME4 so the
// journal's declare() can enforce it on the production write path without an
// import cycle; this module re-exports it and carries DEFAULT_RECIPES (the
// plain-language undo steps shown to the agent on declaration, ISC-4) and
// MERGE_RE + mergeIntercept — the merge-main twin of land-gate's landing
// matcher and one-shot interceptor (PMR-VZEV). All pure — no fs, no git, no
// clock (timestamp is injected via the `now` parameter for testability).

import type { EffectKind } from '../run-state.ts'
import {
  CMD_START,
  GIT_OPTS,
  type LandingInterceptDecision,
} from './land-gate.ts'

// AIDEV-NOTE: plain-language undo steps per effect kind. These are shown to
// the agent when the effect is declared (ISC-4) so recovery is always at hand.
export const DEFAULT_RECIPES: Record<EffectKind, string[]> = {
  'merge-main': [
    'git -C <main repo> reset --hard ORIG_HEAD — restores main to the commit before the fast-forward (safe: a ff-only merge creates no new commits)',
    'verify: git -C <main repo> log --oneline -3',
  ],
  'git-push': [
    'nothing local to undo — a push moves the remote branch; recover remote-side: git revert <range> on the remote branch, or git push origin --delete <branch> if the push itself was mistaken',
  ],
  'gh-pr-create': [
    'close the PR: gh pr close <number> --delete-branch; if it already merged, git revert the merge on the remote base branch',
  ],
  'worktree-create': [
    'remove the half-created worktree: herdr worktree remove --workspace <id> (or git worktree remove <path>)',
    'clear the pre-recorded flow base: git config --unset flow-base.<branch>',
  ],
  'worktree-remove': [
    're-create it: worktree tool action=create with branch=<branch> (commits live in the shared store — removal alone deletes nothing)',
    're-bind it to the flow: worktree tool action=bind',
  ],
}

// AIDEV-NOTE: command position = start, or after any shell separator, a
// subshell opener, a backtick or $( — but NOT after a quote (same grammar as
// land-gate's CMD_START). The negative lookahead (?![\w-]) is load-bearing
// (ISC-10): git merge-base / merge-file / merge-tree must NEVER match, while
// `git merge`, `git -C /path merge --ff-only x`, `git merge --abort` do.
// Known limit (guardrail, not a privilege boundary, same as land-gate
// PMR-4Y1Z): aliases, `sh -c '...'`, and variable-built commands are not
// detected.
const MERGE_RE = new RegExp(`${CMD_START}git${GIT_OPTS}\\s+merge(?![\\w-])`)

// Matches bash merge commands at command position (see MERGE_RE). Returns the
// active ref the block reason should name, or null when the command is
// allowed. Only called while a flow ref is active — never globally.
export function mergeBashBlock(
  command: string,
  activeRef: string | null,
): string | null {
  if (activeRef === null) return null
  if (!MERGE_RE.test(command)) return null
  return `merge-main for flow ${activeRef} is gated — call the flow_land tool (ref=${activeRef}, route=merge-main); direct git merge during a flow run are blocked`
}

// AIDEV-NOTE: PMR-VZEV mirrored for merge-main — pure decision behind the
// index.ts tool_call interceptor. `clear` is true only when the command
// matches the pinned authorized command exactly AND the authorization was
// issued for the active ref: one authorization = one merge command, so the
// caller clears mergeAuthorized. Any other merge form (different branch,
// path, whitespace) blocks.
export function mergeIntercept(
  command: string,
  activeRef: string | null,
  mergeAuthorized: { ref: string; command: string } | null,
): LandingInterceptDecision {
  if (activeRef === null) return { action: 'allow', clear: false }
  const reason = mergeBashBlock(command, activeRef)
  if (reason === null) return { action: 'allow', clear: false }
  const authorizedForActiveRef =
    mergeAuthorized !== null &&
    mergeAuthorized.ref === activeRef &&
    mergeAuthorized.command === command
  if (authorizedForActiveRef) return { action: 'allow', clear: true }
  return { action: 'block', reason }
}

// AIDEV-NOTE: PMR-5ME4 — buildEffectDeclaration moved to run-state.ts (its
// dependencies — EFFECT_KINDS, effectDeclarationId, runFileName,
// EffectDeclarationRecord, isFullSha — live there or alongside, and the
// journal's declare() must run it on the production write path without an
// import cycle). Re-exported here so the single validation seam stays
// importable from the gate module for tests and future consumers.
export {
  buildEffectDeclaration,
  type EffectDeclarationResult,
} from '../run-state.ts'
