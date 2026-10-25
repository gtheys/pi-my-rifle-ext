// AIDEV-NOTE: Review gate (PMR-JTAM) — the FINAL step of the validate phase.
// After the environment/human gate passes, /review runs on the change and its
// artifact is parsed here. PURE only: no /review invocation, no aven/Jira/git
// I/O — the handoff prompt (validate/prompt.ts) owns all side effects.
//
// AIDEV-NOTE: blockers_count artifact contract (DEFINED HERE — pi-review
// emits it natively since PMR-5PCB: its review rubric ends every /review
// artifact with a "## Verdict" section carrying exactly these lines, via
// pi-review's review/verdict.ts). The validate prompt still restates the
// contract so hand-written artifacts match too:
//   - exactly one line matching `blockers_count: <integer >= 0>`
//   - optional blocker descriptions as lines starting with `- blocker: `
// Parsing is scoped to the verdict section (a fenced block or headed
// section containing the count) so contract text QUOTED elsewhere in the
// review cannot false-positive. Parsing is STRICT: missing, duplicated,
// non-integer or negative counts are explicit errors — never a silent 0 (a
// silent 0 would auto-land broken code).

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

// AIDEV-NOTE: Scopes parsing to the verdict section so a review that merely
// QUOTES the contract (e.g. while discussing the gate) does not double-count.
// Preference order: the LAST fenced block containing a count line, else the
// text after the LAST "## Verdict"-style heading (up to the next heading),
// else the whole artifact (legacy fallback for hand-written artifacts).
export function extractVerdictSection(artifact: string): string {
  const fences = [...artifact.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1]
    if (body !== undefined && /^blockers_count:\s*\d+\s*$/m.test(body)) {
      return body
    }
  }
  const headings = [
    ...artifact.matchAll(/^[ \t]*#{1,6}[ \t]+verdict\b[^\n]*$/gim),
  ]
  const lastHeading = headings[headings.length - 1]
  if (lastHeading !== undefined) {
    const start = (lastHeading.index ?? 0) + lastHeading[0].length
    const rest = artifact.slice(start)
    const nextHeading = /^[ \t]*#{1,6}[ \t]+\S/m.exec(rest)
    if (nextHeading?.index !== undefined) {
      return rest.slice(0, nextHeading.index)
    }
    return rest
  }
  return artifact
}

export function parseReviewArtifact(artifact: string): ReviewArtifact {
  const counts: number[] = []
  const blockers: string[] = []
  for (const rawLine of extractVerdictSection(artifact).split('\n')) {
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
