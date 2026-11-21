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
// AIDEV-NOTE: PMR-R5VB phase 4 — the agent-attested fallback (PMR-3ZY1
// decision 4, the outcome="pass" parameter) was REMOVED: fail closed. The
// blocking ask_user_question gate is now the ONLY in-session pass route;
// when the ask extension is absent the tool returns an isError refusal
// directing the human to the durable, human-only /flow answer <ref>
// pass|fail command (accepted by flow_land). No code path here sets
// humanReviewPassed outside that blocking ask.
import { existsSync } from 'node:fs'
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { writeAvenNote } from '../aven/client.ts'
import { healFlowBinding } from '../flow/binding-heal.ts'
import { getFlowWorktree } from '../flow/worktree-context.ts'
import { createReceiptJournal, type ReceiptJournal } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { worktreeList } from '../worktree/herdr.ts'
import {
  openTuicrReview,
  parseAskAnswer,
  pickLatestSessionSlug,
  type ReviewDeps,
  routeReviewFail,
  routeReviewPass,
} from './code-review-parse.ts'
import { defaultResolveHead } from './land.ts'
import { toolResult } from './result.ts'

export { buildCodeReviewGatePrompt } from './code-review-parse.ts'

// AIDEV-NOTE: PMR-0KMQ — shared factory: the fresh-context review gate
// (review/review.ts, commit mode) and the deviation gate (tools/deviation.ts)
// reuse this exact wiring so all three gates resolve the same VERIFIED bound
// flow worktree (resolveReviewWorktree: binding → aven note → herdr, each
// candidate verified via common-git-dir + branch). Takes a bare repoRoot
// instead of the tool context so non-code-review callers can pass ctx.cwd.
export function productionReviewDeps(
  pi: ExtensionAPI,
  repoRoot: string,
): ReviewDeps {
  return {
    getFlowWorktree,
    avenShowFull: async (ref: string) => {
      const result = await pi.exec('aven', ['show', ref, '--full'], {
        cwd: repoRoot,
      })
      if (result.code !== 0) {
        throw new Error(result.stderr || `aven show ${ref} failed`)
      }
      return result.stdout
    },
    herdrWorktreeList: () => worktreeList(pi, repoRoot),
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      const result = await pi.exec(cmd, args, {
        cwd: opts?.cwd ?? repoRoot,
      })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
    exists: (p: string) => existsSync(p),
    repoRoot,
  }
}

export function registerCodeReviewTool(
  pi: ExtensionAPI,
  landingState: { authorized: string | null; humanReviewPassed: string | null },
  receipts: ReceiptJournal = createReceiptJournal(getAgentDir()),
  // AIDEV-NOTE: PMR-XTQQ 5.1 — injected HEAD resolution for the durable pass
  // receipt; same worktree-scoped shape as flow_land's adoption pin.
  // AIDEV-NOTE: PMR-1TCN — the seam is now worktree-scoped: callers pass the
  // RESOLVED REVIEW WORKTREE path (the tree the tuicr run saw), so the
  // receipt pins that tree's HEAD. Historical only (pre-PMR-1TCN behavior,
  // no longer true): the old zero-arg default resolved landingSuiteCwd(),
  // whose no-binding fallback was process.cwd() — a tree the tuicr run may
  // never have seen.
  resolveHead: (cwd: string) => Promise<string | null> = defaultResolveHead,
  // AIDEV-NOTE: PMR-XTQQ — mode-aware writer (server/writer.ts). Present =
  // receipt writes route through it (journal-only while the daemon owns the
  // projection); absent = today's exact full-writer behavior.
  writer?: EventWriter,
): void {
  let effectiveReceipts = receipts
  if (writer !== undefined) {
    effectiveReceipts = createReceiptJournal(
      getAgentDir(),
      undefined,
      writer.record,
    )
  }
  // AIDEV-NOTE: PMR-XTQQ 5.1 — durable twin of humanReviewPassed: after a
  // HUMAN pass, best-effort record a headSha-pinned code_review receipt
  // (target=ref). In-memory marker is still set first — resolveHead failure
  // or a journal error degrades to today's session-scoped behavior, never
  // blocks the pass. flow_land adoption of this receipt is PMR-XTQQ 5.2.
  // AIDEV-NOTE: PMR-1TCN — resolveHead is called with the resolved review
  // worktree path, NOT landingSuiteCwd(): the receipt must pin the exact
  // worktree HEAD the reviewed tuicr run saw.
  const recordPassReceipt = async (
    ref: string,
    worktreePath: string,
  ): Promise<void> => {
    let head: string | null
    try {
      head = await resolveHead(worktreePath)
    } catch {
      return
    }
    if (head === null) return
    await effectiveReceipts.record({
      ref,
      command: 'code_review',
      target: ref,
      headSha: head,
    })
  }
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
      'When ask_user_question is unavailable, code_review fails closed — direct the human to run /flow answer <ref> pass|fail; never re-call with an outcome param (it no longer exists).',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: string },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      // AIDEV-NOTE: PMR-R5VB phase 4 — the ask availability check that fed
      // the removed agent-attested fallback is gone; ask_user_question is
      // re-looked-up below the tuicr open.

      const deps = productionReviewDeps(pi, ctx.cwd)
      // AIDEV-NOTE: PMR-DRKH — heal-first: the module binding dies on a pi
      // reload (PMR-PJM0), so the resolve doubles as a re-arm. Failure keeps
      // the refusal prefix verbatim (existing regexes are substring matches)
      // and appends only the recovery line.
      const heal = await healFlowBinding(params.ref, deps)
      if (!heal.ok) {
        return toolResult(
          `code_review refused: ${heal.reason}\nRecovery: run ${heal.recovery} to re-arm the flow binding, then re-call.`,
          { ok: false, reason: heal.reason },
          { isError: true },
        )
      }
      const worktree = heal.worktree

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
        // AIDEV-NOTE: PMR-R5VB phase 4 — fail closed. The old agent-attested
        // fallback (re-call with outcome="pass") is gone; a pass recorded
        // here would rest on the agent's word alone. The human records the
        // verdict durably via the human-only /flow answer command, which
        // flow_land accepts for merge-main.
        return toolResult(
          `code_review: ask_user_question is unavailable — recording a pass here would be agent-attested, which is not allowed. The human records the verdict with the human-only command /flow answer ${params.ref} pass (or fail); flow_land accepts that durable answer for merge-main.\ntuicr is open for ${params.ref} in a herdr tab (${worktree.path}, ${worktree.branch || 'branch unverified'}).`,
          { ok: false, reason: 'ask extension unavailable' },
          { isError: true },
        )
      }

      const askResult = await ctx.executeTool('ask_user_question', {
        question: `Human code review of ${params.ref}: pass or fail?`,
        details: `tuicr is open in a herdr tab (${worktree.path}). Review the diff (branch scope), then answer.`,
        options: [
          { label: 'pass (Recommended)', value: 'pass' },
          { label: 'fail', value: 'fail' },
        ],
      })
      const answerText = askResult.result.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n')
      const answer = parseAskAnswer(answerText)
      if (answer === null) {
        return toolResult(
          // AIDEV-NOTE: PMR-G68P — updated for PMR-R5VB phase 4: the
          // outcome param no longer exists at all, so this branch simply
          // re-asks and routes back through the blocking gate; there is no
          // fallback to point the agent at.
          `code_review: the human's answer was unclear ("${answerText.slice(0, 200)}") — ask the human a plain pass/fail question again via ask_user_question, then re-call code_review with ref="${params.ref}" to record their answer through the blocking gate.`,
          { ok: false, reason: 'unclear answer' },
          { isError: true },
        )
      }
      if (answer === 'pass') {
        const routing = routeReviewPass(params.ref, new Date().toISOString())
        landingState.humanReviewPassed = routing.marker
        await recordPassReceipt(params.ref, worktree.path)
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
