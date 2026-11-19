// AIDEV-NOTE: spec_approve (PMR-MR36 fix round). Agent-callable wrapper
// around approveSpec — the injected /spec-review prompt used to make the
// model run a raw `aven edit`, losing loud failure and the workspace pin.
// Workspace resolution mirrors the spec commands (resolveSpecWorkspace in
// aven/client.ts); failure is a loud tool error, never a silent no-op.
// PMR-R5VB: prompt guidelines alone were not model-proof, so the model-call
// path is gated on a human answer receipt: readGateAnswer must return
// 'approve' before any aven edit. That GATE receipt is read-only here — it
// is never consumed or cleared; its only use is the gate check itself. The
// separate JOURNAL receipt is different (PMR-CD46): recorded best-effort
// after a successful approval and adopted on later runs for dedup.
// PMR-J6TW: tickets carrying the `oneshot` label skip the receipt gate
// entirely — the oneshot route (PMR-3HMZ) never produces a receipt by
// design. A failed labels read is NOT a new failure mode: it falls through
// to the legacy gate, mirroring approveSpec's own oneshot check.
// AIDEV-NOTE: PMR-CD46 — single-use dedup realized via receipt adoption:
// a stored {ref, command:'spec_approve', target:'plan'} receipt (recorded
// best-effort after a prior successful approval, PMR-4S6V machinery) is
// adopted FIRST, before the human gate — a stored receipt can only exist
// because a prior human-gated approval succeeded, so adoption short-circuits
// even if the spec-answer metadata was later cleared. Missing/corrupt
// receipts fall forward to the gate + fresh edit exactly as before; journal
// failures never block an approval.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readAvenLabels, readGateAnswer, specApprove } from '../aven/client.ts'
import { createReceiptJournal, type ReceiptJournal } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { toolResult } from './result.ts'

// AIDEV-NOTE: PMR-CD46 — best-effort receipt write; a journal failure never
// fails the tool result, mirroring recordPhaseReceipt (PMR-4S6V).
async function recordSpecReceipt(receipts: ReceiptJournal, ref: string) {
  await receipts
    .record({ ref, command: 'spec_approve', target: 'plan' })
    .catch(() => {
      // best-effort — journal failures never fail the tool result
    })
}

// AIDEV-NOTE: PMR-CD46 — signature mirrors registerPhaseCompleteTool
// (PMR-4S6V/PMR-XTQQ): receipts defaults to the real run-journal-backed
// journal so callers stay untouched; optional mode-aware writer routes
// receipt writes journal-only while the daemon owns the projection.
export function registerSpecApproveTool(
  pi: ExtensionAPI,
  receipts: ReceiptJournal = createReceiptJournal(getAgentDir()),
  writer?: EventWriter,
): void {
  let effectiveReceipts = receipts
  if (writer !== undefined) {
    effectiveReceipts = createReceiptJournal(
      getAgentDir(),
      undefined,
      writer.record,
    )
  }
  pi.registerTool({
    name: 'spec_approve',
    label: 'spec approve',
    description:
      'Approve a spec under review: pins it to the plan label, sets plan-state=approved, moves it to todo. This is the ONLY way to approve a spec — never run `aven edit <ref> --metadata plan-state=approved` yourself. Tickets carrying the oneshot label skip the receipt gate. After this returns ok, call the spec_publish tool with the same ref.',
    promptSnippet:
      'Approval transition for specs in plan-state=review — call instead of raw aven edits.',
    promptGuidelines: [
      'Only call spec_approve when the user explicitly said "approve <REF>" — never without that explicit word, and only for the ref they named — and only after the human ran `/flow answer <ref> approve` (the tool refuses without that receipt; tickets carrying the `oneshot` label skip this receipt).',
      'After spec_approve returns ok, call the spec_publish tool with that ref (never the /spec-publish slash command — agents cannot run slash commands). On a tool error, report the reason to the user — do not retry with raw aven commands. If spec_approve refuses with "no human approval receipt", tell the human to run `/flow answer <ref> approve`, then re-call spec_approve once the receipt exists.',
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
      // AIDEV-NOTE: PMR-CD46 — receipt adoption comes FIRST: a stored
      // receipt implies a prior human-gated approval succeeded, so the
      // dedup check safely short-circuits the gate and the aven edit.
      const stored = await effectiveReceipts.find({
        ref: params.ref,
        command: 'spec_approve',
        target: 'plan',
      })
      if (stored !== null) {
        const text = `spec_approve: ${params.ref} was already approved — adopting the stored approval receipt; the aven edit was skipped. Proceed to spec_publish.`
        return toolResult(text, { ok: true, reason: 'adopted' })
      }
      // PMR-R5VB receipt gate: fail closed. null covers both a missing
      // spec-answer metadata block and an aven read failure; 'reject' and
      // any non-'approve' choice refuse too. Workspace threading matches
      // specApprove/approveSpec.
      // AIDEV-NOTE: PMR-J6TW — oneshot exemption: a ticket carrying the
      // `oneshot` label skips this gate entirely (the oneshot route
      // PMR-3HMZ never produces a receipt). The labels read is best-effort
      // here: null (read failure) falls through to the legacy gate, the
      // same omission-optimization pattern as approveSpec's oneshot check.
      const labels = await readAvenLabels(params.ref)
      const isOneshot = labels?.includes('oneshot') === true
      if (!isOneshot) {
        const answer = await readGateAnswer(
          params.ref,
          'spec',
          params.workspace,
        )
        if (answer !== 'approve') {
          let found: string
          if (answer === null) {
            found = 'none/unreadable'
          } else {
            found = answer
          }
          const text = `spec_approve refused: no human approval receipt for ${params.ref} — the human must run /flow answer ${params.ref} approve (human-only slash command; the receipt is the exact-ref-guarded aven spec-answer metadata). Found: ${found}. After the human answers, re-call spec_approve.`
          return toolResult(
            text,
            { ok: false, reason: text },
            {
              isError: true,
            },
          )
        }
      }
      const result = await specApprove(params)
      if (!result.ok) {
        return toolResult(
          result.text,
          { ok: false, reason: result.text },
          { isError: true },
        )
      }
      // AIDEV-NOTE: PMR-CD46 — journal-after-success only (mirrors
      // phase-complete): never recorded on refusal/failure paths, so a
      // stored receipt always proves a committed approval.
      await recordSpecReceipt(effectiveReceipts, params.ref)
      return toolResult(result.text, { ok: true, reason: '' })
    },
  })
}
