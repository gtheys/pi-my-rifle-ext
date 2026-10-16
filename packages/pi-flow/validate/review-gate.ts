// AIDEV-NOTE: Review gate (PMR-JTAM) — the FINAL step of the validate phase.
// After the environment/human gate passes, /review runs on the change and its
// artifact is parsed here. PURE only: no /review invocation, no aven/Jira/git
// I/O — the handoff prompt (validate/prompt.ts) owns all side effects.
//
// AIDEV-NOTE: blockers_count artifact contract (DEFINED HERE — pi-review does
// NOT currently emit it; /review's reviewer output is prose. The validate
// prompt instructs the agent to append the contract line to the review
// artifact, and pi-review should adopt this convention verbatim):
//   - exactly one line matching `blockers_count: <integer >= 0>`
//   - optional blocker descriptions as lines starting with `- blocker: `
// Parsing is STRICT: missing, duplicated, non-integer or negative counts are
// explicit errors — never a silent 0 (a silent 0 would auto-land broken code).

export type LandingRoute = 'pr' | 'push-main'

// AIDEV-NOTE: The exact contract wording handed to the validating agent so
// the artifact it writes matches parseReviewArtifact byte-for-byte.
export const REVIEW_CONTRACT_PROMPT = `   blockers_count: 0
   - blocker: <description> (omit this line entirely when N is 0)`

export type ReviewArtifact =
  | { ok: true; blockersCount: number; blockers: readonly string[] }
  | { ok: false; reason: string }

const COUNT_RE = /^blockers_count:\s*(\d+)\s*$/
const BLOCKER_RE = /^- blocker:\s*(.+)$/

export function parseReviewArtifact(artifact: string): ReviewArtifact {
  const counts: number[] = []
  const blockers: string[] = []
  for (const rawLine of artifact.split('\n')) {
    const line = rawLine.trim()
    const countMatch = COUNT_RE.exec(line)
    if (countMatch !== null) {
      counts.push(Number.parseInt(countMatch[1] as string, 10))
      continue
    }
    const blockerMatch = BLOCKER_RE.exec(line)
    if (blockerMatch !== null) {
      blockers.push((blockerMatch[1] as string).trim())
    }
  }
  if (counts.length === 0) {
    return {
      ok: false,
      reason:
        'review artifact has no "blockers_count: <N>" line — re-run /review and ensure the artifact ends with the count',
    }
  }
  if (counts.length > 1) {
    return {
      ok: false,
      reason: `review artifact has multiple blockers_count lines (${counts.join(', ')}) — exactly one is required`,
    }
  }
  const count = counts[0] as number
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, reason: `invalid blockers_count value: ${count}` }
  }
  return { ok: true, blockersCount: count, blockers }
}

export type ReviewDecision =
  | { route: 'landing'; landing: LandingRoute }
  | { route: 'implement'; blockersNote: string }

// AIDEV-NOTE: Pure gate decision. 0 blockers -> landing route chosen by
// resolveMode (work: PR via pi-review tooling, personal: straight push to
// main — standing no-PR rule on own repos). >0 -> back to /implement with
// the blockers recorded as an aven note (retry budget applies there).
export function decideReviewRoute(
  mode: 'work' | 'personal',
  blockersCount: number,
  blockers: readonly string[] = [],
): ReviewDecision {
  if (blockersCount === 0) {
    if (mode === 'work') {
      return { route: 'landing', landing: 'pr' }
    }
    return { route: 'landing', landing: 'push-main' }
  }
  const listed = blockers.filter((b) => b.length > 0)
  let blockersNote: string
  if (listed.length > 0) {
    blockersNote = `review blockers (${blockersCount}):\n${listed
      .map((b) => `- ${b}`)
      .join('\n')}`
  } else {
    blockersNote = `${blockersCount} review blocker(s) — see the review artifact for details`
  }
  return { route: 'implement', blockersNote }
}
