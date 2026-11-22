// AIDEV-NOTE: PMR-Y6YP — extracted from tools/code-review.ts to break the
// land.ts <-> code-review.ts module cycle (code-review.ts imports
// defaultResolveHead from land.ts; land.ts needs productionReviewDeps).
// This module is a LEAF: it must never import from land.ts or
// code-review.ts.
import { existsSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import { worktreeList } from '../worktree/herdr.ts'
import type { ReviewDeps } from './code-review-parse.ts'

// AIDEV-NOTE: PMR-0KMQ — shared factory: the fresh-context review gate
// (review/review.ts, commit mode) and the deviation gate (tools/deviation.ts)
// reuse this exact wiring so all three gates resolve the same VERIFIED bound
// flow worktree (resolveReviewWorktree: binding → aven note → herdr, each
// candidate verified via common-git-dir + branch). Takes a bare repoRoot
// instead of the tool context so non-code-review callers can pass ctx.cwd.
export function productionReviewDeps(
  pi: ExtensionAPI,
  repoRoot: string,
): ReviewDeps {
  return {
    getFlowWorktree,
    avenShowFull: async (ref: string) => {
      const result = await pi.exec('aven', ['show', ref, '--full'], {
        cwd: repoRoot,
      })
      if (result.code !== 0) {
        throw new Error(result.stderr || `aven show ${ref} failed`)
      }
      return result.stdout
    },
    herdrWorktreeList: () => worktreeList(pi, repoRoot),
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      const result = await pi.exec(cmd, args, {
        cwd: opts?.cwd ?? repoRoot,
      })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
    exists: (p: string) => existsSync(p),
    repoRoot,
  }
}
