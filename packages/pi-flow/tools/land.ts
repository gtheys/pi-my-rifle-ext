// AIDEV-NOTE: PMR-06RH — the ONLY sanctioned landing path for a flow run.
// Re-checks the review gate at the landing boundary via the pure
// landDecision (flow/land-gate.ts): 'review-passed' label required, and when
// the agent supplies the review artifact its blockers_count verdict is
// cross-checked. On ok, the ref's landing is authorized so the subsequent
// git push / gh pr create passes the interceptor. Route is recorded, not
// re-derived: mode detection stays the phase prompts' concern.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readAvenLabels } from '../aven/client.ts'
import { loadConfig } from '../config.ts'
import { landDecision } from '../flow/land-gate.ts'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import { toolResult } from './result.ts'

const execFileAsync = promisify(execFile)
const LAND_SUITE_TIMEOUT_MS = 10 * 60 * 1000
const LAND_SUITE_TAIL_CHARS = 2000

// AIDEV-NOTE: shared with the bash tool_call interceptor in index.ts — the
// interceptor refuses git push / gh pr create for the active flow ref until
// this state names it.
// AIDEV-NOTE: PMR-T8ZG — humanReviewPassed records the human code-review
// gate pass for the ref (set ONLY by the code_review tool). The flow_land
// CHECK that reads it lives below (PMR-C6AK) and gates route=merge-main.
// PMR-HYZA: route=merge-main NEVER sets `authorized` — the personal landing
// is a LOCAL ff-only merge into main in the main checkout, so a git push
// stays blocked even after flow_land returns ok. Only route=pr (work mode)
// authorizes git push / gh pr create.
export interface LandingState {
  authorized: string | null
  humanReviewPassed: string | null
}

export function createLandingState(): LandingState {
  return { authorized: null, humanReviewPassed: null }
}

// AIDEV-NOTE: PMR-05HX — the landing gate never trusts a claimed-green
// suite. flow_land runs the test command itself before authorizing any
// route; a misbehaving agent must be UNABLE to land unverified work
// (evidence: pi:01a1b102 ord 36, "tests pass, committed" over a red suite).
export interface SuiteRun {
  ok: boolean
  summary: string
}

export type SuiteRunner = (cwd: string) => Promise<SuiteRun>

export const DEFAULT_LAND_TEST_COMMAND = ['bun', 'run', 'test'] as const

/** Pure: bounded tail of the suite output for the refusal message. */
export function suiteSummary(output: string): string {
  const trimmed = output.trimEnd()
  if (trimmed.length <= LAND_SUITE_TAIL_CHARS) return trimmed
  return `…${trimmed.slice(-LAND_SUITE_TAIL_CHARS)}`
}

/**
 * Default runner: `landTestCommand` from pi-flow config (argv array),
 * else `bun run test`. Fail-closed: a spawn error or timeout is a red run.
 */
export async function defaultSuiteRunner(cwd: string): Promise<SuiteRun> {
  const config = await loadConfig(cwd)
  const command = config.landTestCommand ?? [...DEFAULT_LAND_TEST_COMMAND]
  const [cmd, ...args] = command
  if (cmd === undefined) {
    return { ok: false, summary: 'empty landTestCommand in config' }
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: LAND_SUITE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, summary: suiteSummary(`${stdout}\n${stderr}`) }
  } catch (error: unknown) {
    const err = error as {
      stdout?: string
      stderr?: string
      message?: string
    }
    return {
      ok: false,
      summary: suiteSummary(
        `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? 'suite runner failed'}`,
      ),
    }
  }
}

/** Where the suite runs: the flow's worktree when bound, else the cwd. */
export function landingSuiteCwd(): string {
  return getFlowWorktree()?.path ?? process.cwd()
}

export function registerLandTool(
  pi: ExtensionAPI,
  state: LandingState,
  // AIDEV-NOTE: PMR-VZEV — active-ref getter from the flow loop; null when
  // no flow is in flight (hand-run landing outside a flow is allowed).
  activeRef: () => string | null,
  // AIDEV-NOTE: PMR-05HX — injected so tests never run a real suite.
  runSuite: SuiteRunner,
): void {
  pi.registerTool({
    name: 'flow_land',
    label: 'flow land',
    description:
      'Gate a flow landing: verifies the review-passed label (and an optional review artifact verdict) for the ref. route=pr (work) then authorizes git push / gh pr create for it; route=merge-main (personal) does NOT authorize a push — merge the branch into main locally instead. Direct git push / gh pr create are blocked while the flow is active, and stay blocked for route=merge-main.',
    promptSnippet:
      'Gated landing for PIV flow runs — call before pushing the branch or creating the PR.',
    promptGuidelines: [
      'Call flow_land AFTER flow_phase_complete(phase="validate") and BEFORE git push / gh pr create — direct landing commands are blocked until it returns ok.',
      'For route=merge-main (personal), call the code_review tool first — flow_land refuses until the human pass marker for the ref is recorded. After ok, merge locally: git -C <main repo> merge --ff-only <branch> (find the main repo via `git worktree list` first entry). NEVER push.',
      'flow_land runs the test suite itself before authorizing (landTestCommand config, default bun run test) — a red suite refuses the landing with the failing output. Never claim tests are green to skip it; the gate does not read claims.',
      'A refusal carries the gate reason (missing review-passed label, blockers in the artifact, missing human code-review pass, red test suite); fix the cause, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      route: Type.Union([Type.Literal('pr'), Type.Literal('merge-main')], {
        description:
          'pr: create a PR via gh (work mode). merge-main: merge the branch into main LOCALLY in the main checkout with git -C <main repo> merge --ff-only <branch> — never a push (personal mode).',
      }),
      artifact: Type.Optional(
        Type.String({
          description:
            'The review artifact text (must contain "blockers_count: <N>") — cross-checked when provided',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        route: 'pr' | 'merge-main'
        artifact?: string
      },
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      // AIDEV-NOTE: PMR-C6AK — the human code-review gate check lives here
      // (PMR-T8ZG wrote the field) so behavior flips in one child. Only
      // route=merge-main (personal) requires the marker recorded by the
      // code_review tool for THIS ref; route=pr (work) is unchanged.
      // AIDEV-NOTE: PMR-VZEV — ref validation: a live flow only lands its
      // OWN ref. null = no flow active, the gate does not apply (matches
      // the interceptor, which also stands down without an active ref).
      const flowRef = activeRef()
      if (flowRef !== null && flowRef !== params.ref) {
        return toolResult(
          `flow_land refused landing ${params.ref}: it does not match the active flow ref ${flowRef} — land the active flow's ref, or run outside the flow`,
          { ok: false, reason: 'ref does not match active flow ref' },
          { isError: true },
        )
      }
      if (
        params.route === 'merge-main' &&
        state.humanReviewPassed !== params.ref
      ) {
        return toolResult(
          `flow_land refused landing ${params.ref} via merge-main: the human code-review gate has not passed — call the code_review tool with ref=${params.ref} and collect the human's pass first`,
          { ok: false, reason: 'human code-review gate not passed' },
          { isError: true },
        )
      }
      const labels = await readAvenLabels(params.ref)
      const decision = landDecision(labels, params.artifact ?? null)
      if (!decision.ok) {
        return toolResult(
          `flow_land refused landing ${params.ref} via ${params.route}: ${decision.reason}`,
          { ok: false, reason: decision.reason },
          { isError: true },
        )
      }
      // AIDEV-NOTE: PMR-05HX — guardrail, not a prompt: the gate runs the
      // suite itself before authorizing anything, so a claimed-green suite
      // (pi:01a1b102 ord 36) can no longer land red work. Runs in the flow
      // worktree when one is bound.
      const suiteCwd = landingSuiteCwd()
      const suite = await runSuite(suiteCwd)
      if (!suite.ok) {
        return toolResult(
          `flow_land refused landing ${params.ref}: the test suite FAILED in ${suiteCwd} — a landing requires a suite the gate ran and saw green. Fix the failures and call flow_land again.\n\n${suite.summary}`,
          { ok: false, reason: 'test suite failed' },
          { isError: true },
        )
      }
      // AIDEV-NOTE: PMR-HYZA — only work mode's PR route releases the
      // interceptor's git push / gh pr create block. merge-main keeps
      // `authorized` null: the landing is a local ff-only merge, never a
      // push, so a git push after ok must stay blocked.
      if (params.route === 'pr') {
        state.authorized = params.ref
        return toolResult(
          `flow_land: landing for ${params.ref} authorized via pr — run the git push / gh pr create step now`,
          { ok: true, reason: '' },
        )
      }
      return toolResult(
        `flow_land: landing for ${params.ref} gated ok via merge-main — merge the branch into main LOCALLY in the main checkout with git -C <main repo> merge --ff-only <branch> (find the main repo path via \`git worktree list\`, first entry). Do not push.`,
        { ok: true, reason: '' },
      )
    },
  })
}
