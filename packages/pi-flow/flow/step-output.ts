// AIDEV-NOTE (PMR-HVAX, structured step outputs; phase 2 of PMR-C998):
// advisory-only contract. Submitting a step-output event journals evidence
// (facts, SHA, PR link) but NEVER gates completion — the /flow loop's labels
// remain the gate of record. Validation here is schema enforcement (well-formed
// facts, actionable rejection reasons), not a completion gate: a bare step
// boundary with zero facts is a valid submission, and a rejected submission
// only means the caller should fix the payload, not that a phase is blocked.

import { FLOW_VALUE_RE } from '@gtheys/pi-interactive-subagents'
import { type Static, Type } from 'typebox'
import type { FlowPhase } from '../run-state.ts'
import { isFullSha } from '../validate/gate-target.ts'

/**
 * Per-phase fact schemas, discriminated on `phase`. Every fact is optional so
 * a bare step boundary (phase + step label, no facts) is a valid submission.
 * Field descriptions are part of the contract: tools/flow-submit.ts uses this
 * schema directly as its `output` param (single source, never inlined).
 */
export const StepOutputSchema = Type.Union(
  [
    Type.Object({
      phase: Type.Literal('plan'),
      planPath: Type.Optional(
        Type.String({ description: 'Path of the written plan' }),
      ),
      subtaskRefs: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Subtask refs covered by the plan',
        }),
      ),
    }),
    Type.Object({
      phase: Type.Literal('implement'),
      command: Type.Optional(
        Type.String({ description: 'Verification command that ran' }),
      ),
      passed: Type.Optional(
        Type.Boolean({ description: 'Whether the command passed' }),
      ),
      headSha: Type.Optional(
        Type.String({ description: 'Full 40-char HEAD SHA the evidence pins' }),
      ),
    }),
    Type.Object({
      phase: Type.Literal('validate'),
      prNumber: Type.Optional(
        Type.Number({ description: 'PR number under validation' }),
      ),
      prUrl: Type.Optional(
        Type.String({ description: 'PR URL under validation' }),
      ),
      gateTargetIds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Ids of gate-target events this evidence covers',
        }),
      ),
    }),
    Type.Object({
      phase: Type.Literal('feedback'),
      prUrl: Type.Optional(
        Type.String({ description: 'PR URL the feedback is about' }),
      ),
      prMerged: Type.Optional(
        Type.Boolean({ description: 'Whether the PR merged' }),
      ),
    }),
  ],
  {
    description:
      'Phase-discriminated step output; phase is the discriminator and no separate phase param exists',
  },
)

export type StepOutputFacts = Static<typeof StepOutputSchema>

/**
 * Payload shape of the `step-output` FlowRunEvent member that subtask 2.2
 * adds to run-state.ts. Kept local here so this pure module compiles
 * standalone; 2.2 must carry exactly these fields.
 */
export interface StepOutputEventPayload {
  kind: 'step-output'
  /** ISO timestamp — every FlowRunEvent carries `at` as an ISO string. */
  at: string
  ref: string
  phase: FlowPhase
  step: string
  ok?: boolean
  detail?: string
  planPath?: string
  subtaskRefs?: string[]
  command?: string
  passed?: boolean
  headSha?: string
  headShaVerified?: boolean
  prNumber?: number
  prUrl?: string
  gateTargetIds?: string[]
  prMerged?: boolean
}

/** Union of every optional per-phase fact field, all optional. */
/**
 * AIDEV-NOTE: PMR-C998 — flat mirror of every optional fact field across the
 * four StepOutputSchema branches. Kept in sync with the schema BY HAND:
 * StepOutputSchema remains the authoritative tool-boundary contract (TypeBox
 * validates the `output` param per phase in tools/flow-submit.ts), and
 * validateFactTypes below is the runtime cross-check of phase/fact
 * consistency, including cross-phase rejection: any fact key from a foreign
 * phase branch (even correctly typed) is refused, because TypeBox unions
 * allow additional properties and would otherwise let a spread journal
 * wrong-phase evidence. Not derived from the schema union: intersecting optional
 * props from different union branches resolves them to never, which would
 * make every facts-carrying caller untypeable without casts.
 */
type StepOutputFactFields = {
  planPath?: string
  subtaskRefs?: string[]
  command?: string
  passed?: boolean
  headSha?: string
  prNumber?: number
  prUrl?: string
  gateTargetIds?: string[]
  prMerged?: boolean
}

export type StepOutputInput = StepOutputFactFields & {
  ref: string
  step: string
  phase: FlowPhase
  ok?: boolean
  detail?: string
}

export type StepOutputResult =
  | { ok: true; event: StepOutputEventPayload }
  | { ok: false; reason: string }

function buildTypeMismatchReason(
  field: string,
  phase: StepOutputFacts['phase'],
  expected: string,
): string {
  return `Invalid ${phase} fact "${field}": expected ${expected}.`
}

const FACT_KEYS_BY_PHASE: Record<StepOutputFacts['phase'], string[]> = {
  plan: ['planPath', 'subtaskRefs'],
  implement: ['command', 'passed', 'headSha'],
  validate: ['prNumber', 'prUrl', 'gateTargetIds'],
  feedback: ['prUrl', 'prMerged'],
}

function buildCrossPhaseReason(
  field: string,
  phase: StepOutputFacts['phase'],
): string {
  const phases = FACT_KEY_PHASES[field].join(' or ')
  let plural = ''
  if (FACT_KEY_PHASES[field].length > 1) {
    plural = 's'
  }
  return `Invalid ${phase} fact "${field}": not a ${phase} fact — ${field} belongs to the ${phases} phase${plural}.`
}

// AIDEV-NOTE (PMR-C998): reverse index of fact key -> owning phases. prUrl is
// legitimately shared by validate and feedback, so values are arrays and a key
// is only foreign when the input's phase is absent from the list.
const FACT_KEY_PHASES: Record<string, StepOutputFacts['phase'][]> = {}
for (const phase of Object.keys(FACT_KEYS_BY_PHASE) as Array<
  StepOutputFacts['phase']
>) {
  for (const key of FACT_KEYS_BY_PHASE[phase]) {
    const owners = FACT_KEY_PHASES[key]
    if (owners === undefined) {
      FACT_KEY_PHASES[key] = [phase]
    } else {
      owners.push(phase)
    }
  }
}

/**
 * Rejects fact keys that belong only to phases other than the input's phase.
 * Returns null when no foreign keys are present.
 */
function validateCrossPhaseFacts(input: StepOutputInput): string | null {
  for (const field of Object.keys(FACT_KEY_PHASES)) {
    if (FACT_KEY_PHASES[field].includes(input.phase)) {
      continue
    }
    const value = input[field as keyof StepOutputFactFields]
    if (value !== undefined) {
      return buildCrossPhaseReason(field, input.phase)
    }
  }
  return null
}

export function buildStepOutputEvent(input: StepOutputInput): StepOutputResult {
  if (!FLOW_VALUE_RE.test(input.ref)) {
    return {
      ok: false,
      reason: `Invalid ref "${input.ref}": must match the flow value charset (lowercase alphanumerics and dashes, e.g. "pmr-hvax").`,
    }
  }

  if (input.step.length === 0) {
    return {
      ok: false,
      reason:
        'Invalid step: must be 1-64 chars matching the flow value charset (lowercase alphanumerics and dashes).',
    }
  }
  if (input.step.length > 64) {
    return {
      ok: false,
      reason: `Invalid step "${input.step.slice(0, 12)}…": must be 1-64 chars matching the flow value charset (lowercase alphanumerics and dashes).`,
    }
  }
  if (!FLOW_VALUE_RE.test(input.step)) {
    return {
      ok: false,
      reason: `Invalid step "${input.step}": must be 1-64 chars matching the flow value charset (lowercase alphanumerics and dashes).`,
    }
  }

  if (input.headSha !== undefined && !isFullSha(input.headSha)) {
    return {
      ok: false,
      reason: `Invalid headSha "${input.headSha}": must be a full 40-character hex SHA.`,
    }
  }

  const factsTypeCheck = validateFactTypes(input)
  if (factsTypeCheck !== null) {
    return { ok: false, reason: factsTypeCheck }
  }

  return {
    ok: true,
    event: {
      kind: 'step-output',
      at: new Date().toISOString(),
      ref: input.ref,
      phase: input.phase,
      step: input.step,
      ok: input.ok,
      detail: input.detail,
      planPath: input.planPath,
      subtaskRefs: input.subtaskRefs,
      command: input.command,
      passed: input.passed,
      headSha: input.headSha,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      gateTargetIds: input.gateTargetIds,
      prMerged: input.prMerged,
    },
  }
}

/**
 * Belt-and-braces fact type gate. The tool layer (2.3) validates params with
 * TypeBox before calling here; this re-check keeps the journal clean even if
 * a caller skips that layer. Returns null when everything checks out.
 */
function validateFactTypes(input: StepOutputInput): string | null {
  const crossPhase = validateCrossPhaseFacts(input)
  if (crossPhase !== null) {
    return crossPhase
  }
  if (input.phase === 'plan') {
    if (input.planPath !== undefined && typeof input.planPath !== 'string') {
      return buildTypeMismatchReason('planPath', input.phase, 'a string path')
    }
    if (input.subtaskRefs !== undefined && !isStringArray(input.subtaskRefs)) {
      return buildTypeMismatchReason(
        'subtaskRefs',
        input.phase,
        'an array of ref strings',
      )
    }
  }

  if (input.phase === 'implement') {
    if (input.command !== undefined && typeof input.command !== 'string') {
      return buildTypeMismatchReason('command', input.phase, 'a command string')
    }
    if (input.passed !== undefined && typeof input.passed !== 'boolean') {
      return buildTypeMismatchReason('passed', input.phase, 'a boolean')
    }
  }

  if (input.phase === 'validate') {
    if (input.prNumber !== undefined && !isInteger(input.prNumber)) {
      return buildTypeMismatchReason('prNumber', input.phase, 'an integer')
    }
    if (input.prUrl !== undefined && typeof input.prUrl !== 'string') {
      return buildTypeMismatchReason('prUrl', input.phase, 'a URL string')
    }
    if (
      input.gateTargetIds !== undefined &&
      !isStringArray(input.gateTargetIds)
    ) {
      return buildTypeMismatchReason(
        'gateTargetIds',
        input.phase,
        'an array of gate-target id strings',
      )
    }
  }

  if (input.phase === 'feedback') {
    if (input.prUrl !== undefined && typeof input.prUrl !== 'string') {
      return buildTypeMismatchReason('prUrl', input.phase, 'a URL string')
    }
    if (input.prMerged !== undefined && typeof input.prMerged !== 'boolean') {
      return buildTypeMismatchReason('prMerged', input.phase, 'a boolean')
    }
  }

  return null
}

function isStringArray(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every((item) => typeof item === 'string')
}

function isInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value)
}
