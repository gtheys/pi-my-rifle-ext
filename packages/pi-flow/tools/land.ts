// AIDEV-NOTE: PMR-06RH — the ONLY sanctioned landing path for a flow run.
// Re-checks the review gate at the landing boundary via the pure
// landDecision (flow/land-gate.ts): 'review-passed' label required, and when
// the agent supplies the review artifact its blockers_count verdict is
// cross-checked. On ok, the ref's landing is authorized so the subsequent
// git push / gh pr create passes the interceptor. Route is recorded, not
// re-derived: mode detection stays the phase prompts' concern.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readAvenLabels } from '../aven/client.ts'
import { landDecision } from '../flow/land-gate.ts'
import { toolResult } from './result.ts'

// AIDEV-NOTE: shared with the bash tool_call interceptor in index.ts — the
// interceptor refuses git push / gh pr create for the active flow ref until
// this state names it.
// AIDEV-NOTE: PMR-T8ZG — humanReviewPassed records the human code-review
// gate pass for the ref (set ONLY by the code_review tool). The flow_land
// CHECK that reads it lives below (PMR-C6AK) and gates route=merge-main.
// PMR-HYZA: route=merge-main NEVER sets `authorized` — the personal landing
// is a LOCAL ff-only merge into main in the main checkout, so a git push
// stays blocked even after flow_land returns ok. Only route=pr (work mode)
// authorizes git push / gh pr create.
export interface LandingState {
  authorized: string | null
  humanReviewPassed: string | null
}

export function createLandingState(): LandingState {
  return { authorized: null, humanReviewPassed: null }
}

export function registerLandTool(
  pi: ExtensionAPI,
  state: LandingState,
  // AIDEV-NOTE: PMR-VZEV — active-ref getter from the flow loop; null when
  // no flow is in flight (hand-run landing outside a flow is allowed).
  activeRef: () => string | null,
): void {
  pi.registerTool({
    name: 'flow_land',
    label: 'flow land',
    description:
      'Gate a flow landing: verifies the review-passed label (and an optional review artifact verdict) for the ref. route=pr (work) then authorizes git push / gh pr create for it; route=merge-main (personal) does NOT authorize a push — merge the branch into main locally instead. Direct git push / gh pr create are blocked while the flow is active, and stay blocked for route=merge-main.',
    promptSnippet:
      'Gated landing for PIV flow runs — call before pushing the branch or creating the PR.',
    promptGuidelines: [
      'Call flow_land AFTER flow_phase_complete(phase="validate") and BEFORE git push / gh pr create — direct landing commands are blocked until it returns ok.',
      'For route=merge-main (personal), call the code_review tool first — flow_land refuses until the human pass marker for the ref is recorded. After ok, merge locally: git -C <main repo> merge --ff-only <branch> (find the main repo via `git worktree list` first entry). NEVER push.',
      'A refusal carries the gate reason (missing review-passed label, blockers in the artifact, missing human code-review pass); fix the cause, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      route: Type.Union([Type.Literal('pr'), Type.Literal('merge-main')], {
        description:
          'pr: create a PR via gh (work mode). merge-main: merge the branch into main LOCALLY in the main checkout with git -C <main repo> merge --ff-only <branch> — never a push (personal mode).',
      }),
      artifact: Type.Optional(
        Type.String({
          description:
            'The review artifact text (must contain "blockers_count: <N>") — cross-checked when provided',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        route: 'pr' | 'merge-main'
        artifact?: string
      },
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      // AIDEV-NOTE: PMR-C6AK — the human code-review gate check lives here
      // (PMR-T8ZG wrote the field) so behavior flips in one child. Only
      // route=merge-main (personal) requires the marker recorded by the
      // code_review tool for THIS ref; route=pr (work) is unchanged.
      // AIDEV-NOTE: PMR-VZEV — ref validation: a live flow only lands its
      // OWN ref. null = no flow active, the gate does not apply (matches
      // the interceptor, which also stands down without an active ref).
      const flowRef = activeRef()
      if (flowRef !== null && flowRef !== params.ref) {
        return toolResult(
          `flow_land refused landing ${params.ref}: it does not match the active flow ref ${flowRef} — land the active flow's ref, or run outside the flow`,
          { ok: false, reason: 'ref does not match active flow ref' },
          { isError: true },
        )
      }
      if (
        params.route === 'merge-main' &&
        state.humanReviewPassed !== params.ref
      ) {
        return toolResult(
          `flow_land refused landing ${params.ref} via merge-main: the human code-review gate has not passed — call the code_review tool with ref=${params.ref} and collect the human's pass first`,
          { ok: false, reason: 'human code-review gate not passed' },
          { isError: true },
        )
      }
      const labels = await readAvenLabels(params.ref)
      const decision = landDecision(labels, params.artifact ?? null)
      if (!decision.ok) {
        return toolResult(
          `flow_land refused landing ${params.ref} via ${params.route}: ${decision.reason}`,
          { ok: false, reason: decision.reason },
          { isError: true },
        )
      }
      // AIDEV-NOTE: PMR-HYZA — only work mode's PR route releases the
      // interceptor's git push / gh pr create block. merge-main keeps
      // `authorized` null: the landing is a local ff-only merge, never a
      // push, so a git push after ok must stay blocked.
      if (params.route === 'pr') {
        state.authorized = params.ref
        return toolResult(
          `flow_land: landing for ${params.ref} authorized via pr — run the git push / gh pr create step now`,
          { ok: true, reason: '' },
        )
      }
      return toolResult(
        `flow_land: landing for ${params.ref} gated ok via merge-main — merge the branch into main LOCALLY in the main checkout with git -C <main repo> merge --ff-only <branch> (find the main repo path via \`git worktree list\`, first entry). Do not push.`,
        { ok: true, reason: '' },
      )
    },
  })
}
