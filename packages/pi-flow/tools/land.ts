// AIDEV-NOTE: PMR-06RH — the ONLY sanctioned landing path for a flow run.
// Re-checks the review gate at the landing boundary via the pure
// landDecision (flow/land-gate.ts): 'review-passed' label required, and when
// the agent supplies the review artifact its blockers_count verdict is
// cross-checked. On ok, the ref's landing is authorized so the subsequent
// git push / gh pr create passes the interceptor. Route is recorded, not
// re-derived: mode detection stays the phase prompts' concern.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { readAvenLabels } from '../aven/client.ts'
import { loadConfig } from '../config.ts'
import { DEFAULT_RECIPES } from '../flow/effect-gate.ts'
import { landDecision } from '../flow/land-gate.ts'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import {
  createEffectJournal,
  createReceiptJournal,
  type EffectJournal,
  type ReceiptJournal,
} from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { toolResult } from './result.ts'

const execFileAsync = promisify(execFile)
const LAND_SUITE_TIMEOUT_MS = 10 * 60 * 1000
const LAND_SUITE_TAIL_CHARS = 2000

// AIDEV-NOTE: PMR-VDVJ — declare-before-authorize for route=pr: git-push and
// gh-pr-create must both be journaled (canonical commands + DEFAULT_RECIPES)
// before the landing is authorized. Declarations are fail-closed, receipts
// stay best-effort — the deliberate split. Shared by BOTH success paths
// (receipt adoption and fresh suite) so neither can authorize undeclared.
async function declarePushEffects(
  effects: EffectJournal,
  ref: string,
  head: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const effect of ['git-push', 'gh-pr-create'] as const) {
    let command: string
    if (effect === 'git-push') {
      command = 'git push'
    } else {
      command = 'gh pr create'
    }
    const result = await effects.declare({
      ref,
      effect,
      command,
      recipe: DEFAULT_RECIPES[effect],
      headSha: head ?? undefined,
    })
    if (!result.ok) {
      return { ok: false, reason: result.reason }
    }
  }
  return { ok: true }
}

// AIDEV-NOTE: PMR-VDVJ phase 4 — the merge-main exact-command contract.
// Resolve main checkout + landing branch (either null -> fail-closed
// refusal), pin command = git -C '<mainRepo>' merge --ff-only <branch>
// (single-quoted path so the agent copies it verbatim), declare the
// merge-main effect with that exact command, and only then set
// mergeAuthorized. Shared by BOTH success paths (receipt adoption and fresh
// suite) so neither can authorize an unpinned or undeclared merge.
async function authorizeMergeMain(
  state: LandingState,
  effects: EffectJournal,
  ref: string,
  head: string | null,
  resolveMainRepo: MainRepoResolver,
  resolveLandingBranch: LandingBranchResolver,
): Promise<{ ok: true; command: string } | { ok: false; reason: string }> {
  const mainRepo = await resolveMainRepo()
  if (mainRepo === null) {
    return {
      ok: false,
      reason:
        'cannot resolve the main checkout — the merge command cannot be pinned, landing refused',
    }
  }
  const branch = await resolveLandingBranch()
  if (branch === null) {
    return {
      ok: false,
      reason:
        'cannot resolve the landing branch — the merge command cannot be pinned, landing refused',
    }
  }
  const command = `git -C '${mainRepo}' merge --ff-only ${branch}`
  const declared = await effects.declare({
    ref,
    effect: 'merge-main',
    command,
    recipe: DEFAULT_RECIPES['merge-main'],
    headSha: head ?? undefined,
  })
  if (!declared.ok) {
    return { ok: false, reason: declared.reason }
  }
  state.mergeAuthorized = { ref, command }
  return { ok: true, command }
}

// AIDEV-NOTE: PMR-VDVJ phase 4 — the ok result text for merge-main must name
// the EXACT pinned command, the recovery recipe (ISC-4), and that any other
// merge form is blocked while the flow is active.
function mergeOkNote(command: string): string {
  const recovery = DEFAULT_RECIPES['merge-main'].join('; ')
  return ` Run EXACTLY this command in the main checkout: ${command} — any other merge form is blocked while the flow is active. Recovery if the merge goes wrong: ${recovery}. Do not push.`
}

// AIDEV-NOTE: shared with the bash tool_call interceptor in index.ts — the
// interceptor refuses git push / gh pr create for the active flow ref until
// this state names it.
// AIDEV-NOTE: PMR-T8ZG — humanReviewPassed records the human code-review
// gate pass for the ref (set ONLY by the code_review tool). The flow_land
// CHECK that reads it lives below (PMR-C6AK) and gates route=merge-main.
// AIDEV-NOTE: PMR-R5VB — the marker now has a durable aven-backed
// alternative: flow_land also accepts a durable 'pass' gate answer for the
// ref (human-only, via /flow answer <ref> pass), read through the injected
// readReviewAnswer dep — so the gate can pass cross-session.
// PMR-HYZA: route=merge-main NEVER sets `authorized` — the personal landing
// is a LOCAL ff-only merge into main in the main checkout, so a git push
// stays blocked even after flow_land returns ok. Only route=pr (work mode)
// authorizes git push / gh pr create.
export interface LandingState {
  authorized: string | null
  humanReviewPassed: string | null
  // AIDEV-NOTE: PMR-HYZA — deliberately separate from `authorized`: a
  // merge-main ok sets ONLY mergeAuthorized (the pinned exact merge command);
  // it must never unblock `git push`, which stays gated by `authorized`.
  mergeAuthorized: { ref: string; command: string } | null
}

export function createLandingState(): LandingState {
  return {
    authorized: null,
    humanReviewPassed: null,
    mergeAuthorized: null,
  }
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

// AIDEV-NOTE: PMR-R5VB — durable human-decision read for the merge-main
// review gate. Injected (production: readGateAnswer(ref, 'review')) so
// land.ts stays aven-import-free beyond types. Fail-closed by contract:
// any read failure returns null, which can never fabricate a pass.
export type ReviewAnswerReader = (
  ref: string,
) => Promise<'pass' | 'fail' | null>

export const DEFAULT_LAND_TEST_COMMAND = ['bun', 'run', 'test'] as const

// AIDEV-NOTE: PMR-H5ST — repo-aware land test detection. Consulted ONLY when
// neither global nor project config sets landTestCommand. First match wins in
// this fixed order (bun-style signals, then cargo, then npm, then pnpm) so a
// hybrid repo resolves deterministically. Adding a row here must come with a
// detection-matrix test in test/land-detect.test.ts.
const LAND_TEST_SIGNALS: ReadonlyArray<{
  files: readonly string[]
  command: readonly string[]
}> = [
  { files: ['bun.lock', 'bunfig.toml'], command: ['bun', 'run', 'test'] },
  { files: ['Cargo.toml'], command: ['cargo', 'test'] },
  { files: ['package-lock.json'], command: ['npm', 'test'] },
  { files: ['pnpm-lock.yaml'], command: ['pnpm', 'test'] },
]

export interface DetectedLandTest {
  command: readonly string[]
  /** The signal file that matched, e.g. 'bun.lock' — surfaced in summaries. */
  signal: string
}

/**
 * Repo-signal detection for the land test (PMR-H5ST): lockfile/manifest
 * presence under repoRoot picks the suite command. Returns null when no
 * signal matches (caller falls back to DEFAULT_LAND_TEST_COMMAND).
 */
export async function detectLandTestCommand(
  repoRoot: string,
): Promise<DetectedLandTest | null> {
  for (const entry of LAND_TEST_SIGNALS) {
    for (const file of entry.files) {
      try {
        await fs.access(path.join(repoRoot, file))
        return { command: [...entry.command], signal: file }
      } catch {
        // Signal file absent — keep scanning in the fixed order.
      }
    }
  }
  return null
}

/** Pure: bounded tail of the suite output for the refusal message. */
export function suiteSummary(output: string): string {
  const trimmed = output.trimEnd()
  if (trimmed.length <= LAND_SUITE_TAIL_CHARS) return trimmed
  return `…${trimmed.slice(-LAND_SUITE_TAIL_CHARS)}`
}

/**
 * Suite command resolution (PMR-H5ST), in order: explicit `landTestCommand`
 * from pi-flow config (global or project — loadConfig merges, project wins
 * per key), then repo-signal detection, then `bun run test`. Fail-closed: a
 * spawn error or timeout is a red run. The summary names the command and its
 * source so landing refusals are explainable.
 */
export async function defaultSuiteRunner(cwd: string): Promise<SuiteRun> {
  const config = await loadConfig(cwd)
  let command: readonly string[]
  let source: string
  if (config.landTestCommand !== undefined) {
    command = config.landTestCommand
    source = 'landTestCommand config'
  } else {
    const detected = await detectLandTestCommand(cwd)
    if (detected !== null) {
      command = detected.command
      source = `repo detection via ${detected.signal}`
    } else {
      command = [...DEFAULT_LAND_TEST_COMMAND]
      source = 'default'
    }
  }
  const header = `land test command: ${command.join(' ')} (${source})`
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
    return {
      ok: true,
      summary: `${header}\n${suiteSummary(`${stdout}\n${stderr}`)}`,
    }
  } catch (error: unknown) {
    const err = error as {
      stdout?: string
      stderr?: string
      message?: string
    }
    return {
      ok: false,
      summary: `${header}\n${suiteSummary(
        `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? 'suite runner failed'}`,
      )}`,
    }
  }
}

/** Where the suite runs: the flow's worktree when bound, else the cwd. */
export function landingSuiteCwd(): string {
  return getFlowWorktree()?.path ?? process.cwd()
}

// AIDEV-NOTE: PMR-4S6V — HEAD-pin anchor for receipt adoption (PMR-05HX:
// never land work the gate has not seen a green suite over — unresolvable
// HEAD -> no adoption, full suite re-run). Returns null on any error.
// PMR-1TCN — optional cwd param: the code_review tool passes its RESOLVED
// review worktree path so the receipt pins that tree's HEAD; with no arg
// (the land tool's own adoption/record call sites) it still resolves
// landingSuiteCwd() exactly as before.
export async function defaultResolveHead(cwd?: string): Promise<string | null> {
  let headCwd: string
  if (cwd !== undefined) {
    headCwd = cwd
  } else {
    headCwd = landingSuiteCwd()
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: headCwd,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

// PMR-VDVJ phase 4 — main-checkout / landing-branch resolvers for the
// merge-main exact-command contract. Injected so tests never run real git.
export type MainRepoResolver = () => Promise<string | null>
export type LandingBranchResolver = () => Promise<string | null>

// AIDEV-NOTE: same parsing as worktree/index.ts mainCheckout — first
// `worktree <path>` line of `git worktree list --porcelain`. Run in the
// landing suite cwd (flow worktree when bound, else cwd). Fail-closed: any
// error or empty output returns null, which refuses the landing.
export async function defaultResolveMainRepo(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: landingSuiteCwd() },
    )
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const repoPath = line.slice('worktree '.length).trim()
        if (repoPath.length > 0) return repoPath
      }
    }
    return null
  } catch {
    return null
  }
}

// AIDEV-NOTE: the bound flow worktree's branch wins (flow/worktree-context.ts);
// fallback is `git rev-parse --abbrev-ref HEAD` in the landing suite cwd.
export async function defaultResolveLandingBranch(): Promise<string | null> {
  const bound = getFlowWorktree()?.branch
  if (bound !== undefined) return bound
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: landingSuiteCwd() },
    )
    const branch = stdout.trim()
    if (branch.length === 0) return null
    return branch
  } catch {
    return null
  }
}

export function registerLandTool(
  pi: ExtensionAPI,
  state: LandingState,
  // AIDEV-NOTE: PMR-VZEV — active-ref getter from the flow loop; null when
  // no flow is in flight (hand-run landing outside a flow is allowed).
  activeRef: () => string | null,
  // AIDEV-NOTE: PMR-05HX — injected so tests never run a real suite.
  runSuite: SuiteRunner,
  // AIDEV-NOTE: PMR-R5VB — durable aven answer reader for the merge-main
  // human-review gate (null = absent or read failure -> marker-only).
  readReviewAnswer: ReviewAnswerReader,
  receipts: ReceiptJournal = createReceiptJournal(getAgentDir()),
  // AIDEV-NOTE: PMR-4S6V — receipts adopt only when the worktree HEAD is
  // unchanged since the committed transition (PMR-05HX: never land work
  // the gate has not seen a green suite over). Null = unresolvable -> no adoption.
  resolveHead: () => Promise<string | null> = defaultResolveHead,
  // AIDEV-NOTE: PMR-XTQQ — mode-aware writer (server/writer.ts). Present =
  // receipt writes route through it (journal-only while the daemon owns the
  // projection); absent = today's exact full-writer behavior.
  writer?: EventWriter,
  // AIDEV-NOTE: PMR-VDVJ — strict effect journal (run-state.ts). route=pr
  // declares git-push + gh-pr-create through it BEFORE setting `authorized`;
  // a failed declaration refuses the landing (fail-closed).
  effects: EffectJournal = createEffectJournal(getAgentDir()),
  // AIDEV-NOTE: PMR-VDVJ phase 4 — merge-main pins the EXACT merge command:
  // resolve the main checkout + landing branch, declare the merge-main
  // effect with that command, then set mergeAuthorized. Injected so tests
  // never run real git.
  resolveMainRepo: MainRepoResolver = defaultResolveMainRepo,
  resolveLandingBranch: LandingBranchResolver = defaultResolveLandingBranch,
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
    name: 'flow_land',
    label: 'flow land',
    description:
      'Gate a flow landing: verifies the review-passed label (and an optional review artifact verdict) for the ref. route=pr (work) then authorizes git push / gh pr create for it; route=merge-main (personal) does NOT authorize a push — merge the branch into main locally instead. Direct git push / gh pr create are blocked while the flow is active, and stay blocked for route=merge-main.',
    promptSnippet:
      'Gated landing for PIV flow runs — call before pushing the branch or creating the PR.',
    promptGuidelines: [
      'Call flow_land AFTER flow_phase_complete(phase="validate") and BEFORE git push / gh pr create — direct landing commands are blocked until it returns ok.',
      'For route=merge-main (personal), collect the human pass first — via the code_review tool (in-session) or the human-only /flow answer <ref> pass (durable, accepted cross-session) — flow_land refuses until one of them has passed for the ref. After ok, flow_land resolves the main checkout and landing branch itself and returns the EXACT pinned merge command — run that command verbatim. NEVER push.',
      'flow_land runs the test suite itself before authorizing (landTestCommand config, default bun run test) — a red suite refuses the landing with the failing output. Never claim tests are green to skip it; the gate does not read claims.',
      'A refusal carries the gate reason (missing review-passed label, blockers in the artifact, missing human code-review pass, red test suite); fix the cause, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      route: Type.Union([Type.Literal('pr'), Type.Literal('merge-main')], {
        description:
          'pr: create a PR via gh (work mode). merge-main: flow_land resolves and pins the exact git -C <main repo> merge --ff-only <branch> command — run the pinned command verbatim; never a push (personal mode).',
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
      // AIDEV-NOTE: PMR-R5VB — two accepted routes: the in-session marker
      // (short-circuits, the durable read is skipped) OR a durable 'pass'
      // aven answer. Null on read failure or absence -> refusal (fail
      // closed by construction); 'fail' also refuses. The refusal names
      // both routes so the agent can route the human to either.
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
      // AIDEV-NOTE: PMR-C6AK — the merge-main human pass has durable twins
      // (PMR-XTQQ/5.2 + PMR-R5VB): when the in-memory marker is absent
      // (session reopen or resetLandingState — it clears ONLY the marker,
      // never the journal), a pass is adopted from either durable source:
      // a code_review receipt pinned to the CURRENT HEAD (command=
      // 'code_review', target=ref; exact headSha equality only — a moved
      // HEAD is work the gate's human pass never saw), or the human-only
      // /flow answer <ref> pass record (readReviewAnswer dep, fail-closed).
      // In-memory match short-circuits.
      let humanGateAdopted: 'receipt' | 'answer' | false = false
      if (
        params.route === 'merge-main' &&
        state.humanReviewPassed !== params.ref
      ) {
        const head = await resolveHead()
        if (head !== null) {
          const pass = await effectiveReceipts.find({
            ref: params.ref,
            command: 'code_review',
            target: params.ref,
            headSha: head,
          })
          if (pass !== null) humanGateAdopted = 'receipt'
        }
        if (!humanGateAdopted) {
          const durable = await readReviewAnswer(params.ref)
          if (durable === 'pass') humanGateAdopted = 'answer'
        }
        if (!humanGateAdopted) {
          return toolResult(
            `flow_land refused landing ${params.ref} via merge-main: the human code-review gate has not passed — call the code_review tool with ref=${params.ref} and collect the human's pass (in-session), or have the human run /flow answer ${params.ref} pass (human-only; accepted cross-session)`,
            { ok: false, reason: 'human code-review gate not passed' },
            { isError: true },
          )
        }
      }
      let humanGateNote = ''
      if (humanGateAdopted === 'receipt') {
        humanGateNote =
          ' Human code-review pass adopted from the code_review receipt (HEAD unchanged) — no fresh pass was needed.'
      } else if (humanGateAdopted === 'answer') {
        humanGateNote =
          ' Human code-review pass adopted from the human-only /flow answer pass — no fresh pass was needed.'
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
      // AIDEV-NOTE: PMR-4S6V — best-effort receipt adoption: on a hit for
      // (ref, flow_land, route) with unchanged HEAD, return the stored ok
      // WITHOUT re-running the suite. Gate order is unchanged — a receipt
      // only ever skips the suite, never the ref/human/labels gates above.
      const head = await resolveHead()
      if (head !== null) {
        const stored = await effectiveReceipts.find({
          ref: params.ref,
          command: 'flow_land',
          target: params.route,
          headSha: head,
        })
        if (stored !== null) {
          if (params.route === 'pr') {
            const declared = await declarePushEffects(effects, params.ref, head)
            if (!declared.ok) {
              return toolResult(
                `flow_land refused landing ${params.ref} via pr: ${declared.reason} — the landing is NOT authorized`,
                { ok: false, reason: 'effect declaration failed' },
                { isError: true },
              )
            }
            state.authorized = params.ref
            return toolResult(
              `flow_land: landing for ${params.ref} authorized via pr — adopted the stored receipt from ${stored.at} (HEAD unchanged) — the suite was NOT re-run — run the git push / gh pr create step now`,
              { ok: true, reason: '' },
            )
          }
          const merge = await authorizeMergeMain(
            state,
            effects,
            params.ref,
            head,
            resolveMainRepo,
            resolveLandingBranch,
          )
          if (!merge.ok) {
            return toolResult(
              `flow_land refused landing ${params.ref} via merge-main: ${merge.reason} — the landing is NOT authorized`,
              { ok: false, reason: 'merge-main authorization failed' },
              { isError: true },
            )
          }
          return toolResult(
            `flow_land: landing for ${params.ref} gated ok via merge-main — adopted the stored receipt from ${stored.at} (HEAD unchanged) — the suite was NOT re-run.${humanGateNote}${mergeOkNote(merge.command)}`,
            { ok: true, reason: '' },
          )
        }
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
      // AIDEV-NOTE: PMR-4S6V — best-effort receipt record after a green
      // suite (both routes); a journal failure never blocks authorization.
      try {
        await effectiveReceipts.record({
          ref: params.ref,
          command: 'flow_land',
          target: params.route,
          headSha: head ?? undefined,
        })
      } catch {
        // best-effort — journal failures never block a gate transition
      }
      // AIDEV-NOTE: PMR-HYZA — only work mode's PR route releases the
      // interceptor's git push / gh pr create block. merge-main keeps
      // `authorized` null: the landing is a local ff-only merge, never a
      // push, so a git push after ok must stay blocked.
      // AIDEV-NOTE: PMR-VDVJ — both route=pr success paths declare the push
      // effects BEFORE setting `authorized`: declarations are fail-closed,
      // receipts stay best-effort — the deliberate split (plan Key decision
      // 3). On a failed declaration the landing is NOT authorized (any suite
      // cost already spent is accepted; correctness first). Phase 4:
      // route=merge-main runs the exact-command contract (authorizeMergeMain)
      // instead — declare the pinned merge command, then set mergeAuthorized.
      if (params.route === 'merge-main') {
        const merge = await authorizeMergeMain(
          state,
          effects,
          params.ref,
          head,
          resolveMainRepo,
          resolveLandingBranch,
        )
        if (!merge.ok) {
          return toolResult(
            `flow_land refused landing ${params.ref} via merge-main: ${merge.reason} — the landing is NOT authorized`,
            { ok: false, reason: 'merge-main authorization failed' },
            { isError: true },
          )
        }
        return toolResult(
          `flow_land: landing for ${params.ref} gated ok via merge-main${humanGateNote} — the suite ran green just now.${mergeOkNote(merge.command)}`,
          { ok: true, reason: '' },
        )
      }
      const declared = await declarePushEffects(effects, params.ref, head)
      if (!declared.ok) {
        return toolResult(
          `flow_land refused landing ${params.ref} via pr: ${declared.reason} — the landing is NOT authorized`,
          { ok: false, reason: 'effect declaration failed' },
          { isError: true },
        )
      }
      state.authorized = params.ref
      return toolResult(
        `flow_land: landing for ${params.ref} authorized via pr — run the git push / gh pr create step now`,
        { ok: true, reason: '' },
      )
    },
  })
}
