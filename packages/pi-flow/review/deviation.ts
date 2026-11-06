// AIDEV-NOTE: Deviation reviewer (PMR-M64D) — fresh-context subagent that
// compares the resolved spec against the git diff. Same split as verdict.ts:
// validate/deviation-gate.ts owns the artifact contract (DEVIATION_VERDICT_
// HEADING, DEVIATION_CONTRACT_PROMPT) and parses the artifact; this module
// only composes the reviewer prompt from those shared constants and spawns
// via the existing launchSubagent path (no new spawn infrastructure). The
// caller (validate prompt integration, subtask 3) resolves spec/diff/why
// inputs as strings — this module never reads git or aven itself.

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { SubagentResult } from '@gtheys/pi-interactive-subagents'
import { launchSubagent, watchSubagent } from '@gtheys/pi-interactive-subagents'
import {
  DEVIATION_CONTRACT_PROMPT,
  DEVIATION_VERDICT_HEADING,
} from '../validate/deviation-gate.ts'

// AIDEV-NOTE: Below this length a spec section cannot meaningfully constrain
// a deviation comparison — the reviewer would be inventing requirements, so
// the prompt degrades to "insufficient spec to compare".
export const DEVIATION_MIN_SPEC_LENGTH = 40

export interface DeviationReviewInput {
  mode: 'work' | 'personal'
  spec: string
  diff: string
  commitMessages: string
  avenNotes: string
  /**
   * AIDEV-NOTE: PMR-6EEW gate integrity — pinned range the reviewer must
   * echo back. When present the prompt requires a reviewed_range line and
   * the harness compares it against the pin character by character.
   */
  pinnedRange?: { baseSha: string; headSha: string }
}

const DEVIATION_EMITTER_INSTRUCTIONS = `End the review with a machine-readable deviation verdict section:
   ${DEVIATION_VERDICT_HEADING}
   deviations_count: <N>
${DEVIATION_CONTRACT_PROMPT}
   where N is the number of deviations, 0 when the diff matches the spec.
   Emit the count line EXACTLY ONCE, directly under the heading.`

const ECHO_INSTRUCTIONS = `Pinned range you are reviewing (set by the harness — do NOT recompute it):
   reviewed_range: <baseSha>..<headSha>
   Copy that line EXACTLY into your verdict section, directly under the heading, before deviations_count. It is compared character by character against the pin; any difference invalidates your review.`

export function buildDeviationReviewPrompt(
  input: DeviationReviewInput,
): string {
  const trimmedSpec = input.spec.trim()
  let specSection: string
  if (trimmedSpec.length >= DEVIATION_MIN_SPEC_LENGTH) {
    specSection = `## Resolved spec (authoritative — the diff is judged against ONLY this text)

${trimmedSpec}`
  } else {
    specSection = `## Resolved spec

The resolved spec is too thin to compare against (${trimmedSpec.length} chars, minimum ${DEVIATION_MIN_SPEC_LENGTH}). This is an INSUFFICIENT SPEC case: do not invent or infer requirements. Report "insufficient spec to compare" as your finding summary and emit deviations_count: 0 — the caller handles the insufficient-spec route.`
  }

  const commits = input.commitMessages.trim()
  const notes = input.avenNotes.trim()
  let commitsSection: string
  if (commits.length > 0) {
    commitsSection = commits
  } else {
    commitsSection = '(none recorded)'
  }
  let notesSection: string
  if (notes.length > 0) {
    notesSection = notes
  } else {
    notesSection = '(none recorded)'
  }

  let pinnedLine: string
  if (input.pinnedRange !== undefined) {
    pinnedLine = `   reviewed_range: ${input.pinnedRange.baseSha}..${input.pinnedRange.headSha}`
  } else {
    pinnedLine = '(no pin supplied — plain legacy mode)'
  }

  return `You are a fresh-context spec-deviation reviewer. You have no knowledge of the work beyond the inputs below.

Mode: ${input.mode}. Compare the resolved spec against the git diff and report every place the implementation DEVIATES from the spec. Do not review code quality — deviation from the spec is the only finding type. Do not invent deviations: if the diff matches the spec, report 0.

Ground rules:
- Judge the diff against the spec text ONLY, never against unstated assumptions.
- Every deviation's "why" rationale MUST be labelled inferred, with the concrete evidence that led to the inference, e.g. (inferred: commit message says X but spec says Y).
- Bounded inputs: judge only the spec section and diff below — do not explore the repository history.
- Empty why-input sections simply carry no extra context.

${specSection}

## Pinned review target (PMR-6EEW gate integrity)

${ECHO_INSTRUCTIONS}
${pinnedLine}

## Git diff vs base

${input.diff}

## Why-inputs (mined context — commit messages, aven notes: interview note, worktree note, oneshot outcome, escalation notes)

### Commit messages
${commitsSection}

### Aven notes
${notesSection}

${DEVIATION_EMITTER_INSTRUCTIONS}`
}

/**
 * AIDEV-NOTE: Spawn the deviation reviewer via launchSubagent (the same
 * subagent path as startSubagentReview) and return its result. Fire-and-await
 * rather than fire-and-steer: the validate flow (subtask 3) needs the
 * artifact synchronously to parse and route. Spawn failure propagates to the
 * caller — the validate flow decides how to degrade.
 */
export async function startDeviationReview(
  ctx: ExtensionContext,
  prompt: string,
  hint: string,
): Promise<SubagentResult> {
  const running = await launchSubagent(
    {
      agent: 'reviewer',
      name: `Deviation check: ${hint}`,
      task: prompt,
      cwd: ctx.cwd,
    },
    ctx,
  )
  return watchSubagent(running, new AbortController().signal)
}
