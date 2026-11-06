// AIDEV-NOTE: Gate integrity (PMR-6EEW, observability plan Phase 6 / M7) —
// pin the exact bytes every gate judges, then verify the verifier with
// string compares. A gate (review / deviation / code-review) that silently
// reviews the WRONG diff emits a green promise-shaped object, which is worse
// than a failing gate: nothing downstream can tell. The fix is not better
// prompts — it is making the target of every gate a pinned, hash-verified
// artifact. PURE only: no git, no journal, no spawn I/O. Wiring lives at the
// tool boundary (tools/deviation.ts and later the review gates); journal
// events live in run-state.ts.

import { createHash } from 'node:crypto'
import type { Exec } from '../shared/diff-base.ts'

export type GateKind = 'review' | 'deviation' | 'code-review' | 'spec-review'

/** The pinned target of one gate run: which bytes it was spawned to judge. */
export interface GateTarget {
  gate: GateKind
  ref: string
  baseSha: string
  headSha: string
  /** sha256 of the exact `git diff base..head` bytes handed to the reviewer. */
  diffSha256: string
}

const SHA_RE = /^[0-9a-f]{40}$/

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// AIDEV-NOTE: full 40-hex SHAs only. Short SHAs would make the echo compare
// ambiguous (two distinct commits sharing a prefix must never compare equal).
export function isFullSha(value: string): boolean {
  return SHA_RE.test(value)
}

/**
 * Build the pinned target for a gate spawn. Rejects malformed SHAs rather
 * than pinning garbage — a target with a bad SHA can never be echoed back.
 */
export function buildGateTarget(input: {
  gate: GateKind
  ref: string
  baseSha: string
  headSha: string
  diff: string
}): GateTarget | { ok: false; reason: string } {
  if (!isFullSha(input.baseSha)) {
    return {
      ok: false,
      reason: `baseSha is not a full 40-hex SHA: '${input.baseSha}'`,
    }
  }
  if (!isFullSha(input.headSha)) {
    return {
      ok: false,
      reason: `headSha is not a full 40-hex SHA: '${input.headSha}'`,
    }
  }
  if (input.baseSha === input.headSha) {
    return { ok: false, reason: 'empty range: baseSha == headSha' }
  }
  if (input.ref.length === 0) {
    return { ok: false, reason: 'ref is empty' }
  }
  return {
    gate: input.gate,
    ref: input.ref,
    baseSha: input.baseSha,
    headSha: input.headSha,
    diffSha256: sha256Hex(input.diff),
  }
}

/**
 * Deterministic id for a gate target: first 12 hex of the sha256 over the
 * canonical target parts. Deterministic on purpose — replaying the same
 * journal produces the same ids, so a decision can always cite its target.
 */
export function gateTargetId(target: GateTarget): string {
  return sha256Hex(
    `${target.ref}|${target.gate}|${target.baseSha}|${target.headSha}|${target.diffSha256}`,
  ).slice(0, 12)
}

// AIDEV-NOTE: Echo contract. The gate prompt tells the reviewer to emit ONE
// line `reviewed_range: <baseSha>..<headSha>` in its verdict section, copied
// from the pinned range in its prompt. The harness compares that line against
// the pinned target character by character BEFORE any finding is read.
export const ECHO_LINE_PREFIX = 'reviewed_range:'

export function reviewedRangeLine(target: GateTarget): string {
  return `${ECHO_LINE_PREFIX} ${target.baseSha}..${target.headSha}`
}

const ECHO_RE = /^reviewed_range:\s*([0-9a-f]{40})\.\.([0-9a-f]{40})$/

export interface ReviewedRange {
  baseSha: string
  headSha: string
}

/**
 * Extract the reviewed_range echo from a gate artifact. LAST matching line
 * wins (same preference as the verdict parsers: canonical emitters write it
 * once at the end). Null when absent.
 */
export function extractReviewedRange(artifact: string): ReviewedRange | null {
  let found: ReviewedRange | null = null
  for (const rawLine of artifact.split('\n')) {
    const line = rawLine.trim()
    const match = ECHO_RE.exec(line)
    if (match !== null) {
      found = {
        baseSha: match[1] as string,
        headSha: match[2] as string,
      }
    }
  }
  return found
}

// 'fail' covers harness-side failures (e.g. HEAD cannot be re-resolved) —
// the gate could not be verified at all, which is never a pass.
export type GateStatus =
  | 'pass'
  | 'echo-missing'
  | 'target-mismatch'
  | 'stale'
  | 'fail'

export type GateVerification =
  | { ok: true; status: 'pass' }
  | { ok: false; status: GateStatus; reason: string }

/**
 * Verify a gate result against its pinned target, in the order the plan
 * fixes: echo FIRST (a reviewer that looked at the wrong work can never
 * pass, no matter how good its review reads), staleness SECOND (a verdict
 * applies only to the exact bytes it was pinned to).
 */
export function verifyGateResult(input: {
  target: GateTarget
  artifact: string
  /** HEAD re-resolved AFTER the gate returned. */
  currentHeadSha: string
}): GateVerification {
  const echo = extractReviewedRange(input.artifact)
  if (echo === null) {
    return {
      ok: false,
      status: 'echo-missing',
      reason:
        'gate artifact has no "reviewed_range: <base>..<head>" line — the reviewer did not echo its pinned target; re-run the gate',
    }
  }
  if (
    echo.baseSha !== input.target.baseSha ||
    echo.headSha !== input.target.headSha
  ) {
    return {
      ok: false,
      status: 'target-mismatch',
      reason: `gate reviewed the wrong range: echoed ${echo.baseSha.slice(0, 9)}..${echo.headSha.slice(0, 9)} but was pinned to ${input.target.baseSha.slice(0, 9)}..${input.target.headSha.slice(0, 9)}`,
    }
  }
  if (input.currentHeadSha !== input.target.headSha) {
    return {
      ok: false,
      status: 'stale',
      reason: `gate verdict is stale: HEAD moved to ${input.currentHeadSha.slice(0, 9)} while the gate judged ${input.target.headSha.slice(0, 9)} — re-run the gate on the new range`,
    }
  }
  return { ok: true, status: 'pass' }
}

export interface GateDecisionRecord {
  gate: GateKind
  targetId: string
  status: GateStatus | 'fail'
}

/**
 * Exec-backed delivery check shared by every wired gate: re-resolve HEAD for
 * the staleness recheck, then verify echo + staleness against the pin. Exec
 * is injected (type-only import) so tests never touch a real repo.
 */
export async function verifyGateWithExec(
  exec: Exec,
  cwd: string,
  target: GateTarget,
  artifact: string,
): Promise<GateVerification> {
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd })
  if (head.code !== 0 || head.stdout.trim() === '') {
    return {
      ok: false,
      status: 'fail',
      reason: `cannot re-resolve HEAD for staleness check in ${cwd}: ${head.stderr ?? ''}`,
    }
  }
  return verifyGateResult({
    target,
    artifact,
    currentHeadSha: head.stdout.trim(),
  })
}

/**
 * Orchestrator discipline (plan item 5): every gate decision must cite the
 * gate_target id it applied. A decision citing an unknown target id is
 * invalid state, surfaced like a coverage flag — never silently accepted.
 */
export function validateDecisionCitation(
  decision: GateDecisionRecord,
  knownTargets: readonly GateTarget[],
): { ok: true; target: GateTarget } | { ok: false; reason: string } {
  const cited = knownTargets.find((t) => gateTargetId(t) === decision.targetId)
  if (cited === undefined) {
    return {
      ok: false,
      reason: `gate decision cites unknown gate_target id '${decision.targetId}' (gate '${decision.gate}') — the decision is invalid state`,
    }
  }
  if (cited.gate !== decision.gate) {
    return {
      ok: false,
      reason: `gate decision cites target of gate '${cited.gate}' but claims gate '${decision.gate}'`,
    }
  }
  return { ok: true, target: cited }
}
