/**
 * PR Quality Extension
 *
 * Combines GitHub PR unresolved review comments with SonarCloud analysis for
 * the same PR, then sends a unified context message to the LLM so it can:
 *   - Triage each review thread (VALID / INVALID)
 *   - Auto-resolve INVALID threads via GitHub GraphQL
 *   - Cross-reference VALID comments with SonarCloud issues by file
 *   - Fix issues immediately — no plan file written
 *
 * Prerequisites:
 *   - gh CLI installed and authenticated
 *   - SONARQUBE_TOKEN env var set (get from https://sonarcloud.io/account/security)
 *   - sonar-project.properties in repo root (or SONAR_PROJECT_KEY + SONAR_ORGANIZATION env vars)
 *
 * Usage:
 *   /pr-quality          — auto-detect PR from current branch
 *   /pr-quality 283      — explicit PR number
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  analyzeCoverage,
  analyzeIssues,
  type CoverageResponse,
  detectPrNumber,
  detectSonarConfig,
  fetchAllIssues,
  type IssuesAnalysis,
  localExec,
  SEVERITY_SYMBOLS,
  type SonarConfig,
  type SonarIssue,
  sonarFetch,
  TYPE_SYMBOLS,
} from '../shared/sonarqube-utils.ts'

// ── GitHub types ──────────────────────────────────────────────────────────────

export interface CheckRun {
  name: string
  status: string // "QUEUED" | "IN_PROGRESS" | "COMPLETED"
  conclusion: string | null // "SUCCESS" | "FAILURE" | "CANCELLED" | "SKIPPED" | ...
  workflowName?: string
}

interface GhComment {
  author: string
  body: string
  createdAt: string
  url: string
}

interface GhReviewThread {
  threadId: string
  path: string
  line: number | null
  startLine: number | null
  isOutdated: boolean
  comments: GhComment[]
}

export interface GhPrData {
  pr_title: string
  pr_url: string
  total_review_threads: number
  unresolved_count: number
  unresolved_threads: GhReviewThread[]
}

// ── GH Actions check ────────────────────────────────────────────────────────

interface ActionsStatus {
  complete: boolean
  pending: CheckRun[]
  all: CheckRun[]
}

// AIDEV-NOTE: Uses statusCheckRollup from gh pr view — covers both GitHub
// Actions CheckRuns and external status checks (e.g. SonarCloud gate itself).
async function checkActionsComplete(
  prNumber: string,
  cwd?: string,
): Promise<ActionsStatus> {
  const result = await localExec(
    'gh',
    ['pr', 'view', prNumber, '--json', 'statusCheckRollup'],
    { timeout: 15000, cwd },
  )

  if (result.code !== 0) {
    throw new Error(`gh pr view failed: ${result.stderr || result.stdout}`)
  }

  const data = JSON.parse(result.stdout) as { statusCheckRollup?: CheckRun[] }
  const checks = data.statusCheckRollup ?? []

  // AIDEV-NOTE: Skip checks with conclusion "SKIPPED" — they never become
  // COMPLETED in the traditional sense but do not block the workflow.
  const relevant = checks.filter((c) => c.conclusion !== 'SKIPPED')
  const pending = relevant.filter((c) => c.status !== 'COMPLETED')

  return { complete: pending.length === 0, pending, all: checks }
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args: string): { prNumber?: string } {
  const match = args.trim().match(/^(\d+)/)
  return { prNumber: match?.[1] }
}

// ── GitHub PR comment fetching ────────────────────────────────────────────────

// AIDEV-NOTE: Uses inline GraphQL via `gh api graphql` so the extension has no
// dependency on the fetch_unresolved_comments.sh shell script. Same query as
// the gh-unresolved-comments skill.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      title
      url
      reviewThreads(first: $limit) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 10) {
            nodes {
              body
              author { login }
              createdAt
              url
            }
          }
        }
      }
    }
  }
}
`.trim()

async function fetchUnresolvedThreads(prNumber: string): Promise<GhPrData> {
  const result = await localExec(
    'gh',
    [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-F',
      'owner={owner}',
      '-F',
      'repo={repo}',
      '-F',
      `pr=${prNumber}`,
      '-F',
      'limit=100',
    ],
    { timeout: 30000 },
  )

  if (result.code !== 0) {
    throw new Error(
      `gh GraphQL query failed: ${result.stderr || result.stdout}`,
    )
  }

  // AIDEV-NOTE: `gh api graphql` with `-F owner={owner}` uses the repo owner
  // inferred from the current git remote — same behaviour as the skill script.
  const raw = JSON.parse(result.stdout)
  const pr = raw?.data?.repository?.pullRequest
  if (!pr) {
    throw new Error(
      'GitHub GraphQL returned no pull request data. Check PR number and repo access.',
    )
  }

  const allThreads = pr.reviewThreads?.nodes ?? []
  const unresolved: GhReviewThread[] = allThreads
    .filter((t: { isResolved: boolean }) => !t.isResolved)
    .map(
      (t: {
        id: string
        path: string
        line: number | null
        startLine: number | null
        isOutdated: boolean
        comments: {
          nodes: Array<{
            body: string
            author: { login: string }
            createdAt: string
            url: string
          }>
        }
      }) => ({
        threadId: t.id,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        isOutdated: t.isOutdated,
        comments: (t.comments?.nodes ?? []).map((c) => ({
          author: c.author?.login ?? 'unknown',
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      }),
    )

  return {
    pr_title: pr.title,
    pr_url: pr.url,
    total_review_threads: pr.reviewThreads?.totalCount ?? 0,
    unresolved_count: unresolved.length,
    unresolved_threads: unresolved,
  }
}

// ── Prompt construction ───────────────────────────────────────────────────────

// AIDEV-NOTE: The prompt is intentionally verbose and structured so the LLM has
// clear, step-by-step instructions for both the triage and the SonarQube fix
// tasks. The file is written to disk so the agent can read it back if it gets
// compacted mid-task.
function buildAgentPrompt(
  prNumber: string,
  prData: GhPrData,
  sonarConfig: SonarConfig,
  issues: IssuesAnalysis,
  coverageData: ReturnType<typeof analyzeCoverage>,
): string {
  const lines: string[] = []

  lines.push(`# PR Quality Check — PR #${prNumber}: ${prData.pr_title}`)
  lines.push(`> ${prData.pr_url}`)
  lines.push('')

  // ── Section 1: instructions ─────────────────────────────────────────────
  lines.push('## Your Tasks')
  lines.push('')
  lines.push(
    'You have two data sources below. Triage first, then fix immediately. Do NOT write a plan file.',
  )
  lines.push('')
  // AIDEV-NOTE: Success-criteria preamble added from workflow-hygiene review
  // 2026-10 — every /pr-quality session lacked explicit done-when/verification.
  lines.push('### Success criteria (read first)')
  lines.push('')
  lines.push(
    '- **Goal:** every unresolved review thread is fixed or resolved, and all BLOCKER/CRITICAL SonarCloud issues are fixed.',
  )
  lines.push(
    '- **Constraints:** fix only what the two data sources flag — no drive-by refactors. Follow repo lint/style rules. Never resolve a thread as INVALID without a one-line justification.',
  )
  lines.push(
    '- **Done when:** VALID threads fixed, INVALID threads resolved, BLOCKER/CRITICAL issues fixed or explicitly skipped with a reason, tests pass, fixes committed referencing the PR.',
  )
  lines.push(
    '- **Verification:** run the repo test suite (its documented runner) after fixes; `git diff --stat` shows only intended files.',
  )
  lines.push(
    '- **Circuit breaker:** if the same command or API call fails 3 times in a row, stop retrying — report what failed and what remains.',
  )
  lines.push('')
  lines.push('### Task A — Triage & Fix GitHub Review Comments')
  lines.push('')
  lines.push(
    'For each unresolved thread in **Section 2**, read the referenced file at the given line, then classify the thread:',
  )
  lines.push('')
  lines.push('**VALID** — needs action:')
  lines.push('  - Real bug, security issue, or logic error')
  lines.push(
    '  - Meaningful improvement to quality, readability, or performance',
  )
  lines.push('  - Legitimate architectural / design concern')
  lines.push('  - Missing error handling, edge cases, or tests')
  lines.push('')
  lines.push('**INVALID** — dismiss:')
  lines.push('  - Code already changed or fixed (outdated diff)')
  lines.push('  - Style nitpick with no functional impact')
  lines.push("  - Based on a misunderstanding of the code's intent")
  lines.push('  - Already answered elsewhere in the PR')
  lines.push('')
  lines.push('For every **INVALID** thread, auto-resolve it via:')
  lines.push('```bash')
  lines.push(
    `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_ID>"}) { thread { isResolved } } }'`,
  )
  lines.push('```')
  lines.push('(Replace `<THREAD_ID>` with the threadId from Section 2.)')
  lines.push('')
  lines.push('For every **VALID** thread, **fix the issue now**:')
  lines.push('  1. Read the file at the referenced line.')
  lines.push('  2. Apply the fix directly using your edit tools.')
  lines.push('  3. Run tests to confirm nothing is broken.')
  lines.push('')
  lines.push('### Task B — Fix SonarCloud Issues')
  lines.push('')
  lines.push(
    'Using the SonarCloud data in **Section 3**, fix issues in severity order (BLOCKER → CRITICAL → MAJOR).',
  )
  lines.push(
    'Prioritise files that also have VALID review comments — fix both at once.',
  )
  lines.push('For each issue: read the file, apply the fix, run tests.')
  lines.push('')
  lines.push('### Task C — Final Summary')
  lines.push('')
  lines.push('After all fixes are applied and tests pass:')
  lines.push('  - Run `git diff --stat` to confirm scope of changes.')
  lines.push(
    '  - Present the final summary in three lists: **Fixed** (item → what changed),',
  )
  lines.push(
    '    **Resolved as INVALID** (thread → one-line justification), **Skipped** (item → why).',
  )
  lines.push(
    '  - Commit the fixes with a clear message referencing the PR number.',
  )
  lines.push('')

  // ── Section 2: review threads ────────────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push(
    `## Section 2 — Unresolved Review Threads (${prData.unresolved_count})`,
  )
  lines.push('')

  if (prData.unresolved_count === 0) {
    lines.push('_No unresolved threads. Skip Task A._')
  } else {
    for (const [i, thread] of prData.unresolved_threads.entries()) {
      let loc: string
      if (thread.line) {
        loc = `${thread.path}:${thread.line}`
      } else {
        loc = thread.path
      }
      let outdated: string
      if (thread.isOutdated) {
        outdated = ' _(outdated diff)_'
      } else {
        outdated = ''
      }
      lines.push(`### Thread ${i + 1} — \`${loc}\`${outdated}`)
      lines.push(`**threadId:** \`${thread.threadId}\``)
      lines.push('')
      for (const c of thread.comments) {
        lines.push(`**@${c.author}** (${c.createdAt.slice(0, 10)}):`)
        lines.push(`> ${c.body.split('\n').join('\n> ')}`)
        lines.push(`[View on GitHub](${c.url})`)
        lines.push('')
      }
    }
  }

  // ── Section 3: SonarCloud ────────────────────────────────────────────────
  lines.push('---')
  lines.push('')
  lines.push('## Section 3 — SonarCloud Analysis')
  lines.push('')
  lines.push(`**Project:** \`${sonarConfig.projectKey}\``)
  lines.push('')

  // Coverage summary
  lines.push('### Coverage')
  lines.push(`| Metric | Value | Status |`)
  lines.push(`|--------|-------|--------|`)
  lines.push(
    `| Overall Line | ${coverageData.overallCoverage}% | ${coverageData.icons.overall} ${coverageData.status.overall} |`,
  )
  lines.push(
    `| New Code | ${coverageData.newCoverage}% | ${coverageData.icons.newCode} ${coverageData.status.newCode} |`,
  )
  lines.push(
    `| Branch | ${coverageData.branchCoverage}% | ${coverageData.icons.branch} ${coverageData.status.branch} |`,
  )
  lines.push(
    `| New Branch | ${coverageData.newBranchCoverage}% | ${coverageData.icons.newBranch} ${coverageData.status.newBranch} |`,
  )
  lines.push(
    `| Uncovered Lines | ${coverageData.uncoveredLines} / ${coverageData.linesToCover} | — |`,
  )
  lines.push('')

  // Issues summary
  lines.push('### Issues')
  lines.push(`**Total:** ${issues.total}`)
  lines.push('')

  if (issues.total > 0) {
    lines.push('**By Severity:**')
    for (const [sev, count] of Object.entries(issues.bySeverity)) {
      lines.push(`  - ${SEVERITY_SYMBOLS[sev] ?? '❓'} ${sev}: ${count}`)
    }
    lines.push('')

    lines.push('**By Type:**')
    for (const [type, count] of Object.entries(issues.byType)) {
      lines.push(`  - ${TYPE_SYMBOLS[type] ?? '❓'} ${type}: ${count}`)
    }
    lines.push('')

    // Per-file issues (top 15)
    if (issues.byFile.length > 0) {
      lines.push('### Issues by File (top 15)')
      lines.push('')
      for (const f of issues.byFile.slice(0, 15)) {
        lines.push(`#### \`${f.file}\` — ${f.count} issue(s)`)
        for (const issue of f.issues.slice(0, 20)) {
          let loc: string
          if (issue.line) {
            loc = `:${issue.line}`
          } else {
            loc = ''
          }
          const sym = SEVERITY_SYMBOLS[issue.severity] ?? '❓'
          const typeSym = TYPE_SYMBOLS[issue.type] ?? '❓'
          lines.push(
            `- ${sym} ${typeSym} **${issue.severity}** \`${issue.rule}\`${loc} — ${issue.message}`,
          )
        }
        lines.push('')
      }
    }

    // Top rules
    if (issues.byRule.length > 0) {
      lines.push('### Top Violated Rules')
      for (const r of issues.byRule) {
        lines.push(
          `- \`${r.rule}\` (${r.severity}) × ${r.count} — "${r.message}"`,
        )
      }
      lines.push('')
    }
  }

  // SonarCloud link
  lines.push(
    `[View PR in SonarCloud](https://sonarcloud.io/project/pull_requests_list?id=${sonarConfig.projectKey}&pullRequest=${prNumber})`,
  )

  return lines.join('\n')
}

// ── Shared quality core ───────────────────────────────────────────────────────

export type PrQualityErrorKind =
  | 'token'
  | 'pr'
  | 'ci-pending'
  | 'config'
  | 'fetch'

// AIDEV-NOTE: Classified failure so the /pr-quality command and the pr_quality
// tool can map the same error to their own surfaces (notify vs isError result).
// The 'ci-pending' kind is deliberately NOT a hard failure for the command —
// it warns and returns — while the tool reports it as an isError result with
// the pending check names.
export class PrQualityError extends Error {
  kind: PrQualityErrorKind
  pending: CheckRun[]
  cause?: Error

  constructor(
    kind: PrQualityErrorKind,
    message: string,
    pending: CheckRun[] = [],
    cause?: Error,
  ) {
    super(message)
    this.kind = kind
    this.pending = pending
    this.cause = cause
  }
}

export interface PrQualityOptions {
  cwd: string
  prNumber?: string
  signal?: AbortSignal
  // AIDEV-NOTE: progress feed so the command keeps its original notify
  // updates; the tool leaves it unset.
  onProgress?: (message: string) => void
}

// Structured summary for the tool's `details` field — prompt text stays the
// single source of truth for the agent.
export interface PrQualityDetails {
  prNumber: string
  prTitle: string
  prUrl: string
  unresolvedCount: number
  issuesTotal: number
  issuesBySeverity: Record<string, number>
  projectKey: string
}

export interface PrQualityResult {
  prompt: string
  prNumber: string
  prData: GhPrData
  sonarConfig: SonarConfig
  coverage: ReturnType<typeof analyzeCoverage>
  issues: IssuesAnalysis
  details: PrQualityDetails
}

// AIDEV-NOTE: Shared pending-check formatter so the command's warning notify
// and the tool's isError text stay identical.
function describePending(pending: CheckRun[]): string {
  return pending
    .map((c) => {
      let wf: string
      if (c.workflowName) {
        wf = `${c.workflowName} / `
      } else {
        wf = ''
      }
      return `${wf}${c.name} (${c.status.toLowerCase()})`
    })
    .join(', ')
}

// AIDEV-NOTE: Shared core extracted from the /pr-quality command handler.
// Token guard → PR detect → CI guard → SonarCloud config → parallel fetch →
// analyze → buildAgentPrompt. The command sends the prompt via
// sendUserMessage; the pr_quality tool returns it as content. Errors are
// classified via PrQualityError.kind so each caller maps them to its own
// surface.
export async function gatherPrQualityData(
  options: PrQualityOptions,
): Promise<PrQualityResult> {
  const { cwd, signal, onProgress } = options
  const token = process.env.SONARQUBE_TOKEN
  if (!token) {
    throw new PrQualityError(
      'token',
      'SONARQUBE_TOKEN is not set. Get a token at https://sonarcloud.io/account/security',
    )
  }

  let prNumber: string
  if (options.prNumber) {
    prNumber = options.prNumber
  } else {
    try {
      prNumber = await detectPrNumber('/pr-quality')
    } catch (err) {
      throw new PrQualityError(
        'pr',
        String((err as Error).message),
        [],
        err as Error,
      )
    }
  }

  if (onProgress) {
    onProgress(`PR Quality: analyzing PR #${prNumber}...`)
  }

  let actionsStatus: ActionsStatus
  try {
    actionsStatus = await checkActionsComplete(prNumber, cwd)
  } catch (err) {
    throw new PrQualityError(
      'pr',
      `Could not check Actions status: ${(err as Error).message}`,
      [],
      err as Error,
    )
  }

  if (!actionsStatus.complete) {
    throw new PrQualityError(
      'ci-pending',
      `PR #${prNumber} CI not done yet — ${actionsStatus.pending.length} check(s) still running: ${describePending(actionsStatus.pending)}`,
      actionsStatus.pending,
    )
  }

  let sonarConfig: SonarConfig
  try {
    sonarConfig = await detectSonarConfig(cwd)
  } catch (err) {
    throw new PrQualityError(
      'config',
      String((err as Error).message),
      [],
      err as Error,
    )
  }

  if (onProgress) {
    onProgress('Fetching GitHub threads + SonarCloud data...')
  }

  // AIDEV-NOTE: GitHub and SonarCloud calls are independent — run them
  // concurrently to reduce total wall-clock time.
  let prData: GhPrData
  let coverageRaw: CoverageResponse
  let rawIssues: { issues: SonarIssue[]; total: number }
  try {
    ;[prData, coverageRaw, rawIssues] = await Promise.all([
      fetchUnresolvedThreads(prNumber),
      sonarFetch(
        sonarConfig.baseUrl,
        token,
        'measures/component',
        {
          component: sonarConfig.projectKey,
          pullRequest: prNumber,
          metricKeys:
            'coverage,new_coverage,new_line_coverage,uncovered_lines,lines_to_cover,branch_coverage,new_branch_coverage,new_lines_to_cover',
        },
        signal,
      ).then((d) => d as CoverageResponse),
      fetchAllIssues(
        sonarConfig.baseUrl,
        token,
        sonarConfig.projectKey,
        prNumber,
        signal,
      ),
    ])
  } catch (err) {
    throw new PrQualityError(
      'fetch',
      `Fetch failed: ${(err as Error).message}`,
      [],
      err as Error,
    )
  }

  const coverage = analyzeCoverage(coverageRaw)
  const issues = analyzeIssues(rawIssues)
  const prompt = buildAgentPrompt(
    prNumber,
    prData,
    sonarConfig,
    issues,
    coverage,
  )

  if (onProgress) {
    onProgress(
      `Fetched ${prData.unresolved_count} unresolved threads, ${issues.total} SonarCloud issues. Starting triage...`,
    )
  }

  return {
    prompt,
    prNumber,
    prData,
    sonarConfig,
    coverage,
    issues,
    details: {
      prNumber,
      prTitle: prData.pr_title,
      prUrl: prData.pr_url,
      unresolvedCount: prData.unresolved_count,
      issuesTotal: issues.total,
      issuesBySeverity: issues.bySeverity,
      projectKey: sonarConfig.projectKey,
    },
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

// AIDEV-NOTE: Tracks active poll intervals keyed by PR number so we can
// clear them on session_shutdown and prevent duplicate watchers.
// Uses setInterval + checkActionsComplete (same gh API call as /pr-quality guard)
// instead of a detached bash process + sentinel files, which had PATH and
// fs.watch reliability issues.
const activePollers = new Map<string, ReturnType<typeof setInterval>>()

export default function prQuality(pi: ExtensionAPI) {
  // ── /pr-watch ────────────────────────────────────────────────────────────
  pi.registerCommand('pr-watch', {
    description:
      'Watch PR checks in background; triggers /pr-quality when all pass',
    handler: async (args, ctx) => {
      const parsed = parseArgs(args)
      let prNumber: string
      try {
        prNumber = parsed.prNumber ?? (await detectPrNumber('/pr-watch'))
      } catch (err) {
        ctx.ui.notify(String((err as Error).message), 'error')
        return
      }

      if (activePollers.has(prNumber)) {
        ctx.ui.notify(`Already watching PR #${prNumber}`, 'warning')
        return
      }

      // Capture cwd now so the poller always runs gh in the right repo
      const cwd = ctx.cwd

      const poll = async () => {
        try {
          const status = await checkActionsComplete(prNumber, cwd)
          if (status.complete) {
            clearInterval(activePollers.get(prNumber))
            activePollers.delete(prNumber)
            ctx.ui.notify(
              `PR #${prNumber} ✔ all checks passed — triggering /pr-quality`,
              'info',
            )
            pi.sendUserMessage(`/pr-quality ${prNumber}`)
          } else {
            const failing = status.all.filter(
              (c) =>
                c.conclusion &&
                c.conclusion !== 'SUCCESS' &&
                c.conclusion !== 'SKIPPED',
            )
            if (failing.length > 0) {
              clearInterval(activePollers.get(prNumber))
              activePollers.delete(prNumber)
              const names = failing.map((c) => c.name).join(', ')
              ctx.ui.notify(
                `PR #${prNumber} ✖ check(s) failed: ${names}`,
                'error',
              )
            }
            // else still pending — keep polling
          }
        } catch {
          // transient error — keep polling
        }
      }

      // Run once immediately, then every 60s
      void poll()
      const interval = setInterval(() => {
        void poll()
      }, 60_000)
      activePollers.set(prNumber, interval)

      ctx.ui.notify(
        `Watching PR #${prNumber} checks (polling every 60s). Will trigger /pr-quality when all pass.`,
        'info',
      )
    },
  })

  // Clean up pollers when session ends
  pi.on('session_shutdown', async () => {
    for (const [pr, interval] of activePollers) {
      clearInterval(interval)
      activePollers.delete(pr)
    }
  })

  pi.registerCommand('pr-quality', {
    description:
      'Triage unresolved PR review comments + SonarCloud issues and fix them immediately',
    // AIDEV-NOTE: Human surface — keeps the original behavior (token guard
    // multi-line notify, CI-pending warn+return, setStatus during fetch,
    // sendUserMessage(prompt)) over the shared gatherPrQualityData core.
    handler: async (args, ctx) => {
      const parsed = parseArgs(args)
      ctx.ui.setStatus(
        'pr-quality',
        'Fetching GitHub threads + SonarCloud data...',
      )

      let result: PrQualityResult
      try {
        result = await gatherPrQualityData({
          cwd: ctx.cwd,
          prNumber: parsed.prNumber,
          signal: ctx.signal,
          onProgress: (message) => {
            ctx.ui.notify(message, 'info')
          },
        })
      } catch (err) {
        ctx.ui.setStatus('pr-quality', undefined)
        if (err instanceof PrQualityError && err.kind === 'token') {
          ctx.ui.notify(
            [
              'SONARQUBE_TOKEN is not set.',
              'Get a token at https://sonarcloud.io/account/security',
              'Then run: export SONARQUBE_TOKEN=<your_token>',
              'Add it to your shell profile (~/.bashrc / ~/.zshrc) to persist it.',
            ].join('  '),
            'error',
          )
          return
        }
        if (err instanceof PrQualityError && err.kind === 'pr') {
          ctx.ui.notify(String(err.message), 'error')
          return
        }
        // AIDEV-NOTE: CI-pending is not a failure for the human — warn and
        // return, exactly as before the core extraction.
        if (err instanceof PrQualityError && err.kind === 'ci-pending') {
          ctx.ui.notify(String(err.message), 'warning')
          return
        }
        if (err instanceof PrQualityError && err.kind === 'config') {
          ctx.ui.notify(
            [
              String(err.message),
              'Either create sonar-project.properties with sonar.projectKey and sonar.organization,',
              'or set SONAR_PROJECT_KEY and SONAR_ORGANIZATION env vars.',
            ].join('  '),
            'error',
          )
          return
        }
        ctx.ui.notify(String((err as Error).message), 'error')
        return
      }

      ctx.ui.setStatus('pr-quality', undefined)
      pi.sendUserMessage(result.prompt)
    },
  })

  // AIDEV-NOTE: Agent-callable surface — prompt text comes back in content,
  // compact structured numbers in details. CI-pending becomes an isError
  // result instead of a notify. Shares gatherPrQualityData with the command
  // so there is one implementation.
  pi.registerTool({
    name: 'pr_quality',
    label: 'PR quality triage',
    description:
      'Gather unresolved GitHub PR review threads plus SonarCloud coverage/issues for a PR and return a structured triage prompt for the agent to act on.',
    promptSnippet:
      'PR quality triage data: unresolved review threads, SonarCloud coverage and issues, with a step-by-step triage prompt.',
    parameters: Type.Object({
      pr_number: Type.Optional(
        Type.String({
          description:
            'PR number to analyze. Omit to auto-detect from the current branch via gh.',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { pr_number?: string },
      signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<PrQualityDetails>> {
      try {
        const result = await gatherPrQualityData({
          cwd: ctx.cwd,
          prNumber: params.pr_number,
          signal,
        })
        return {
          content: [{ type: 'text', text: result.prompt }],
          details: result.details,
        }
      } catch (err) {
        let text: string
        if (err instanceof PrQualityError && err.kind === 'ci-pending') {
          text = `pr_quality: ${err.message}. Re-run when all checks complete.`
        } else {
          text = `pr_quality failed: ${(err as Error).message}`
        }
        return {
          content: [{ type: 'text', text }],
          details: {
            prNumber: params.pr_number ?? '',
            prTitle: '',
            prUrl: '',
            unresolvedCount: 0,
            issuesTotal: 0,
            issuesBySeverity: {},
            projectKey: '',
          },
          isError: true,
        }
      }
    },
  })
}
