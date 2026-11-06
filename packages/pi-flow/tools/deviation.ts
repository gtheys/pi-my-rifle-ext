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
import { getFlowWorktree } from '../flow/worktree-context.ts'
import {
  buildDeviationReviewPrompt,
  type DeviationReviewInput,
  startDeviationReview,
} from '../review/deviation.ts'
import {
  commitMessagesForRange,
  diffForRange,
  type Exec,
  type FlowRange,
  resolveFlowRange,
} from '../shared/diff-base.ts'
import { readFlowBase } from '../shared/flow-base.ts'
import {
  type DeviationArtifact,
  parseDeviationArtifact,
} from '../validate/deviation-gate.ts'
import { toolResult } from './result.ts'

export interface DeviationReviewToolParams {
  mode: 'work' | 'personal'
  ref: string
  spec: string
  avenNotes: string
}

/** Diff + commit messages the tool resolved itself (PMR-R4AP). */
export interface ResolvedRange {
  diff: string
  commitMessages: string
  flowRange: FlowRange
}

export type ResolvedRangeResult =
  | { ok: true; value: ResolvedRange }
  | { ok: false; reason: string }

// AIDEV-NOTE: PMR-R4AP — the tool, not the agent, owns the diff range: base
// branch recorded at worktree create (shared/flow-base.ts) -> shared
// resolver (shared/diff-base.ts, same one pi-review uses) -> diff + commit
// messages. Missing base, unresolvable base or empty range is an error —
// the gate never runs on an empty diff.
export async function resolveDeviationRange(
  exec: Exec,
  cwd: string,
): Promise<ResolvedRangeResult> {
  const base = await readFlowBase(exec, cwd)
  if (!base.ok) return base
  const range = await resolveFlowRange(
    exec,
    cwd,
    base.value.branch,
    base.value.sha ?? base.value.branch,
  )
  if (!range.ok) return range
  try {
    const diff = await diffForRange(exec, cwd, range.value.range)
    if (diff.trim() === '') {
      return { ok: false, reason: `empty diff for ${range.value.range}` }
    }
    const commitMessages = await commitMessagesForRange(
      exec,
      cwd,
      range.value.range,
    )
    return { ok: true, value: { diff, commitMessages, flowRange: range.value } }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Compose the reviewer prompt from the tool params + the resolved range. */
export function deviationReviewPromptFrom(
  params: DeviationReviewToolParams,
  resolved: Pick<ResolvedRange, 'diff' | 'commitMessages'>,
): string {
  const input: DeviationReviewInput = {
    mode: params.mode,
    spec: params.spec,
    diff: resolved.diff,
    commitMessages: resolved.commitMessages,
    avenNotes: params.avenNotes,
  }
  return buildDeviationReviewPrompt(input)
}

/** One-line description of the range, shown to agent and human. */
export function describeRange(r: FlowRange): string {
  return `base ${r.baseBranch} @ ${r.baseSha}, range ${r.range} (${r.commitCount} commit(s), HEAD ${r.headSha})`
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
      'Call deviation_review with mode, ref, the resolved spec text and the mined aven notes (validate prompt steps D1/D2). Do NOT pass a diff or commit messages: the tool resolves base, diff and commits itself in the flow worktree and reports the base SHA and range in its result.',
      'If the result says the flow base is missing or the range is empty, STOP and tell the human — never retry with a hand-written diff.',
      'An error result means re-run deviation_review — NEVER treat an error or malformed artifact as 0 deviations.',
    ],
    parameters: Type.Object({
      mode: Type.Union([Type.Literal('work'), Type.Literal('personal')]),
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      spec: Type.String({
        description:
          'The resolved spec text (D1) — authoritative comparison base',
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
      const cwd = getFlowWorktree()?.path ?? ctx.cwd
      const exec: Exec = (cmd, args, options) => pi.exec(cmd, args, options)
      const resolved = await resolveDeviationRange(exec, cwd)
      if (!resolved.ok) {
        return toolResult(
          `deviation_review: cannot resolve the diff range — ${resolved.reason}. No reviewer was spawned. Tell the human; NEVER treat this as 0 deviations.`,
          { ok: false as const, reason: resolved.reason },
          { isError: true },
        )
      }
      const prompt = deviationReviewPromptFrom(params, resolved.value)
      const rangeLine = describeRange(resolved.value.flowRange)
      let result: SubagentResult
      try {
        result = await startDeviationReview({ ...ctx, cwd }, prompt, params.ref)
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
      const mapped = deviationResultToToolResult(result.summary)
      const first = mapped.content[0]
      if (first !== undefined && first.type === 'text') {
        first.text = `Resolved ${rangeLine}\n${first.text}`
      }
      return mapped
    },
  })
}
