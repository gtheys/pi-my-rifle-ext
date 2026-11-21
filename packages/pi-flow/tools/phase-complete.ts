// AIDEV-NOTE: PMR-EZHA — the ONLY sanctioned write path for lifecycle
// labels. Reads labels, consults the pure gate (checkPhaseCompletion), and
// on refusal returns the gate reason as a tool error; on success execs the
// same writeAvenLabel path the flow loop uses. Idempotent: an
// already-complete phase returns ok without re-writing.
// AIDEV-NOTE: PMR-3MTZ — the plan phase's fresh write is additionally
// receipt-gated: readGateAnswer(ref, 'spec') must return 'approve' (the
// human's /flow answer receipt) before 'planned' is written; refusal is
// fail-closed like spec_approve (PMR-R5VB). PMR-J6TW: tickets carrying the
// `oneshot` label are EXEMPT — the oneshot route (PMR-3HMZ) never produces
// a receipt by design, so the gate is skipped for them at both check sites
// (here and spec_approve). The fast path stays receipt-free and
// implement/validate/feedback stay label-order-only.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  readAvenLabels,
  readGateAnswer,
  writeAvenLabel,
} from '../aven/client.ts'
import { checkPhaseCompletion } from '../flow/label-gate.ts'
import { PHASE_LABEL, type Phase } from '../flow/orchestrate.ts'
import {
  createReceiptJournal,
  isYoloRun,
  type ReceiptJournal,
} from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { toolResult } from './result.ts'

export interface PhaseCompleteDetails {
  ok: boolean
  refused: boolean
  already: boolean
  reason: string
  label: string
}

// AIDEV-NOTE: PMR-4S6V — best-effort receipt write shared by the fresh and
// already-complete paths; a journal failure never fails the tool result.
async function recordPhaseReceipt(
  receipts: ReceiptJournal,
  ref: string,
  phase: Phase,
): Promise<void> {
  await receipts
    .record({ ref, command: 'flow_phase_complete', target: phase })
    .catch(() => {
      // best-effort — journal failures never fail the tool result
    })
}

// AIDEV-NOTE: PMR-4S6V — receipts defaults to the real run-journal-backed
// journal so index.ts stays untouched. record is best-effort: a journal
// failure must never turn a successful gate transition into a tool error
// (ISC-8). Receipts are journaled on BOTH the fresh-write success path and
// the already-complete fast path (ISC-5 divergence window), never on the
// refusal/failure paths.
export function registerPhaseCompleteTool(
  pi: ExtensionAPI,
  receipts: ReceiptJournal = createReceiptJournal(getAgentDir()),
  // AIDEV-NOTE: PMR-XTQQ — mode-aware writer (server/writer.ts). Present =
  // receipt writes route through it (journal-only while the daemon owns the
  // projection); absent = today's exact full-writer behavior.
  writer?: EventWriter,
  // AIDEV-NOTE: yolo plan 3.1 — injectable for tests; production default
  // reads the real run projection (fail-closed).
  isYoloRunFn: (ref: string) => Promise<boolean> = isYoloRun,
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
    name: 'flow_phase_complete',
    label: 'flow phase complete',
    description:
      'Record completion of a PIV flow phase by applying its lifecycle label (plan=planned, implement=active, validate=review-passed, feedback=done). The gate re-checks phase order and refuses out-of-order completion with the reason; the plan phase additionally refuses until the human ran /flow answer <ref> approve — except for tickets carrying the oneshot label, which complete plan receipt-free. This is the ONLY way to write lifecycle labels — direct aven label edits on the ticket are blocked.',
    promptSnippet:
      'Gated lifecycle-label completion for PIV flow phases (plan/implement/validate/feedback).',
    promptGuidelines: [
      'Call flow_phase_complete to close a flow phase — never run `aven edit <ref> --label <lifecycle>` yourself; that mutation is blocked.',
      'A refusal carries the gate reason (missing prior phase); run the missing phase, do not retry the call.',
      'The plan phase additionally requires a human approval receipt: flow_phase_complete(plan) refuses until the human ran `/flow answer <ref> approve`. On that refusal, tell the human to run `/flow answer <ref> approve`, then re-call flow_phase_complete once the receipt exists — never fake or bypass it with raw aven commands. Tickets carrying the `oneshot` label skip this receipt gate entirely (the oneshot route never produces a receipt) — call flow_phase_complete right away for oneshots.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      phase: Type.Union(
        [
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
        await recordPhaseReceipt(effectiveReceipts, params.ref, params.phase)
        return toolResult(
          `flow_phase_complete: "${label}" already recorded on ${params.ref} — phase ${params.phase} was already complete`,
          { ok: true, refused: false, already: true, reason: '', label },
        )
      }
      // AIDEV-NOTE: PMR-3MTZ / PMR-J6TW — plan-phase receipt gate (fail-closed, the
      // spec_approve PMR-R5VB pattern): the fresh write of 'planned' must be
      // preceded by a human approval receipt (readGateAnswer(ref, 'spec') ===
      // 'approve') — EXCEPT when the labels read above contains `oneshot`
      // (PMR-J6TW): the oneshot route (PMR-3HMZ) never produces a receipt by
      // design, so the exemption keys on the label alone and the write
      // proceeds right after the human size confirmation. The labels read
      // stays fail-closed: a read failure refuses before this block for
      // every route. null covers both an absent spec-answer metadata block
      // and an aven read failure; 'reject' or any other choice refuses too.
      // The already-complete fast path below stays receipt-free (PMR-4S6V
      // idempotency), and implement/validate/feedback remain
      // label-order-only.
      // AIDEV-NOTE: PMR-ZWX8 — the oneshot exemption is a PROMPT-LEVEL
      // checkpoint by accepted design: the `oneshot` label is agent-writable
      // (type labels are deliberately outside lifecycleLabelMutation), and
      // the human's explicit oneshot route invocation IS the size
      // confirmation — adding the label by hand is that same decision.
      // Interception of `--label oneshot` bash edits was considered and
      // REJECTED: a ref-scoped matcher duplicates fragile CLI parsing (the
      // PMR-5RFR/PMR-SB3H matcher-evasion treadmill) and cannot cover
      // `aven add --label oneshot`, the legitimate human-directed oneshot
      // setup path, without blocking unrelated filings whenever any flow is
      // active. Residual risk is bounded: this exemption only fires in
      // personal mode where the human drives the session, and aven's ticket
      // history makes a rogue self-label auditable after the fact. Revisit
      // this seam if the trust model ever needs enforced label provenance.
      // AIDEV-NOTE: yolo plan 3.1 — third exemption path beside the oneshot
      // label (PMR-ZWX8): input.yolo === true is journaled by the run server
      // from the human's CLI invocation (--yolo), not from any agent-writable
      // label or metadata, so a yolo ref cannot be self-granted by the agent
      // and may complete the plan write without the approval receipt. The
      // isYoloRun read is fail-closed (absent projection / read failure =
      // not yolo → full gate). The receiptMetadataMutation bash interceptor
      // in index.ts stays untouched: the exemption is this explicit branch
      // in the gate check, never a forged receipt.
      if (
        params.phase === 'plan' &&
        !labels.includes('oneshot') &&
        !(await isYoloRunFn(params.ref))
      ) {
        const answer = await readGateAnswer(params.ref, 'spec')
        if (answer !== 'approve') {
          let found: string
          if (answer === null) {
            found = 'none/unreadable'
          } else {
            found = answer
          }
          const text = `flow_phase_complete refused: no human approval receipt for plan on ${params.ref} — the human must run /flow answer ${params.ref} approve (human-only slash command; the receipt is the exact-ref-guarded aven spec-answer metadata). Found: ${found}. After the human answers, re-call flow_phase_complete.`
          return toolResult(
            text,
            {
              ok: false,
              refused: true,
              already: false,
              reason: text,
              label: '',
            },
            { isError: true },
          )
        }
      }
      const written = await writeAvenLabel(params.ref, label)
      if (!written) {
        return toolResult(
          `flow_phase_complete: aven write failed for "${label}" on ${params.ref}`,
          { ok: false, refused: false, already: false, reason: '', label: '' },
          { isError: true },
        )
      }
      // AIDEV-NOTE: PMR-4S6V — journal the receipt only after the label write succeeded;
      // best-effort, never fails the ok result.
      await recordPhaseReceipt(effectiveReceipts, params.ref, params.phase)
      return toolResult(
        `flow_phase_complete: "${label}" landed on ${params.ref} — phase ${params.phase} recorded, the label is verified by this result`,
        { ok: true, refused: false, already: false, reason: '', label },
      )
    },
  })
}
