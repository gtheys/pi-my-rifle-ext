// AIDEV-NOTE: spec_approve (PMR-MR36 fix round). Agent-callable wrapper
// around approveSpec — the injected /spec-review prompt used to make the
// model run a raw `aven edit`, losing loud failure and the workspace pin.
// Workspace resolution mirrors the spec commands (resolveSpecWorkspace in
// aven/client.ts); failure is a loud tool error, never a silent no-op.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { specApprove } from '../aven/client.ts'
import { toolResult } from './result.ts'

export function registerSpecApproveTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'spec_approve',
    label: 'spec approve',
    description:
      'Approve a spec under review: pins it to the plan label, sets plan-state=approved, moves it to todo. This is the ONLY way to approve a spec — never run `aven edit <ref> --metadata plan-state=approved` yourself. After this returns ok, call the spec_publish tool with the same ref.',
    promptSnippet:
      'Approval transition for specs in plan-state=review — call instead of raw aven edits.',
    promptGuidelines: [
      'Only call spec_approve when the user explicitly said "approve <REF>" — never without that explicit word, and only for the ref they named.',
      'After spec_approve returns ok, call the spec_publish tool with that ref (never the /spec-publish slash command — agents cannot run slash commands). On a tool error, report the reason to the user — do not retry with raw aven commands.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      workspace: Type.Optional(
        Type.String({
          description:
            'Aven workspace name — only when the spec lives outside the default workspace; normally omitted (config/per-ref resolution applies)',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: string; workspace?: string },
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      const result = await specApprove(params)
      if (!result.ok) {
        return toolResult(
          result.text,
          { ok: false, reason: result.text },
          { isError: true },
        )
      }
      return toolResult(result.text, { ok: true, reason: '' })
    },
  })
}
