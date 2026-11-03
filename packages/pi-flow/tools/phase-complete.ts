// AIDEV-NOTE: PMR-EZHA — the ONLY sanctioned write path for lifecycle
// labels. Reads labels, consults the pure gate (checkPhaseCompletion), and
// on refusal returns the gate reason as a tool error; on success execs the
// same writeAvenLabel path the flow loop uses. Idempotent: an
// already-complete phase returns ok without re-writing.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readAvenLabels, writeAvenLabel } from '../aven/client.ts'
import { checkPhaseCompletion } from '../flow/label-gate.ts'
import { PHASE_LABEL, type Phase } from '../flow/orchestrate.ts'
import { toolResult } from './result.ts'

export interface PhaseCompleteDetails {
  ok: boolean
  refused: boolean
  already: boolean
  reason: string
  label: string
}

export function registerPhaseCompleteTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'flow_phase_complete',
    label: 'flow phase complete',
    description:
      'Record completion of an RPIV flow phase by applying its lifecycle label (research=researched, plan=planned, implement=active, validate=review-passed, feedback=done). The gate re-checks phase order and refuses out-of-order completion with the reason. This is the ONLY way to write lifecycle labels — direct aven label edits on the ticket are blocked.',
    promptSnippet:
      'Gated lifecycle-label completion for RPIV flow phases (research/plan/implement/validate/feedback).',
    promptGuidelines: [
      'Call flow_phase_complete to close a flow phase — never run `aven edit <ref> --label <lifecycle>` yourself; that mutation is blocked.',
      'A refusal carries the gate reason (missing prior phase); run the missing phase, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      phase: Type.Union(
        [
          Type.Literal('research'),
          Type.Literal('plan'),
          Type.Literal('implement'),
          Type.Literal('validate'),
          Type.Literal('feedback'),
        ],
        {
          description: 'The flow phase being marked complete',
        },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: string; phase: Phase },
    ): Promise<AgentToolResult<PhaseCompleteDetails>> {
      const labels = await readAvenLabels(params.ref)
      if (labels === null) {
        return toolResult(
          `flow_phase_complete: cannot read aven labels for ${params.ref} (fail-closed)`,
          { ok: false, refused: false, already: false, reason: '', label: '' },
          { isError: true },
        )
      }
      const gate = checkPhaseCompletion(params.phase, labels)
      if (!gate.ok) {
        return toolResult(
          `flow_phase_complete refused phase "${params.phase}" on ${params.ref}: ${gate.reason}`,
          {
            ok: false,
            refused: true,
            already: false,
            reason: gate.reason ?? '',
            label: '',
          },
          { isError: true },
        )
      }
      const label = PHASE_LABEL[params.phase]
      if (labels.includes(label)) {
        return toolResult(
          `flow_phase_complete: "${label}" already recorded on ${params.ref} — phase ${params.phase} was already complete`,
          { ok: true, refused: false, already: true, reason: '', label },
        )
      }
      const written = await writeAvenLabel(params.ref, label)
      if (!written) {
        return toolResult(
          `flow_phase_complete: aven write failed for "${label}" on ${params.ref}`,
          { ok: false, refused: false, already: false, reason: '', label: '' },
          { isError: true },
        )
      }
      return toolResult(
        `flow_phase_complete: "${label}" landed on ${params.ref} — phase ${params.phase} recorded, the label is verified by this result`,
        { ok: true, refused: false, already: false, reason: '', label },
      )
    },
  })
}
