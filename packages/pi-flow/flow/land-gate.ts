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

// AIDEV-NOTE: PMR-4Y1Z — command position = start, or after any shell
// separator (&& || ; | & newline), a subshell/group opener ( { , a backtick or
// $( — but NOT after a quote, so `echo "git push"` is not a landing. Git
// global options (-C <dir>, -c k=v, --git-dir[=]..., --no-pager, ...) and env
// assignments may sit between the command words. Known limit (guardrail, not
// a privilege boundary): aliases, `sh -c '...'`, and variable-built commands
// are not detected.
const CMD_START = String.raw`(?:^|[;&|(){}\n\x60]|\$\()\s*(?:\w+=\S*\s+)*`
const GIT_OPTS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)\s+\S+|--[\w-]+(?:=\S+)?|-[pP]))*`
const GH_OPTS = String.raw`(?:\s+(?:-R|--repo)\s+\S+)*`
const LANDING_RE = new RegExp(
  `${CMD_START}(?:git${GIT_OPTS}\\s+push|gh${GH_OPTS}\\s+pr\\s+create)\\b`,
)

// Matches bash landing commands (git push / gh pr create) at command
// position (see CMD_START). Returns the active ref the
// block reason should name, or null when the command is allowed. Only called
// while a flow ref is active — never globally.
export function landingBashBlock(
  command: string,
  activeRef: string | null,
): string | null {
  if (activeRef === null) return null
  const landing = LANDING_RE.test(command)
  if (!landing) return null
  return `landing for flow ${activeRef} is gated — call the flow_land tool (ref=${activeRef}); direct git push / gh pr create during a flow run are blocked`
}

// AIDEV-NOTE: PMR-VZEV — pure decision behind the index.ts tool_call
// interceptor. `clear` is true only when an ALLOWED-THROUGH command was a
// landing command while authorized === activeRef: one authorization = one
// landing command, so the caller clears authorized + humanReviewPassed.
export type LandingInterceptDecision =
  | { action: 'allow'; clear: boolean }
  | { action: 'block'; reason: string }

export function landingIntercept(
  command: string,
  activeRef: string | null,
  authorized: string | null,
): LandingInterceptDecision {
  if (activeRef === null) return { action: 'allow', clear: false }
  const reason = landingBashBlock(command, activeRef)
  if (reason === null) return { action: 'allow', clear: false }
  if (authorized === activeRef) return { action: 'allow', clear: true }
  return { action: 'block', reason }
}
