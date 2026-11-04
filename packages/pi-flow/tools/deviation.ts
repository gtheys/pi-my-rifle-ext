// AIDEV-NOTE: PMR-R9EN fix round 2 — agent-callable deviation gate. The
// validate prompt (D3/D4) used to name TS functions (startDeviationReview /
// parseDeviationArtifact) an LLM agent cannot invoke; this tool wraps the
// whole step: compose the reviewer prompt (review/deviation.ts), spawn+await
// the fresh-context reviewer subagent, and parse the artifact strictly with
// the deviation-gate contract. Fail-closed: a spawn failure or a malformed
// artifact is an isError tool result — the agent re-runs, never treats it as
// 0 deviations. Pure seams (prompt composition + result mapping) are exported
// for tests; execute only wires them to the subagent path.
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent'
import type { SubagentResult } from '@gtheys/pi-interactive-subagents'
import { Type } from 'typebox'
import {
  buildDeviationReviewPrompt,
  type DeviationReviewInput,
  startDeviationReview,
} from '../review/deviation.ts'
import {
  type DeviationArtifact,
  parseDeviationArtifact,
} from '../validate/deviation-gate.ts'
import { toolResult } from './result.ts'

export interface DeviationReviewToolParams {
  mode: 'work' | 'personal'
  ref: string
  spec: string
  diff: string
  commitMessages: string
  avenNotes: string
}

/** Compose the reviewer prompt from the tool's resolved params. */
export function deviationReviewPromptFrom(
  params: DeviationReviewToolParams,
): string {
  const input: DeviationReviewInput = {
    mode: params.mode,
    spec: params.spec,
    diff: params.diff,
    commitMessages: params.commitMessages,
    avenNotes: params.avenNotes,
  }
  return buildDeviationReviewPrompt(input)
}

export type DeviationReviewDetails = DeviationArtifact

/**
 * Map a raw reviewer artifact to the tool result. A malformed artifact is an
 * isError result carrying the parse reason — never a silent 0.
 */
export function deviationResultToToolResult(
  rawArtifact: string,
): AgentToolResult<DeviationReviewDetails> {
  const parsed = parseDeviationArtifact(rawArtifact)
  if (!parsed.ok) {
    return toolResult(
      `deviation_review: artifact parse failed — ${parsed.reason}\nRe-run the deviation_review tool with the same inputs. NEVER treat this as 0 deviations.`,
      parsed,
      { isError: true },
    )
  }
  const listed = parsed.deviations
    .map((d) => `- ${d.what} (${d.file}:${d.line})`)
    .join('\n')
  let summary: string
  if (parsed.deviationsCount === 0) {
    summary =
      'deviation_review: 0 deviations from spec — continue to D5 (record the "no deviation from spec" aven note, then flow_phase_complete).'
  } else {
    summary = `deviation_review: ${parsed.deviationsCount} deviation(s) from spec:\n${listed}\nContinue to D5 — a HUMAN decides via ask_user_question (accept / fix).`
  }
  return toolResult(summary, parsed)
}

/** A watcher/spawn failure rendered as the SubagentResult shape it reports. */
function failedResult(result: SubagentResult): string {
  const detail = result.errorMessage ?? `exit code ${result.exitCode}`
  return `deviation_review: reviewer subagent failed — ${detail}. Re-run the deviation_review tool. NEVER treat this as 0 deviations.`
}

export function registerDeviationReviewTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'deviation_review',
    label: 'deviation review',
    description:
      'Run the spec-deviation gate: spawns a fresh-context reviewer subagent that compares the resolved spec text against the git diff, then parses its deviation artifact strictly. Returns the parsed verdict (deviations_count + deviations) or an error — a parse error means re-run, never 0 deviations.',
    promptSnippet:
      'Spec-deviation gate for the validate phase — call after the review gate returned 0 blockers.',
    promptGuidelines: [
      'Call deviation_review with the resolved spec text, the git diff vs the flow base, and the mined commit messages / aven notes (validate prompt steps D1/D2).',
      'An error result means re-run deviation_review — NEVER treat an error or malformed artifact as 0 deviations.',
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal('work'), Type.Literal('personal')]),
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      spec: Type.String({
        description:
          'The resolved spec text (D1) — authoritative comparison base',
      }),
      diff: Type.String({
        description: 'The git diff vs the flow base branch',
      }),
      commitMessages: Type.String({
        description: 'Commit messages mined per D2 (empty string when none)',
      }),
      avenNotes: Type.String({
        description: 'Recent aven notes mined per D2 (empty string when none)',
      }),
    }),
    async execute(
      _toolCallId: string,
      params: DeviationReviewToolParams,
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<DeviationReviewDetails>> {
      const prompt = deviationReviewPromptFrom(params)
      let result: SubagentResult
      try {
        result = await startDeviationReview(ctx, prompt, params.ref)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return toolResult(
          `deviation_review: reviewer spawn failed — ${message}. Re-run the deviation_review tool when the subagent mux is available. NEVER treat this as 0 deviations.`,
          { ok: false as const, reason: message },
          { isError: true },
        )
      }
      if (result.exitCode !== 0 || result.errorMessage !== undefined) {
        return toolResult(
          failedResult(result),
          {
            ok: false as const,
            reason: result.errorMessage ?? `exit code ${result.exitCode}`,
          },
          { isError: true },
        )
      }
      return deviationResultToToolResult(result.summary)
    },
  })
}
