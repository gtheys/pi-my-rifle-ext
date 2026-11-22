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
import { healFlowBinding } from '../flow/binding-heal.ts'
import {
  buildDeviationReviewPrompt,
  checkDiffLinesRead,
  DEVIATION_INLINE_DIFF_MAX,
  type DeviationReviewInput,
  startDeviationReview,
} from '../review/deviation.ts'
import type { FlowRunEvent } from '../run-state.ts'
import {
  createDaemonAliveProbe,
  createEventWriter,
  type EventWriter,
} from '../server/writer.ts'
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
import { productionReviewDeps } from './code-review.ts'
import type { ReviewDeps } from './code-review-parse.ts'
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

export type DeviationCwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; reason: string }

// AIDEV-NOTE: PMR-0KMQ — deviation gate cwd must be the VERIFIED bound flow
// worktree, never the raw binding path (PMR-7ZEE) or a silent ctx.cwd fallback:
// readFlowBase keys branch.<feature>.flowbase and only resolves from the
// feature-branch checkout. Reuses the code_review resolver (binding → aven
// note → herdr list; each candidate verified: path exists, common git dir
// matches the session repo per PMR-9XR0, HEAD branch matches). When no source
// verifies we fail CLOSED with the mismatch reason — a silent fallback to the
// session checkout is exactly the "flow worktree is not bound" refusal this
// ticket removes from the happy path.
export async function resolveDeviationCwd(
  ref: string,
  deps: ReviewDeps,
): Promise<DeviationCwdResolution> {
  try {
    // AIDEV-NOTE: PMR-DRKH — heal-first: resolving doubles as re-arming the
    // module binding after a pi reload; the fail-closed shape is unchanged.
    const heal = await healFlowBinding(ref, deps)
    if (heal.ok) {
      return { ok: true, cwd: heal.worktree.path }
    }
    return { ok: false, reason: heal.reason }
  } catch (error) {
    let msg: string
    if (error instanceof Error) {
      msg = error.message
    } else {
      msg = String(error)
    }
    return { ok: false, reason: msg }
  }
}

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

/** Best-effort journal write — never breaks the gate (house rule). Routed
 * through the mode-aware writer (PMR-XTQQ): journal-only while the daemon
 * owns the projection, full writer when absent. */
async function journalGateEvent(
  event: FlowRunEvent,
  writer: EventWriter,
): Promise<void> {
  await writer.record(event)
}

/** One-line description of the range, shown to agent and human. */
export function describeRange(r: FlowRange): string {
  return `base ${r.baseBranch} @ ${r.baseSha}, range ${r.range} (${r.commitCount} commit(s), HEAD ${r.headSha})`
}

export type DeviationReviewDetails = DeviationArtifact

// AIDEV-NOTE: PMR-MH1Y — bound the excerpt so a pathological artifact cannot
// blow up the tool result; tail-biased because the verdict section is emitted
// at the end of the reviewer reply. PMR-H17H: keep a bounded HEAD slice too —
// the numbered prose findings (the exact diagnosis the excerpt exists for)
// are enumerated BEFORE the verdict section and a pure tail can cut them off.
const RAW_ARTIFACT_EXCERPT_MAX = 4000
const RAW_ARTIFACT_EXCERPT_HEAD = 800

function rawArtifactExcerpt(artifact: string): string {
  if (artifact.length <= RAW_ARTIFACT_EXCERPT_MAX) {
    return artifact
  }
  const head = artifact.slice(0, RAW_ARTIFACT_EXCERPT_HEAD)
  const tail = artifact.slice(
    -(RAW_ARTIFACT_EXCERPT_MAX - RAW_ARTIFACT_EXCERPT_HEAD),
  )
  return `${head}\n…\n${tail}`
}

/**
 * Map a raw reviewer artifact to the tool result. A malformed artifact is an
 * isError result carrying the parse reason — never a silent 0.
 * AIDEV-NOTE: PMR-MH1Y — a parse failure also carries the raw reviewer
 * artifact (bounded) so the caller can SEE what the reviewer emitted and
 * diagnose the mismatch. PMR-C0YV failed 3 identical blind re-runs because
 * the error named only the count parity, never the artifact.
 */
export function deviationResultToToolResult(
  rawArtifact: string,
): AgentToolResult<DeviationReviewDetails> {
  const parsed = parseDeviationArtifact(rawArtifact)
  if (!parsed.ok) {
    return toolResult(
      `deviation_review: artifact parse failed — ${parsed.reason}\nRe-run the deviation_review tool with the same inputs. NEVER treat this as 0 deviations.\n--- raw reviewer artifact (for diagnosis) ---\n${rawArtifactExcerpt(rawArtifact)}\n--- end raw reviewer artifact ---`,
      parsed,
      { isError: true },
    )
  }
  const listed = parsed.deviations
    .map((d) => `- ${d.what} (${d.file}:${d.line})`)
    .join('\n')
  // AIDEV-NOTE (PMR-6YC7): a recovered parse (well-formed lines were scoped
  // out of the verdict section) is flagged so the caller knows the artifact
  // shape was off-contract even though the count matched exactly.
  let recoveredNote = ''
  if (parsed.recovered === true) {
    recoveredNote =
      ' (recovered: the verdict-section scoping excluded the well-formed lines — e.g. a restated heading or subheading — but the artifact-wide lines exactly match the declared count)'
  }
  let summary: string
  if (parsed.deviationsCount === 0) {
    summary =
      'deviation_review: 0 deviations from spec — continue to D5 (record the "no deviation from spec" aven note, then flow_phase_complete).'
  } else {
    summary = `deviation_review: ${parsed.deviationsCount} deviation(s) from spec${recoveredNote}:\n${listed}\nContinue to D5 — a HUMAN decides via ask_user_question (accept / fix).`
  }
  return toolResult(summary, parsed)
}

/** A watcher/spawn failure rendered as the SubagentResult shape it reports. */
function failedResult(result: SubagentResult): string {
  const detail = result.errorMessage ?? `exit code ${result.exitCode}`
  return `deviation_review: reviewer subagent failed — ${detail}. Re-run the deviation_review tool. NEVER treat this as 0 deviations.`
}

export function registerDeviationReviewTool(
  pi: ExtensionAPI,
  // AIDEV-NOTE: PMR-XTQQ — mode-aware writer seam; default probes per write
  // (daemon enabled). index.ts passes the shared runServer-configured writer.
  writer: EventWriter = createEventWriter(
    getAgentDir(),
    createDaemonAliveProbe(getAgentDir()),
  ),
): void {
  pi.registerTool({
    name: 'deviation_review',
    label: 'deviation review',
    description:
      'Run the spec-deviation gate: spawns a fresh-context reviewer subagent that compares the resolved spec text against the git diff, then parses its deviation artifact strictly. Returns the parsed verdict (deviations_count + deviations) or an error — a parse error means re-run, never 0 deviations.',
    promptSnippet:
      'Spec-deviation gate for the validate phase — call after the review gate returned 0 blockers.',
    promptGuidelines: [
      'Call deviation_review with mode, ref, the resolved spec text and the mined aven notes (validate prompt steps D1/D2). Do NOT pass a diff or commit messages: the tool resolves base, diff and commits itself in the flow worktree and reports the base SHA and range in its result.',
      'A "cannot resolve the flow worktree" refusal names a checkout mismatch: the bound flow worktree could not be verified (missing, foreign repo, branch moved). STOP and tell the human — fix or re-bind the worktree (/flow <ref> to resume so the flow loop session holds the worktree context); never retry from the session checkout.',
      'If the result says the flow base is missing or the range is empty, STOP and tell the human — never retry with a hand-written diff.',
      'An error result means re-run deviation_review — NEVER treat an error or malformed artifact as 0 deviations. A parse failure carries the raw reviewer artifact: read it first to see what the reviewer emitted before re-running.',
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
      // AIDEV-NOTE: PMR-0KMQ — the cwd is the VERIFIED bound flow worktree;
      // an unresolvable worktree is a fail-closed mismatch refusal (no
      // reviewer, no doomed "not bound" run from the session checkout).
      const resolution = await resolveDeviationCwd(
        params.ref,
        productionReviewDeps(pi, ctx.cwd),
      )
      if (!resolution.ok) {
        return toolResult(
          `deviation_review: cannot resolve the flow worktree for ${params.ref} — checkout mismatch: ${resolution.reason}. The flow base is recorded on the feature branch (branch.<feature>.flowbase), so the diff range cannot be resolved from the session checkout (${ctx.cwd}). Fix or re-bind the flow worktree, then re-run. No reviewer was spawned. NEVER treat this as 0 deviations.\nRecovery: run /flow ${params.ref} to re-arm the flow binding, then re-call.`,
          { ok: false as const, reason: resolution.reason },
          { isError: true },
        )
      }
      const cwd = resolution.cwd
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
        await journalGateEvent(
          {
            kind: 'gate-target',
            at: new Date().toISOString(),
            ref: params.ref,
            gate: 'deviation',
            targetId: gateTargetId(target),
            baseSha: target.baseSha,
            headSha: target.headSha,
            diffSha256: target.diffSha256,
          },
          writer,
        )
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
            await journalGateEvent(
              {
                kind: 'subtask-ranges',
                at: new Date().toISOString(),
                ref: params.ref,
                gate: 'deviation',
                baseSha: target.baseSha,
                headSha: target.headSha,
                bySubtask: attribution.attribution.bySubtask,
                unattributed: attribution.attribution.unattributed,
              },
              writer,
            )
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
          await journalGateEvent(
            {
              kind: 'gate-decision',
              at: new Date().toISOString(),
              ref: params.ref,
              gate: 'deviation',
              targetId: gateTargetId(target),
              status: verification.status,
            },
            writer,
          )
          return toolResult(
            `deviation_review: gate integrity check FAILED (${verification.status}) — ${verification.reason}. The verdict was NOT accepted. Re-run the deviation_review tool; NEVER treat this as 0 deviations.`,
            { ok: false as const, reason: verification.reason },
            { isError: true },
          )
        }
        await journalGateEvent(
          {
            kind: 'gate-decision',
            at: new Date().toISOString(),
            ref: params.ref,
            gate: 'deviation',
            targetId: gateTargetId(target),
            status: 'pass',
          },
          writer,
        )
      }
      if (diffPath !== undefined) {
        const check = checkDiffLinesRead(resolved.value.diff, result.summary)
        if (!check.ok) {
          return toolResult(
            `deviation_review: reviewer did not prove it read the whole diff file (diff_lines_read: expected ${check.expected}, got ${check.got ?? 'none'}). The verdict was NOT accepted. Re-run the deviation_review tool; NEVER treat this as 0 deviations.`,
            { ok: false as const, reason: 'diff_lines_read mismatch' },
            { isError: true },
          )
        }
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
