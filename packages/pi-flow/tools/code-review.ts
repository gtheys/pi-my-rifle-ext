// AIDEV-NOTE: PMR-T8ZG — the human code-review gate for personal-mode flow
// runs (PMR-3ZY1). One core shared by the /code-review command (which sends
// the gate prompt) and the agent-callable code_review tool: resolve the
// ref's worktree (binding -> aven note -> herdr list, every hit verified —
// never open tuicr on the wrong tree), open tuicr in a focused herdr tab,
// then ask the human pass/fail via the ask_user_question EXTENSION tool.
// Pass records LandingState.humanReviewPassed (the flow_land CHECK for it is
// sibling ticket PMR-C6AK — deliberately NOT here). Fail records the tuicr
// findings as an aven note and routes back to /implement. The tool's I/O
// seams (ReviewDeps) are injected so tests assert the exact exec sequences.
// AIDEV-NOTE: agent-attested fallback (PMR-3ZY1 decision 4) — when the
// pi-ask-user-question extension is absent, the tool returns after opening
// tuicr and a second code_review call with outcome="pass" records the
// marker WITHOUT a blocking human ask. Weaker by design: the marker then
// rests on the agent's own question to the human, not on our blocking gate.
// Residual weakness: when the extension IS absent, the recorded pass is only
// agent-attested — we cannot distinguish "the agent really asked" from
// "the agent invented it". Scope is deliberately limited to that case: with
// ask_user_question available, outcome="pass" is refused (the blocking ask
// is the only sanctioned path).
import { existsSync } from 'node:fs'
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { writeAvenNote } from '../aven/client.ts'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import { worktreeList } from '../worktree/herdr.ts'
import {
  openTuicrReview,
  parseAskAnswer,
  pickLatestSessionSlug,
  type ResolvedWorktree,
  type ReviewDeps,
  resolveReviewWorktree,
  routeReviewFail,
  routeReviewPass,
} from './code-review-parse.ts'
import { toolResult } from './result.ts'

export { buildCodeReviewGatePrompt } from './code-review-parse.ts'

function productionDeps(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
): ReviewDeps {
  return {
    getFlowWorktree,
    avenShowFull: async (ref: string) => {
      const result = await pi.exec('aven', ['show', ref, '--full'], {
        cwd: ctx.cwd,
      })
      if (result.code !== 0) {
        throw new Error(result.stderr || `aven show ${ref} failed`)
      }
      return result.stdout
    },
    herdrWorktreeList: () => worktreeList(pi, ctx.cwd),
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      const result = await pi.exec(cmd, args, {
        cwd: opts?.cwd ?? ctx.cwd,
      })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
    exists: (p: string) => existsSync(p),
    repoRoot: ctx.cwd,
  }
}

export function registerCodeReviewTool(
  pi: ExtensionAPI,
  landingState: { authorized: string | null; humanReviewPassed: string | null },
): void {
  pi.registerTool({
    name: 'code_review',
    label: 'code review gate',
    description:
      "Human code-review gate for a flow run: resolves the ref's worktree, opens tuicr (branch-scope diff) in a focused herdr tab for the human, then asks them pass/fail. Pass records the human-review marker (required by flow_land merge-main later); fail records the tuicr findings as an aven note and routes back to /implement.",
    promptSnippet:
      'Human code-review gate — call for the active flow ref before flow_land (personal mode merge-main).',
    promptGuidelines: [
      'Call code_review with the flow ref when the validate phase reaches the human review gate (step H1).',
      'A failure result names what broke and the manual tuicr command — fix the cause or open it manually, then re-call.',
      'When ask_user_question is unavailable, ask the human yourself, then re-call code_review with outcome="pass" to record the marker.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      outcome: Type.Optional(
        Type.Union([Type.Literal('pass')], {
          description:
            'Fallback only: record an agent-attested pass after the human answered YOUR OWN ask_user_question (used when the nested ask is unavailable).',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: string; outcome?: 'pass' },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      const askAvailable =
        ctx.tools.find((t) => t.name === 'ask_user_question') !== undefined

      // Agent-attested fallback path: the human already answered the agent's
      // own ask — record the marker without a second blocking ask. ONLY valid
      // when the blocking gate is unavailable (PMR-3ZY1 decision 4); with the
      // extension present the agent could otherwise record a "human" pass
      // with no human involved.
      if (params.outcome === 'pass') {
        if (askAvailable) {
          return toolResult(
            `code_review refused: outcome="pass" is only allowed when ask_user_question is unavailable, and it IS available here. Re-call code_review with just ref="${params.ref}" and answer the blocking pass/fail question yourself (or via the human).`,
            { ok: false, reason: 'blocking ask available' },
            { isError: true },
          )
        }
        const routing = routeReviewPass(params.ref, new Date().toISOString())
        landingState.humanReviewPassed = routing.marker
        const noted = await writeAvenNote(params.ref, routing.avenNote)
        return toolResult(
          `${routing.message}${noted ? '' : '\n(warning: the aven note write failed — record it manually)'}`,
          { ok: true, reason: '' },
        )
      }

      const deps = productionDeps(pi, ctx)
      let worktree: ResolvedWorktree
      try {
        worktree = await resolveReviewWorktree(params.ref, deps)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return toolResult(
          `code_review refused: ${message}`,
          { ok: false, reason: message },
          { isError: true },
        )
      }

      const open = await openTuicrReview(params.ref, worktree.path, deps)
      if (open.ok) {
        ctx.ui.notify(
          `Opened tuicr for ${params.ref} in a herdr tab. Manual fallback: ${open.command}`,
          'info',
        )
      } else {
        return toolResult(
          `code_review: tuicr open failed — ${open.reason}\nOpen it manually: ${open.command}\nThen re-call code_review (ref="${params.ref}"); the gate ask proceeds on re-call.`,
          { ok: false, reason: open.reason },
          { isError: true },
        )
      }

      const askTool = ctx.tools.find((t) => t.name === 'ask_user_question')
      if (askTool === undefined) {
        return toolResult(
          `code_review: tuicr is open for ${params.ref} (${worktree.path}, ${worktree.branch || 'branch unverified'}). ask_user_question is not callable from tools — ask the human pass/fail yourself via ask_user_question, then re-call code_review with ref="${params.ref}" outcome="pass" (or handle the fail per their answer).`,
          { ok: true, reason: 'ask extension unavailable' },
        )
      }

      const outcome = await ctx.executeTool('ask_user_question', {
        question: `Human code review of ${params.ref}: pass or fail?`,
        details: `tuicr is open in a herdr tab (${worktree.path}). Review the diff (branch scope), then answer.`,
        options: [
          { label: 'pass (Recommended)', value: 'pass' },
          { label: 'fail', value: 'fail' },
        ],
      })
      const answerText = outcome.result.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n')
      const answer = parseAskAnswer(answerText)
      if (answer === null) {
        return toolResult(
          // AIDEV-NOTE: PMR-G68P — do NOT point the agent at outcome="pass"
          // here: this branch only runs when ask_user_question IS available,
          // and outcome="pass" is refused in that case (727b939).
          `code_review: the human's answer was unclear ("${answerText.slice(0, 200)}") — ask the human a plain pass/fail question again via ask_user_question, then re-call code_review with ref="${params.ref}" (no outcome) to record their answer through the blocking gate.`,
          { ok: false, reason: 'unclear answer' },
          { isError: true },
        )
      }
      if (answer === 'pass') {
        const routing = routeReviewPass(params.ref, new Date().toISOString())
        landingState.humanReviewPassed = routing.marker
        const noted = await writeAvenNote(params.ref, routing.avenNote)
        return toolResult(
          `${routing.message}${noted ? '' : '\n(warning: the aven note write failed — record it manually)'}`,
          { ok: true, reason: '' },
        )
      }

      // Fail: read the findings from the persisted tuicr session.
      let comments = ''
      let listResult = { code: 0, stdout: '', stderr: '' }
      try {
        listResult = await pi.exec(
          'tuicr',
          ['review', 'list', '--repo', worktree.path],
          { cwd: worktree.path },
        )
        const slug = pickLatestSessionSlug(listResult.stdout)
        if (listResult.code === 0 && slug !== null) {
          const commentsResult = await pi.exec(
            'tuicr',
            ['review', 'comments', '--session', slug, '--repo', worktree.path],
            { cwd: worktree.path },
          )
          if (commentsResult.code === 0) {
            comments = commentsResult.stdout
          }
        }
      } catch {
        // fall through to the free-text fallback below
      }
      const routing = routeReviewFail(params.ref, comments)
      if (routing.freeTextFallback) {
        const described = await ctx.executeTool('ask_user_question', {
          question: `What should the findings note for ${params.ref} say?`,
          details:
            'The tuicr session has no recorded comments. Describe the findings to record.',
        })
        const text = described.result.content
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n')
        const cleaned = text.replace(/^User (answered|selected): ?/i, '').trim()
        if (cleaned.length > 0) {
          const noted = await writeAvenNote(params.ref, cleaned)
          return toolResult(
            `code_review: human FAIL for ${params.ref} — findings recorded as an aven note. Route back to /implement ${params.ref} (retry budget applies). STOP.${noted ? '' : '\n(warning: the aven note write failed — record it manually)'}`,
            { ok: false, reason: 'human fail' },
            { isError: true },
          )
        }
        return toolResult(
          routing.message,
          { ok: false, reason: 'human fail' },
          {
            isError: true,
          },
        )
      }
      const noted = await writeAvenNote(params.ref, routing.avenNote)
      return toolResult(
        `${routing.message}${noted ? '' : '\n(warning: the aven note write failed — record it manually)'}`,
        { ok: false, reason: 'human fail' },
        { isError: true },
      )
    },
  })
}
