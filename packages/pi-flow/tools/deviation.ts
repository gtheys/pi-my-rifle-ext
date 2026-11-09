// AIDEV-NOTE: PMR-R9EN fix round 2 — agent-callable deviation gate. The
// validate prompt (D3/D4) used to name TS functions (startDeviationReview /
// parseDeviationArtifact) an LLM agent cannot invoke; this tool wraps the
// whole step: compose the reviewer prompt (review/deviation.ts), spawn+await
// the fresh-context reviewer subagent, and parse the artifact strictly with
// the deviation-gate contract. Fail-closed: a spawn failure or a malformed
// artifact is an isError tool result — the agent re-runs, never treats it as
// 0 deviations. Pure seams (prompt composition + result mapping) are exported
// for tests; execute only wires them to the subagent path.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { SubagentResult } from '@gtheys/pi-interactive-subagents'
import { Type } from 'typebox'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import {
  buildDeviationReviewPrompt,
  DEVIATION_INLINE_DIFF_MAX,
  type DeviationReviewInput,
  startDeviationReview,
} from '../review/deviation.ts'
import { recordRunEvent } from '../run-state.ts'
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
import {
  buildGateTarget,
  deriveSubtaskAttribution,
  type GateTarget,
  type GateVerification,
  gateTargetId,
  verifyGateWithExec,
} from '../validate/gate-target.ts'
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

/**
 * Compose the reviewer prompt from the tool params + the resolved range.
 * When a gate target is supplied the pinned range rides along so the
 * reviewer can echo it back (PMR-6EEW echo contract).
 */
export function deviationReviewPromptFrom(
  params: DeviationReviewToolParams,
  resolved: Pick<ResolvedRange, 'diff' | 'commitMessages'>,
  target: GateTarget | null = null,
  diffPath?: string,
): string {
  const input: DeviationReviewInput = {
    mode: params.mode,
    spec: params.spec,
    diff: resolved.diff,
    commitMessages: resolved.commitMessages,
    avenNotes: params.avenNotes,
  }
  if (target !== null) {
    input.pinnedRange = { baseSha: target.baseSha, headSha: target.headSha }
  }
  if (diffPath !== undefined) input.diffPath = diffPath
  return buildDeviationReviewPrompt(input)
}

/**
 * AIDEV-NOTE: PMR-6EEW gate integrity — verify the verifier. Delegates to
 * the shared exec-backed check in validate/gate-target.ts. Kept as a named
 * seam for the deviation tool tests.
 */
export async function verifyDeviationGateResult(
  exec: Exec,
  cwd: string,
  target: GateTarget,
  artifact: string,
): Promise<GateVerification> {
  return verifyGateWithExec(exec, cwd, target, artifact)
}

/** Best-effort journal write — never breaks the gate (house rule). */
async function journalGateEvent(
  event: Parameters<typeof recordRunEvent>[1],
): Promise<void> {
  try {
    await recordRunEvent(getAgentDir(), event)
  } catch {
    // best-effort by design
  }
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
      'The gate pins its review target at spawn and verifies the reviewer echoed the pinned range (PMR-6EEW). A target_mismatch or stale result invalidates the verdict — re-run the tool; do not hand-wave a verdict around it.',
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
      // AIDEV-NOTE: PMR-6EEW — pin at spawn. The reviewer prompt is built
      // from this pinned target, and its verdict is only accepted if it
      // echoes the pin and HEAD has not moved since.
      const built = buildGateTarget({
        gate: 'deviation',
        ref: params.ref,
        baseSha: resolved.value.flowRange.baseSha,
        headSha: resolved.value.flowRange.headSha,
        diff: resolved.value.diff,
      })
      let target: GateTarget | null = null
      if ('diffSha256' in built) {
        target = built
        await journalGateEvent({
          kind: 'gate-target',
          at: new Date().toISOString(),
          ref: params.ref,
          gate: 'deviation',
          targetId: gateTargetId(target),
          baseSha: target.baseSha,
          headSha: target.headSha,
          diffSha256: target.diffSha256,
        })
        // AIDEV-NOTE: PMR-6EEW per-subtask ranges — journal the subtask →
        // commits attribution of the pinned range (Subtask: trailers).
        // Best-effort by design; unattributed commits are surfaced in the
        // event, never guessed at.
        try {
          const attribution = await deriveSubtaskAttribution(
            exec,
            cwd,
            target.baseSha,
            target.headSha,
          )
          if (attribution.ok) {
            await journalGateEvent({
              kind: 'subtask-ranges',
              at: new Date().toISOString(),
              ref: params.ref,
              gate: 'deviation',
              baseSha: target.baseSha,
              headSha: target.headSha,
              bySubtask: attribution.attribution.bySubtask,
              unattributed: attribution.attribution.unattributed,
            })
          }
        } catch {
          // best-effort — the gate itself is unaffected
        }
      }
      // AIDEV-NOTE: large diffs go to a temp file, not the prompt (see
      // DeviationReviewInput.diffPath). Falls back to inline on write failure.
      let diffPath: string | undefined
      if (resolved.value.diff.length > DEVIATION_INLINE_DIFF_MAX) {
        try {
          const dir = await mkdtemp(join(tmpdir(), 'deviation-diff-'))
          diffPath = join(dir, 'pinned.diff')
          await writeFile(diffPath, resolved.value.diff)
        } catch {
          diffPath = undefined
        }
      }
      const prompt = deviationReviewPromptFrom(
        params,
        resolved.value,
        target,
        diffPath,
      )
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
      // AIDEV-NOTE: PMR-6EEW — verify the verifier BEFORE parsing findings:
      // echo contract first, staleness second. A mismatch or stale verdict
      // is a hard error; the gate re-runs on the (possibly new) range.
      if (target !== null) {
        const verification = await verifyDeviationGateResult(
          exec,
          cwd,
          target,
          result.summary,
        )
        if (!verification.ok) {
          await journalGateEvent({
            kind: 'gate-decision',
            at: new Date().toISOString(),
            ref: params.ref,
            gate: 'deviation',
            targetId: gateTargetId(target),
            status: verification.status,
          })
          return toolResult(
            `deviation_review: gate integrity check FAILED (${verification.status}) — ${verification.reason}. The verdict was NOT accepted. Re-run the deviation_review tool; NEVER treat this as 0 deviations.`,
            { ok: false as const, reason: verification.reason },
            { isError: true },
          )
        }
        await journalGateEvent({
          kind: 'gate-decision',
          at: new Date().toISOString(),
          ref: params.ref,
          gate: 'deviation',
          targetId: gateTargetId(target),
          status: 'pass',
        })
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
