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
// gate pass for the ref (set ONLY by the code_review tool). Write-only here:
// the flow_land CHECK that reads it is sibling ticket PMR-C6AK.
export interface LandingState {
  authorized: string | null
  humanReviewPassed: string | null
}

export function createLandingState(): LandingState {
  return { authorized: null, humanReviewPassed: null }
}

export function registerLandTool(pi: ExtensionAPI, state: LandingState): void {
  pi.registerTool({
    name: 'flow_land',
    label: 'flow land',
    description:
      'Gate a flow landing: verifies the review-passed label (and an optional review artifact verdict) for the ref, then authorizes git push (route=push-main) or gh pr create (route=pr) for it. Direct git push / gh pr create before this tool returns ok are blocked while the flow is active.',
    promptSnippet:
      'Gated landing for PIV flow runs — call before pushing the branch or creating the PR.',
    promptGuidelines: [
      'Call flow_land AFTER flow_phase_complete(phase="validate") and BEFORE git push / gh pr create — direct landing commands are blocked until it returns ok.',
      'A refusal carries the gate reason (missing review-passed label, blockers in the artifact); fix the cause, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      route: Type.Union([Type.Literal('pr'), Type.Literal('push-main')], {
        description:
          'pr: create a PR via gh (work mode). push-main: push straight to main (personal mode).',
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
        route: 'pr' | 'push-main'
        artifact?: string
      },
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      const labels = await readAvenLabels(params.ref)
      const decision = landDecision(labels, params.artifact ?? null)
      if (!decision.ok) {
        return toolResult(
          `flow_land refused landing ${params.ref} via ${params.route}: ${decision.reason}`,
          { ok: false, reason: decision.reason },
          { isError: true },
        )
      }
      state.authorized = params.ref
      return toolResult(
        `flow_land: landing for ${params.ref} authorized via ${params.route} — run the git push / gh pr create step now`,
        { ok: true, reason: '' },
      )
    },
  })
}
