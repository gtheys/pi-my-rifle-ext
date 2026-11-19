// AIDEV-NOTE: PMR-C998 — advisory posture. flow_submit is an EVIDENCE
// journal, never a gate: it records structured step-output events into the
// run journal and reports warnings, but nothing here blocks or refuses a
// flow phase. flow_phase_complete semantics are unchanged and the lifecycle
// labels remain the gate of record. The only refusal path is malformed
// params (schema enforcement); every verification failure degrades to a
// warning line on an ok result.
// AIDEV-NOTE: PMR-XTQQ — writer seam. When an EventWriter is injected,
// journal writes route through writer.record (journal-only while the daemon
// owns the projection); otherwise we fall back to the direct
// recordRunEvent path. Both are append-only ('step-output' is covered by
// isJournalOnlyEvent in run-state.ts).
// AIDEV-NOTE: PMR-4S6V — headSha pin lineage. When the submission carries a
// headSha, HEAD is resolved via the injected resolveHead (defaulting to
// land.ts's defaultResolveHead — read-only dependency, land.ts is never
// edited here) and headShaVerified is journaled on the event either way, so
// lineage stays auditable even when verification fails.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  buildStepOutputEvent,
  type StepOutputEventPayload,
  type StepOutputFacts,
  type StepOutputInput,
  StepOutputSchema,
} from '../flow/step-output.ts'
import {
  type FlowRunEvent,
  readRunEvents,
  recordRunEvent,
} from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { defaultResolveHead } from './land.ts'
import { toolResult } from './result.ts'

export interface FlowSubmitDetails {
  ok: boolean
  journaled: boolean
  headShaVerified?: boolean
  unknownGateTargetIds?: string[]
}

export interface FlowSubmitDeps {
  writer?: EventWriter
  resolveHead?: () => Promise<string | null>
  readEvents?: (ref: string) => Promise<FlowRunEvent[] | null>
}

/** Gate-target ids cited by prior gate-target events for this ref. */
function citedGateTargetIds(events: FlowRunEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.kind === 'gate-target') {
      ids.add(event.targetId)
    }
  }
  return ids
}

// AIDEV-NOTE: PMR-4S6V — headSha pin: resolve HEAD and journal the
// verification outcome either way; unresolvable HEAD is a warning, never a
// refusal. Appends warnings and mutates event/details in place.
async function verifyHeadSha(
  event: StepOutputEventPayload,
  details: FlowSubmitDetails,
  warnings: string[],
  resolveHead: () => Promise<string | null>,
): Promise<void> {
  if (event.headSha === undefined) return
  const head = await resolveHead()
  let verified: boolean
  if (head === null) {
    verified = false
    warnings.push(
      `could not resolve HEAD — headShaVerified journaled as false for ${event.headSha}`,
    )
  } else if (head !== event.headSha) {
    verified = false
    warnings.push(
      `headSha mismatch — submitted ${event.headSha}, HEAD is ${head}; headShaVerified journaled as false`,
    )
  } else {
    verified = true
  }
  event.headShaVerified = verified
  details.headShaVerified = verified
}

// AIDEV-NOTE: PMR-C998 — gate-target membership check (validate phase):
// cited ids must appear as prior gate-target targetIds. An unreadable
// journal is a "cannot verify" warning, never a refusal (advisory posture).
async function verifyGateTargets(
  event: StepOutputEventPayload,
  ref: string,
  details: FlowSubmitDetails,
  warnings: string[],
  readEvents: (r: string) => Promise<FlowRunEvent[] | null>,
): Promise<void> {
  if (event.gateTargetIds === undefined) return
  const events = await readEvents(ref)
  if (events === null) {
    warnings.push(
      'could not read the run journal — cited gateTargetIds could not be verified',
    )
    return
  }
  const known = citedGateTargetIds(events)
  const unknown = event.gateTargetIds.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    details.unknownGateTargetIds = unknown
    warnings.push(
      `unknown gateTargetIds (no matching gate-target events for ${ref}): ${unknown.join(', ')}`,
    )
  }
}

// AIDEV-NOTE: PMR-C998 / PMR-XTQQ — best-effort journal write: a failure
// degrades to journaled:false + warning; the result stays ok. Injected
// writer wins; absence keeps the direct recordRunEvent path so index.ts
// stays untouched (subtask 2.4 owns wiring).
async function journalEvent(
  event: StepOutputEventPayload,
  writer: EventWriter | undefined,
): Promise<boolean> {
  try {
    if (writer !== undefined) {
      await writer.record(event)
    } else {
      await recordRunEvent(getAgentDir(), event)
    }
    return true
  } catch {
    return false
  }
}

// AIDEV-NOTE: human-readable recap of the per-phase facts for the result
// text; mirrors StepOutputSchema's optional fields phase by phase.
function factsSummary(output: StepOutputFacts): string {
  const parts: string[] = []
  if (output.phase === 'plan') {
    if (output.planPath !== undefined) parts.push(`planPath=${output.planPath}`)
    if (output.subtaskRefs !== undefined) {
      parts.push(`subtaskRefs=${output.subtaskRefs.join(',')}`)
    }
  }
  if (output.phase === 'implement') {
    if (output.command !== undefined) parts.push(`command=${output.command}`)
    if (output.passed !== undefined) parts.push(`passed=${output.passed}`)
    if (output.headSha !== undefined) parts.push(`headSha=${output.headSha}`)
  }
  if (output.phase === 'validate') {
    if (output.prNumber !== undefined) parts.push(`prNumber=${output.prNumber}`)
    if (output.prUrl !== undefined) parts.push(`prUrl=${output.prUrl}`)
    if (output.gateTargetIds !== undefined) {
      parts.push(`gateTargetIds=${output.gateTargetIds.join(',')}`)
    }
  }
  if (output.phase === 'feedback') {
    if (output.prUrl !== undefined) parts.push(`prUrl=${output.prUrl}`)
    if (output.prMerged !== undefined) parts.push(`prMerged=${output.prMerged}`)
  }
  if (parts.length === 0) {
    return 'no facts'
  }
  return parts.join(', ')
}

export function registerFlowSubmitTool(
  pi: ExtensionAPI,
  deps: FlowSubmitDeps = {},
): void {
  const writer = deps.writer
  const resolveHead = deps.resolveHead
  const readEvents = deps.readEvents
  pi.registerTool({
    name: 'flow_submit',
    label: 'flow submit',
    description:
      'Journal structured evidence for a flow step boundary (per-phase facts: plan paths and subtask refs, test commands and pass state, HEAD SHA, PR number/URL, cited gate-target ids). Advisory only: this NEVER gates completion and flow_phase_complete semantics are unchanged — the lifecycle labels remain the gate of record. Verification failures (SHA mismatch, unknown cited ids, unresolvable HEAD, journal write failure) surface as warnings on an ok result; only malformed params are refused.',
    promptSnippet:
      'Advisory step-evidence journaling for PIV flows (plan/implement/validate/feedback).',
    promptGuidelines: [
      'Call flow_submit after each meaningful step boundary: a written plan (planPath, subtaskRefs), a test or verification run (command, passed, headSha), a PR or gate-relevant check (prNumber, prUrl, gateTargetIds), or a merge outcome (prUrl, prMerged).',
      'flow_submit is advisory: it journals evidence but never gates completion — flow_phase_complete semantics are unchanged and the lifecycle labels are the gate of record. A warned submission never blocks a phase.',
      'Include gateTargetIds on validate submissions to cite the gate targets the evidence covers; unknown ids come back as warnings — fix the ids or proceed, the labels decide.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      step: Type.String({
        description:
          'Short step label, 1-64 chars lowercase alphanumerics and dashes, e.g. "unit-tests-green"',
      }),
      ok: Type.Optional(
        Type.Boolean({
          description: 'Whether the step succeeded (e.g. tests passed)',
        }),
      ),
      detail: Type.Optional(
        Type.String({
          description: 'Free-form detail, e.g. failing test names',
        }),
      ),
      output: StepOutputSchema,
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        step: string
        ok?: boolean
        detail?: string
        output: StepOutputFacts
      },
    ): Promise<AgentToolResult<FlowSubmitDetails>> {
      // AIDEV-NOTE: PMR-C998 — the ONLY refusal path: malformed params. The
      // reason carries re-run guidance; nothing else ever returns isError.
      // Phase flows from the output union's discriminator — there is no
      // top-level phase param.
      // AIDEV-NOTE (PMR-C998): the input is built by spreading the output
      // union — phase rides the discriminator, and TypeBox unions allow
      // additional properties, so a wrong-typed or cross-phase fact passes
      // the tool-layer schema. buildStepOutputEvent's validator rejects both
      // (fact type checks + cross-phase rejection in flow/step-output.ts)
      // before anything is journaled. Do not restructure the spread.
      const input: StepOutputInput = {
        ...params.output,
        ref: params.ref,
        step: params.step,
        ok: params.ok,
        detail: params.detail,
      }
      const built = buildStepOutputEvent(input)
      if (!built.ok) {
        return toolResult(
          `flow_submit refused: ${built.reason} Re-run flow_submit with the correct shape (see the per-phase output schema; every fact is optional).`,
          { ok: false, journaled: false },
          { isError: true },
        )
      }

      const event = built.event
      const warnings: string[] = []
      const details: FlowSubmitDetails = { ok: true, journaled: false }

      let headResolver: () => Promise<string | null>
      if (resolveHead !== undefined) {
        headResolver = resolveHead
      } else {
        headResolver = defaultResolveHead
      }
      await verifyHeadSha(event, details, warnings, headResolver)

      let eventReader: (r: string) => Promise<FlowRunEvent[] | null>
      if (readEvents !== undefined) {
        eventReader = readEvents
      } else {
        eventReader = (ref: string) => readRunEvents(getAgentDir(), ref)
      }
      await verifyGateTargets(event, params.ref, details, warnings, eventReader)

      const journaled = await journalEvent(event, writer)
      details.journaled = journaled
      if (!journaled) {
        warnings.push(
          'journal write failed (best-effort) — evidence NOT journaled',
        )
      }

      const lines: string[] = []
      if (journaled) {
        lines.push(
          `flow_submit: step-output journaled on ${params.ref} — phase=${event.phase}, step=${event.step}, ${factsSummary(params.output)}`,
        )
      } else {
        lines.push(
          `flow_submit: step-output NOT journaled on ${params.ref} — phase=${event.phase}, step=${event.step}`,
        )
      }
      if (details.headShaVerified !== undefined) {
        lines.push(`headShaVerified: ${details.headShaVerified}`)
      }
      for (const warning of warnings) {
        lines.push(`warning: ${warning}`)
      }
      return toolResult(lines.join('\n'), details)
    },
  })
}
