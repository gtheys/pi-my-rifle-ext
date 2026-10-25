// AIDEV-NOTE: PMR-06RH — pure landing gate consumed by the flow_land tool
// and the bash tool_call interceptor. landDecision re-states the validate
// review gate at the landing boundary: the "review-passed" label (written
// only via flow_phase_complete) is the hard gate; when the agent supplies
// the review artifact, parseReviewArtifact's verdict is cross-checked so a
// labeled-but-blocked landing cannot slip through. landingBashBlock is the
// interceptor matcher for `git push` / `gh pr create` — it blocks ONLY while
// a flow landing context (the loop's active ref) exists; normal git use
// outside a flow run is never touched. Both functions are pure.
import { parseReviewArtifact } from '../validate/review-gate.ts'

export type LandDecision = { ok: true } | { ok: false; reason: string }

export function landDecision(
  labels: readonly string[] | null,
  reviewArtifact: string | null,
): LandDecision {
  if (labels === null) {
    return {
      ok: false,
      reason: 'cannot read aven labels (fail-closed) — landing refused',
    }
  }
  if (!labels.includes('review-passed')) {
    return {
      ok: false,
      reason:
        'ticket has no "review-passed" label — complete the validate phase (flow_phase_complete with phase="validate") before landing',
    }
  }
  if (reviewArtifact !== null) {
    const parsed = parseReviewArtifact(reviewArtifact)
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason }
    }
    if (parsed.blockersCount > 0) {
      return {
        ok: false,
        reason: `review artifact reports ${parsed.blockersCount} blocker(s) — resolve them and re-run /review before landing`,
      }
    }
  }
  return { ok: true }
}

// Matches bash landing commands (git push / gh pr create) at command
// position: start of the command or after && / ;. Returns the active ref the
// block reason should name, or null when the command is allowed. Only called
// while a flow ref is active — never globally.
export function landingBashBlock(
  command: string,
  activeRef: string | null,
): string | null {
  if (activeRef === null) return null
  const landing = /(?:^|&&|;)\s*(?:git\s+push|gh\s+pr\s+create)\b/.test(command)
  if (!landing) return null
  return `landing for flow ${activeRef} is gated — call the flow_land tool (ref=${activeRef}); direct git push / gh pr create during a flow run are blocked`
}
