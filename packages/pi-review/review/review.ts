/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Custom review instructions
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review custom "check for security issues"` - custom instructions
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  BorderedLoader,
  CONFIG_DIR_NAME,
  DynamicBorder,
} from '@earendil-works/pi-coding-agent'
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from '@earendil-works/pi-tui'
import {
  isMuxAvailable,
  launchSubagent,
  type SubagentResult,
  watchSubagent,
} from '@gtheys/pi-interactive-subagents'
import {
  herdrAvailable,
  worktreeCreate,
  worktreeRemove,
} from '@gtheys/pi-worktree/herdr.ts'
import {
  buildSemReviewGuidance,
  getSemToolAvailability,
} from './sem-guidance.mjs'

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined
let endReviewInProgress = false

const REVIEW_STATE_TYPE = 'review-session'

type ReviewSessionState = {
  active: boolean
  originId?: string
}

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
  if (!ctx.hasUI) return
  if (!active) {
    ctx.ui.setWidget('review', undefined)
    return
  }

  ctx.ui.setWidget('review', (_tui, theme) => {
    const text = new Text(
      theme.fg('warning', 'Review session active, return with /end-review'),
      0,
      0,
    )
    return {
      render(width: number) {
        return text.render(width)
      },
      invalidate() {
        text.invalidate()
      },
    }
  })
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === REVIEW_STATE_TYPE) {
      state = entry.data as ReviewSessionState | undefined
    }
  }

  return state
}

function applyReviewState(ctx: ExtensionContext) {
  const state = getReviewState(ctx)

  if (state?.active && state.originId) {
    reviewOriginId = state.originId
    setReviewWidget(ctx, true)
    return
  }

  reviewOriginId = undefined
  setReviewWidget(ctx, false)
}

// Review target types (matching Codex's approach)
type ReviewTarget =
  | { type: 'uncommitted' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'ocrDelegate'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string }
  | {
      type: 'pullRequest'
      prNumber: number
      baseBranch: string
      title: string
      tuicrInstructions?: string
      worktree?: PrWorktreeInfo
    }
  | { type: 'folder'; paths: string[] }

// AIDEV-NOTE: PR reviews under Herdr run in a dedicated worktree (branch
// review/pr-<n> fetched from pull/<n>/head) instead of hijacking the main
// checkout — no clean-tree requirement, current branch untouched. Fresh
// worktrees get `yarn install` up front (see installWorktreeDeps) so the
// reviewer subagent can run tests. The worktree is auto-removed (with its
// branch) when the review finishes.
export interface PrWorktreeInfo {
  path: string
  workspaceId: string
  branch: string
  /** Outstanding async jobs (reviewer, ocr scout); worktree removed at 0. */
  pending: number
}

const prWorktrees = new Map<number, PrWorktreeInfo>()

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
  'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.'

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings."

const BASE_BRANCH_PROMPT_FALLBACK =
  'Review the code changes against the base branch \'{branch}\'. Start by finding the merge diff between the current branch and {branch}\'s upstream e.g. (`git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.'

// AIDEV-NOTE: ocr delegate mode — the reviewing agent IS the LLM. ocr only
// emits the reviewable-file spec (delegate preview) and resolved rules
// (delegate rule); no ocr LLM config required.
const OCR_DELEGATE_PROMPT = [
  "Perform a delegated OpenCodeReview (host-agent mode) of the current branch's changes against '{baseBranch}'. The diff base ref is {fromRef}.",
  "You are the reviewing LLM — do NOT run `ocr review` or `ocr scan` (they call the binary's own LLM).",
  'Steps:',
  '1. Run `ocr delegate preview --from {fromRef} --to HEAD --format json` to list the reviewable files.',
  '2. Run `ocr delegate rule <file...> --from {fromRef} --to HEAD --format json` on those files to resolve the review rules.',
  '3. Run `git diff {fromRef}` to inspect the changes.',
  '4. Apply the resolved rules to the changes and provide prioritized, actionable findings. For each finding cite file and line, the rule it maps to, and a suggested fix.',
].join('\n')

const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.'

const COMMIT_PROMPT =
  'Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.'

const PULL_REQUEST_PROMPT =
  'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.'

const PULL_REQUEST_PROMPT_FALLBACK =
  'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.'

const FOLDER_REVIEW_PROMPT =
  'Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.'

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Call out newly added dependencies explicitly and explain why they're needed.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Favor fail-fast behavior; avoid logging-and-continue patterns that hide errors.
4. Prefer predictable production behavior; crashing is better than silent degradation.
5. Treat back pressure handling as critical to system stability.
6. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
7. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. At the end, provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue.`

async function loadProjectReviewGuidelines(
  cwd: string,
): Promise<string | null> {
  let currentDir = path.resolve(cwd)

  while (true) {
    const piDir = path.join(currentDir, CONFIG_DIR_NAME)
    const guidelinesPath = path.join(currentDir, 'REVIEW_GUIDELINES.md')

    const piStats = await fs.stat(piDir).catch(() => null)
    if (piStats?.isDirectory()) {
      const guidelineStats = await fs.stat(guidelinesPath).catch(() => null)
      if (guidelineStats?.isFile()) {
        try {
          const content = await fs.readFile(guidelinesPath, 'utf8')
          const trimmed = content.trim()
          if (trimmed) {
            return trimmed
          }
          return null
        } catch {
          return null
        }
      }
      return null
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }
    currentDir = parentDir
  }
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(
  pi: ExtensionAPI,
  branch: string,
  cwd?: string,
): Promise<string | null> {
  try {
    // First try to get the upstream tracking branch
    const { stdout: upstream, code: upstreamCode } = await pi.exec(
      'git',
      ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`],
      { cwd },
    )

    if (upstreamCode === 0 && upstream.trim()) {
      const { stdout: mergeBase, code } = await pi.exec(
        'git',
        ['merge-base', 'HEAD', upstream.trim()],
        { cwd },
      )
      if (code === 0 && mergeBase.trim()) {
        return mergeBase.trim()
      }
    }

    // Fall back to using the branch directly
    const { stdout: mergeBase, code } = await pi.exec(
      'git',
      ['merge-base', 'HEAD', branch],
      { cwd },
    )
    if (code === 0 && mergeBase.trim()) {
      return mergeBase.trim()
    }

    return null
  } catch {
    return null
  }
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code } = await pi.exec('git', [
    'branch',
    '--format=%(refname:short)',
  ])
  if (code !== 0) return []
  return stdout
    .trim()
    .split('\n')
    .filter((b) => b.trim())
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(
  pi: ExtensionAPI,
  limit: number = 10,
): Promise<Array<{ sha: string; title: string }>> {
  const { stdout, code } = await pi.exec('git', [
    'log',
    `--oneline`,
    `-n`,
    `${limit}`,
  ])
  if (code !== 0) return []

  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, ...rest] = line.trim().split(' ')
      return { sha, title: rest.join(' ') }
    })
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const { stdout, code } = await pi.exec('git', ['status', '--porcelain'])
  return code === 0 && stdout.trim().length > 0
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
  // Check for staged or unstaged changes to tracked files
  const { stdout, code } = await pi.exec('git', ['status', '--porcelain'])
  if (code !== 0) return false

  // Filter out untracked files (lines starting with ??)
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim())
  const trackedChanges = lines.filter((line) => !line.startsWith('??'))
  return trackedChanges.length > 0
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim()

  // Try as a number first
  const num = parseInt(trimmed, 10)
  if (!Number.isNaN(num) && num > 0) {
    return num
  }

  // Try to extract from GitHub URL
  // Formats: https://github.com/owner/repo/pull/123
  //          github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (urlMatch) {
    return parseInt(urlMatch[1], 10)
  }

  return null
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
  const { stdout, code } = await pi.exec('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'baseRefName,title,headRefName',
  ])

  if (code !== 0) return null

  try {
    const data = JSON.parse(stdout)
    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    }
  } catch {
    return null
  }
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(
  pi: ExtensionAPI,
  prNumber: number,
): Promise<{ success: boolean; error?: string }> {
  const { stdout, stderr, code } = await pi.exec('gh', [
    'pr',
    'checkout',
    String(prNumber),
  ])

  if (code !== 0) {
    return {
      success: false,
      error: stderr || stdout || 'Failed to checkout PR',
    }
  }

  return { success: true }
}

// AIDEV-NOTE: worktree-backed PR review. Branch review/pr-<n> is fetched
// from pull/<n>/head so the PR code lands in a dedicated Herdr worktree —
// the main checkout (and its dirty state) is never touched. Only used when
// a mux is available (the reviewer subagent must run with cwd in the
// worktree; the legacy in-session path cannot).
function prWorktreeBranch(prNumber: number): string {
  return `review/pr-${prNumber}`
}

/** First worktree checkout path holding `branch`, via git porcelain. */
async function findWorktreeForBranch(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
): Promise<string | null> {
  const { stdout, code } = await pi.exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd },
  )
  if (code !== 0) return null

  let currentPath = ''
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length)
    }
    if (line === `branch refs/heads/${branch}`) {
      return currentPath
    }
  }
  return null
}

async function removePrWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prNumber: number,
  info: PrWorktreeInfo,
): Promise<void> {
  const errors: string[] = []
  if (info.workspaceId) {
    try {
      await worktreeRemove(pi, ctx.cwd, info.workspaceId, true)
    } catch (error) {
      errors.push((error as Error).message)
    }
  } else {
    const result = await pi.exec(
      'git',
      ['worktree', 'remove', '--force', info.path],
      { cwd: ctx.cwd },
    )
    if (result.code !== 0) {
      errors.push(result.stderr || result.stdout)
    }
  }

  // Branch is a fetched copy of the PR head — force delete is safe.
  const branch = await pi.exec('git', ['branch', '-D', info.branch], {
    cwd: ctx.cwd,
  })
  if (branch.code !== 0) {
    errors.push(branch.stderr || branch.stdout)
  }

  if (errors.length === 0) {
    prWorktrees.delete(prNumber)
    ctx.ui.notify(`Removed review worktree for PR #${prNumber}`, 'info')
    return
  }
  ctx.ui.notify(
    `Worktree cleanup for PR #${prNumber} failed: ${errors.join('; ')} — remove manually when done.`,
    'warning',
  )
}

// AIDEV-NOTE: fresh review worktrees get deps installed up front so the
// reviewer subagent can run tests immediately. GH_TOKEN from `gh auth
// token` authenticates private GitHub Packages registries (SalaryHero
// repos); pi.exec has no env option, so the token is injected via bash -c.
// Gated on yarn.lock — non-yarn repos (e.g. bun monorepos) are skipped.
// Install failure only warns: the code-reading part of the review still
// works without node_modules.
async function installWorktreeDeps(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  worktreePath: string,
): Promise<void> {
  try {
    await fs.access(path.join(worktreePath, 'yarn.lock'))
  } catch {
    return
  }
  ctx.ui.notify(
    'Installing dependencies in review worktree (yarn install)...',
    'info',
  )
  const result = await pi.exec(
    'bash',
    ['-c', 'GH_TOKEN=$(gh auth token) yarn install'],
    { cwd: worktreePath, timeout: 10 * 60 * 1000 },
  )
  if (result.code !== 0) {
    ctx.ui.notify(
      `yarn install in review worktree failed — tests may not run: ${(result.stderr || result.stdout).slice(-300)}`,
      'warning',
    )
  }
}

async function preparePrWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prNumber: number,
): Promise<PrWorktreeInfo | null> {
  const preflight = await herdrAvailable(pi, ctx.cwd)
  if (!preflight.ok) return null

  const branch = prWorktreeBranch(prNumber)

  const existing = prWorktrees.get(prNumber)
  if (existing) {
    ctx.ui.notify(`Reusing review worktree for PR #${prNumber}`, 'info')
    return existing
  }

  // AIDEV-NOTE: stale detection uses `git worktree list --porcelain`, NOT
  // `herdr worktree list` — the herdr listing is focus-scoped and may show
  // another repo's worktrees. A stale worktree from a dead session is
  // force-removed (with its branch) before recreating.
  const stale = await findWorktreeForBranch(pi, ctx.cwd, branch)
  if (stale) {
    ctx.ui.notify(
      `Removing stale review worktree for PR #${prNumber}...`,
      'info',
    )
    await pi.exec('git', ['worktree', 'remove', '--force', stale], {
      cwd: ctx.cwd,
    })
    await pi.exec('git', ['branch', '-D', branch], { cwd: ctx.cwd })
  }

  const fetch = await pi.exec(
    'git',
    ['fetch', '--force', 'origin', `pull/${prNumber}/head:${branch}`],
    { cwd: ctx.cwd },
  )
  if (fetch.code !== 0) {
    ctx.ui.notify(
      `Failed to fetch PR ref: ${fetch.stderr || fetch.stdout}`,
      'error',
    )
    return null
  }

  const created = await worktreeCreate(
    pi,
    ctx.cwd,
    branch,
    `review-pr-${prNumber}`,
  ).catch(() => null)
  if (!created || created.path === '') {
    ctx.ui.notify(
      `Failed to create review worktree${created ? ` (no path in output: ${JSON.stringify(created)})` : ''}`,
      'error',
    )
    return null
  }

  await installWorktreeDeps(pi, ctx, created.path)

  const info: PrWorktreeInfo = {
    path: created.path,
    workspaceId: created.workspaceId,
    branch,
    pending: 0,
  }
  prWorktrees.set(prNumber, info)
  return info
}

/**
 * Check whether a binary is available on PATH.
 */
async function commandExists(pi: ExtensionAPI, bin: string): Promise<boolean> {
  const { code } = await pi.exec('which', [bin])
  return code === 0
}

/**
 * Get "owner/repo" for the current repo from GitHub CLI.
 */
async function getRepoSlug(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
  ])
  if (code !== 0) return null
  try {
    return JSON.parse(stdout).nameWithOwner ?? null
  } catch {
    return null
  }
}

// AIDEV-NOTE: Fire-and-forget Herdr pane launch for PR review. Never blocks or
// throws into the review flow - any missing piece (Herdr, tuicr, gh slug,
// pane split) just skips the pane and the normal chat-based review proceeds.
/**
 * If tuicr + Herdr are available, open a tuicr review TUI for the PR in a
 * Herdr pane on the right and return tuicr-skill instructions for the agent
 * to work with that session.
 */
async function maybeOpenTuicrForPr(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prNumber: number,
  reviewCwd?: string,
): Promise<string | undefined> {
  if (process.env.HERDR_ENV !== '1') return undefined
  if (!(await commandExists(pi, 'tuicr'))) return undefined
  if (!(await commandExists(pi, 'herdr'))) return undefined

  const repoSlug = await getRepoSlug(pi)
  if (!repoSlug) return undefined

  const split = await pi.exec('herdr', [
    'pane',
    'split',
    '--current',
    '--direction',
    'right',
    '--cwd',
    reviewCwd ?? ctx.cwd,
    '--focus',
  ])
  if (split.code !== 0) return undefined

  let paneId: string | undefined
  try {
    paneId = JSON.parse(split.stdout)?.result?.pane?.pane_id
  } catch {
    paneId = undefined
  }
  if (!paneId) return undefined

  await pi.exec('herdr', ['pane', 'run', paneId, `tuicr pr ${prNumber}`])
  ctx.ui.notify(`Opened tuicr for PR #${prNumber} in a Herdr pane`, 'info')

  const sessionSlug = `gh:${repoSlug}/pr/${prNumber}`
  return `\n\nA tuicr review TUI is open in a Herdr pane for this PR (repo \`${repoSlug}\`, session \`${sessionSlug}\`). Follow the tuicr skill to work with that session, adding each finding with \`tuicr review add\`.

Before choosing \`--type\`, read the \`comment_types\` list from the tuicr config (\`~/.config/tuicr/config.toml\`, or \`$XDG_CONFIG_HOME/tuicr/config.toml\` if set) and match each finding to the \`id\` whose \`definition\` fits best - do not default to \`issue\` for everything. Typical mapping: must-fix-before-merge -> \`blocker\`, security/data-integrity -> \`security\`, should-fix-but-not-blocking -> \`issue\`, low-priority/optional tweak -> \`nit\` or \`suggestion\`, needs an answer before you can judge it -> \`question\`, missing/weak tests -> \`test\`, missing/wrong types -> \`types\`, missing/wrong error handling -> \`errors\`, unrequested change or leftover debug code -> \`scope\`, something worth calling out positively -> \`praise\`, and explicit delete/move/extract/simplify asks -> the matching id. Fall back to \`--type issue\` only if the config has no \`comment_types\` or none fit. Example: \`tuicr review add --repo ${repoSlug} --session ${sessionSlug} --target-file <path> --line <n> --side new --type <matched-type> --username "pi-review" "<finding>"\`.`
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec('git', ['branch', '--show-current'])
  if (code === 0 && stdout.trim()) {
    return stdout.trim()
  }
  return null
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  // Try to get from remote HEAD
  const { stdout, code } = await pi.exec('git', [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    '--short',
  ])
  if (code === 0 && stdout.trim()) {
    return stdout.trim().replace('origin/', '')
  }

  // Fall back to checking if main or master exists
  const branches = await getLocalBranches(pi)
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'

  return 'main' // Default fallback
}

/**
 * Build the review prompt based on target
 */
async function buildReviewPrompt(
  pi: ExtensionAPI,
  target: ReviewTarget,
): Promise<string> {
  switch (target.type) {
    case 'uncommitted':
      return UNCOMMITTED_PROMPT

    case 'baseBranch': {
      const mergeBase = await getMergeBase(pi, target.branch)
      if (mergeBase) {
        return BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(
          /{baseBranch}/g,
          target.branch,
        ).replace(/{mergeBaseSha}/g, mergeBase)
      }
      return BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch)
    }

    case 'ocrDelegate': {
      const mergeBase = await getMergeBase(pi, target.branch)
      const fromRef = mergeBase ?? target.branch
      return OCR_DELEGATE_PROMPT.replace(
        /{baseBranch}/g,
        target.branch,
      ).replace(/{fromRef}/g, fromRef)
    }

    case 'commit':
      if (target.title) {
        return COMMIT_PROMPT_WITH_TITLE.replace('{sha}', target.sha).replace(
          '{title}',
          target.title,
        )
      }
      return COMMIT_PROMPT.replace('{sha}', target.sha)

    case 'custom':
      return target.instructions

    case 'pullRequest': {
      const mergeBase = await getMergeBase(
        pi,
        target.baseBranch,
        target.worktree?.path,
      )
      if (mergeBase) {
        return PULL_REQUEST_PROMPT.replace(
          /{prNumber}/g,
          String(target.prNumber),
        )
          .replace(/{title}/g, target.title)
          .replace(/{baseBranch}/g, target.baseBranch)
          .replace(/{mergeBaseSha}/g, mergeBase)
      }
      return PULL_REQUEST_PROMPT_FALLBACK.replace(
        /{prNumber}/g,
        String(target.prNumber),
      )
        .replace(/{title}/g, target.title)
        .replace(/{baseBranch}/g, target.baseBranch)
    }

    case 'folder':
      return FOLDER_REVIEW_PROMPT.replace('{paths}', target.paths.join(', '))
  }
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case 'uncommitted':
      return 'current changes'
    case 'baseBranch':
      return `changes against '${target.branch}'`
    case 'ocrDelegate':
      return `ocr delegate review against '${target.branch}'`
    case 'commit': {
      const shortSha = target.sha.slice(0, 7)
      if (target.title) {
        return `commit ${shortSha}: ${target.title}`
      }
      return `commit ${shortSha}`
    }
    case 'custom': {
      if (target.instructions.length > 40) {
        return `${target.instructions.slice(0, 37)}...`
      }
      return target.instructions
    }
    case 'pullRequest': {
      let shortTitle: string
      if (target.title.length > 30) {
        shortTitle = `${target.title.slice(0, 27)}...`
      } else {
        shortTitle = target.title
      }
      return `PR #${target.prNumber}: ${shortTitle}`
    }

    case 'folder': {
      const joined = target.paths.join(', ')
      if (joined.length > 40) {
        return `folders: ${joined.slice(0, 37)}...`
      }
      return `folders: ${joined}`
    }
  }
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
  {
    value: 'uncommitted',
    label: 'Review uncommitted changes',
    description: '',
  },
  {
    value: 'baseBranch',
    label: 'Review against a base branch',
    description: '(local)',
  },
  { value: 'commit', label: 'Review a commit', description: '' },
  {
    value: 'pullRequest',
    label: 'Review a pull request',
    description: '(GitHub PR)',
  },
  {
    value: 'folder',
    label: 'Review a folder (or more)',
    description: '(snapshot, not diff)',
  },
  { value: 'custom', label: 'Custom review instructions', description: '' },
  {
    value: 'ocrDelegate',
    label: 'Review with ocr delegate rules',
    description: '(agent applies ocr rules; no ocr LLM)',
  },
] as const

export default function reviewExtension(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    applyReviewState(ctx)
  })

  // AIDEV-NOTE: was 'session_switch' (no such event in current SDK); session_info_changed
  // is the closest post-switch signal and re-applies review state after a switch.
  pi.on('session_info_changed', (_event, ctx) => {
    applyReviewState(ctx)
  })

  pi.on('session_tree', (_event, ctx) => {
    applyReviewState(ctx)
  })

  /**
   * Determine the smart default review type based on git state
   */
  async function getSmartDefault(): Promise<
    'uncommitted' | 'baseBranch' | 'commit'
  > {
    // Priority 1: If there are uncommitted changes, default to reviewing them
    if (await hasUncommittedChanges(pi)) {
      return 'uncommitted'
    }

    // Priority 2: If on a feature branch (not the default branch), default to PR-style review
    const currentBranch = await getCurrentBranch(pi)
    const defaultBranch = await getDefaultBranch(pi)
    if (currentBranch && currentBranch !== defaultBranch) {
      return 'baseBranch'
    }

    // Priority 3: Default to reviewing a specific commit
    return 'commit'
  }

  /**
   * Show the review preset selector
   */
  async function showReviewSelector(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    // Determine smart default (but keep the list order stable)
    const smartDefault = await getSmartDefault()
    const items: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }))
    const smartDefaultIndex = items.findIndex(
      (item) => item.value === smartDefault,
    )

    while (true) {
      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container()
          container.addChild(
            new DynamicBorder((str) => theme.fg('accent', str)),
          )
          container.addChild(
            new Text(theme.fg('accent', theme.bold('Select a review preset'))),
          )

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg('accent', text),
            selectedText: (text) => theme.fg('accent', text),
            description: (text) => theme.fg('muted', text),
            scrollInfo: (text) => theme.fg('dim', text),
            noMatch: (text) => theme.fg('warning', text),
          })

          // Preselect the smart default without reordering the list
          if (smartDefaultIndex >= 0) {
            selectList.setSelectedIndex(smartDefaultIndex)
          }

          selectList.onSelect = (item) => done(item.value)
          selectList.onCancel = () => done(null)

          container.addChild(selectList)
          container.addChild(
            new Text(
              theme.fg('dim', 'Press enter to confirm or esc to go back'),
            ),
          )
          container.addChild(
            new DynamicBorder((str) => theme.fg('accent', str)),
          )

          return {
            render(width: number) {
              return container.render(width)
            },
            invalidate() {
              container.invalidate()
            },
            handleInput(data: string) {
              selectList.handleInput(data)
              tui.requestRender()
            },
          }
        },
      )

      if (!result) return null

      // Handle each preset type
      switch (result) {
        case 'uncommitted':
          return { type: 'uncommitted' }

        case 'baseBranch': {
          const target = await showBranchSelector(ctx)
          if (target) return target
          break
        }

        case 'commit': {
          const target = await showCommitSelector(ctx)
          if (target) return target
          break
        }

        case 'custom': {
          const target = await showCustomInput(ctx)
          if (target) return target
          break
        }

        case 'ocrDelegate': {
          if (!(await commandExists(pi, 'ocr'))) {
            ctx.ui.notify(
              'ocr is not on PATH — delegate review unavailable.',
              'warning',
            )
            break
          }
          const base = await showBranchSelector(ctx)
          if (base && base.type === 'baseBranch') {
            return { type: 'ocrDelegate', branch: base.branch }
          }
          break
        }

        case 'folder': {
          const target = await showFolderInput(ctx)
          if (target) return target
          break
        }

        case 'pullRequest': {
          const target = await showPrInput(ctx)
          if (target) return target
          break
        }

        default:
          return null
      }
    }
  }

  /**
   * Show branch selector for base branch review
   */
  async function showBranchSelector(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi)
    const currentBranch = await getCurrentBranch(pi)
    const defaultBranch = await getDefaultBranch(pi)

    // Never offer the current branch as a base branch (reviewing against itself is meaningless).
    let candidateBranches: string[]
    if (currentBranch) {
      candidateBranches = branches.filter((b) => b !== currentBranch)
    } else {
      candidateBranches = branches
    }

    if (candidateBranches.length === 0) {
      let noBranchMsg: string
      if (currentBranch) {
        noBranchMsg = `No other branches found (current branch: ${currentBranch})`
      } else {
        noBranchMsg = 'No branches found'
      }
      ctx.ui.notify(noBranchMsg, 'error')
      return null
    }

    // Sort branches with default branch first
    const sortedBranches = candidateBranches.sort((a, b) => {
      if (a === defaultBranch) return -1
      if (b === defaultBranch) return 1
      return a.localeCompare(b)
    })

    const items: SelectItem[] = sortedBranches.map((branch) => {
      let description: string
      if (branch === defaultBranch) {
        description = '(default)'
      } else {
        description = ''
      }
      return { value: branch, label: branch, description }
    })

    const result = await ctx.ui.custom<string | null>(
      (tui, theme, _kb, done) => {
        const container = new Container()
        container.addChild(new DynamicBorder((str) => theme.fg('accent', str)))
        container.addChild(
          new Text(theme.fg('accent', theme.bold('Select base branch'))),
        )

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg('accent', text),
          selectedText: (text) => theme.fg('accent', text),
          description: (text) => theme.fg('muted', text),
          scrollInfo: (text) => theme.fg('dim', text),
          noMatch: (text) => theme.fg('warning', text),
        })

        let searchQuery = ''
        selectList.onSelect = (item) => done(item.value)
        selectList.onCancel = () => done(null)

        container.addChild(selectList)
        container.addChild(
          new Text(
            theme.fg('dim', 'Type to filter • enter to select • esc to cancel'),
          ),
        )
        container.addChild(new DynamicBorder((str) => theme.fg('accent', str)))

        return {
          render(width: number) {
            return container.render(width)
          },
          invalidate() {
            container.invalidate()
          },
          handleInput(data: string) {
            // Handle search filtering
            if (data.length === 1 && data >= ' ') {
              searchQuery += data
              selectList.setFilter(searchQuery)
            } else if (data === '\x7f' || data === '\b') {
              searchQuery = searchQuery.slice(0, -1)
              selectList.setFilter(searchQuery)
            } else {
              selectList.handleInput(data)
            }
            tui.requestRender()
          },
        }
      },
    )

    if (!result) return null
    return { type: 'baseBranch', branch: result }
  }

  /**
   * Show commit selector
   */
  async function showCommitSelector(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const commits = await getRecentCommits(pi, 20)

    if (commits.length === 0) {
      ctx.ui.notify('No commits found', 'error')
      return null
    }

    const items: SelectItem[] = commits.map((commit) => ({
      value: commit.sha,
      label: `${commit.sha.slice(0, 7)} ${commit.title}`,
      description: '',
    }))

    const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
      (tui, theme, _kb, done) => {
        const container = new Container()
        container.addChild(new DynamicBorder((str) => theme.fg('accent', str)))
        container.addChild(
          new Text(theme.fg('accent', theme.bold('Select commit to review'))),
        )

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg('accent', text),
          selectedText: (text) => theme.fg('accent', text),
          description: (text) => theme.fg('muted', text),
          scrollInfo: (text) => theme.fg('dim', text),
          noMatch: (text) => theme.fg('warning', text),
        })

        let searchQuery = ''
        selectList.onSelect = (item) => {
          const commit = commits.find((c) => c.sha === item.value)
          if (commit) {
            done(commit)
          } else {
            done(null)
          }
        }
        selectList.onCancel = () => done(null)

        container.addChild(selectList)
        container.addChild(
          new Text(
            theme.fg('dim', 'Type to filter • enter to select • esc to cancel'),
          ),
        )
        container.addChild(new DynamicBorder((str) => theme.fg('accent', str)))

        return {
          render(width: number) {
            return container.render(width)
          },
          invalidate() {
            container.invalidate()
          },
          handleInput(data: string) {
            // Handle search filtering
            if (data.length === 1 && data >= ' ') {
              searchQuery += data
              selectList.setFilter(searchQuery)
            } else if (data === '\x7f' || data === '\b') {
              searchQuery = searchQuery.slice(0, -1)
              selectList.setFilter(searchQuery)
            } else {
              selectList.handleInput(data)
            }
            tui.requestRender()
          },
        }
      },
    )

    if (!result) return null
    return { type: 'commit', sha: result.sha, title: result.title }
  }

  /**
   * Show custom instructions input
   */
  async function showCustomInput(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
      'Enter review instructions:',
      'Review the code for security vulnerabilities and potential bugs...',
    )

    if (!result?.trim()) return null
    return { type: 'custom', instructions: result.trim() }
  }

  function parseReviewPaths(value: string): string[] {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }

  /**
   * Show folder input
   */
  async function showFolderInput(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
      'Enter folders/files to review (space-separated or one per line):',
      '.',
    )

    if (!result?.trim()) return null
    const paths = parseReviewPaths(result)
    if (paths.length === 0) return null

    return { type: 'folder', paths }
  }

  /**
   * Show PR input and handle checkout (delegates to handlePrCheckout)
   */
  async function showPrInput(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    // Get PR reference from user
    const prRef = await ctx.ui.editor(
      'Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):',
      '',
    )

    if (!prRef?.trim()) return null

    return handlePrCheckout(ctx, prRef)
  }

  // AIDEV-NOTE: subagent review path (pi-interactive-subagents). Preferred
  // whenever a supported mux is available: spawns the bundled 'reviewer' agent
  // (Opus, read+bash, auto-exit) in a mux pane — non-blocking, main session
  // untouched, findings steer back as a review_result message. The legacy
  // in-session/branch flow below only runs without a mux or on spawn failure.
  function deliverSubagentReviewResult(hint: string, result: SubagentResult) {
    const failed = result.exitCode !== 0 || !!result.errorMessage
    const content = failed
      ? `Code review failed (${hint}): ${result.errorMessage ?? `exit code ${result.exitCode}`}`
      : `Code review finished (${hint}). Reviewer findings:\n\n${result.summary}\n\nSession: ${result.sessionFile}`

    pi.sendMessage(
      {
        customType: 'review_result',
        content,
        display: true,
        details: { hint, failed, sessionFile: result.sessionFile },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    )
  }

  // AIDEV-NOTE: worktree removal is refcounted. A PR review worktree may
  // host two async jobs (reviewer subagent + ocr scout); each calls
  // prWorktreeJobDone on completion and the last one out removes the
  // worktree + branch. Job count is set BEFORE spawning to close the
  // fast-finisher race.
  function prWorktreeJobDone(ctx: ExtensionContext, prNumber: number): void {
    const info = prWorktrees.get(prNumber)
    if (!info) return
    info.pending -= 1
    if (info.pending <= 0) {
      void removePrWorktree(pi, ctx, prNumber, info)
    }
  }

  // AIDEV-NOTE: ocr (OpenCodeReview) second opinion. When the `ocr` binary
  // exists, a scout subagent runs `ocr <args> --format json --output <tmpfile>`
  // in the review cwd (PR worktree for pullRequest, ctx.cwd otherwise) and
  // the JSON steers back as an ocr_result message. Pure runner — the scout
  // must not analyze, just return path + file contents.
  // Delegate mode is a separate picker preset (ocrDelegate target): the
  // reviewer subagent itself applies ocr's delegate preview/rule spec —
  // no ocr LLM config required.
  function deliverOcrResult(scope: string, result: SubagentResult) {
    const failed = result.exitCode !== 0 || !!result.errorMessage
    const content = failed
      ? `ocr review failed (${scope}): ${result.errorMessage ?? `exit code ${result.exitCode}`}`
      : `ocr review finished (${scope}). Output:

${result.summary}`

    pi.sendMessage(
      {
        customType: 'ocr_result',
        content,
        display: true,
        details: { scope, failed, sessionFile: result.sessionFile },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    )
  }

  async function startOcrReview(
    ctx: ExtensionCommandContext,
    scope: string,
    ocrArgs: string[],
    reviewCwd: string,
    jobDone?: () => void,
  ): Promise<boolean> {
    const task = [
      'Run an OpenCodeReview pass and return its JSON output. You are a pure command runner.',
      'Run exactly:',
      'f="$(mktemp -t ocr-review-XXXXXX.json)"',
      `ocr ${ocrArgs.join(' ')} --format json --output "$f"`,
      'cat "$f"',
      'If ocr fails, still return its full error output.',
      'Do NOT analyze, summarize, review, or fix anything. Do NOT explore the codebase.',
      'Your final message: the output file path on its first line, then the file contents verbatim.',
    ].join('\n')

    try {
      const running = await launchSubagent(
        {
          agent: 'scout',
          name: `ocr: ${scope}`,
          task,
          cwd: reviewCwd,
        },
        ctx,
      )

      ctx.ui.notify(
        `ocr review (${scope}) running in a scout pane — output arrives here when done.`,
        'info',
      )

      watchSubagent(running, new AbortController().signal)
        .then((result) => {
          deliverOcrResult(scope, result)
          if (jobDone) jobDone()
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          deliverOcrResult(scope, {
            name: `ocr: ${scope}`,
            task,
            summary: `Watcher error: ${message}`,
            sessionFile: undefined,
            exitCode: 1,
            elapsed: 0,
            errorMessage: message,
          })
          if (jobDone) jobDone()
        })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.ui.notify(
        `ocr scout spawn failed (${message}). Continuing without ocr.`,
        'warning',
      )
      return false
    }
  }

  async function startSubagentReview(
    ctx: ExtensionCommandContext,
    fullPrompt: string,
    hint: string,
    reviewCwd?: string,
    worktree?: { prNumber: number; info: PrWorktreeInfo },
  ): Promise<boolean> {
    try {
      const running = await launchSubagent(
        {
          agent: 'reviewer',
          name: `Review: ${hint}`,
          task: fullPrompt,
          cwd: reviewCwd ?? ctx.cwd,
        },
        ctx,
      )

      ctx.ui.notify(
        `Review "${hint}" running in a subagent pane — findings arrive here when done.`,
        'info',
      )

      watchSubagent(running, new AbortController().signal)
        .then((result) => {
          deliverSubagentReviewResult(hint, result)
          if (worktree) prWorktreeJobDone(ctx, worktree.prNumber)
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          deliverSubagentReviewResult(hint, {
            name: `Review: ${hint}`,
            task: fullPrompt,
            summary: `Watcher error: ${message}`,
            sessionFile: undefined,
            exitCode: 1,
            elapsed: 0,
            errorMessage: message,
          })
          if (worktree) prWorktreeJobDone(ctx, worktree.prNumber)
        })
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // With a PR worktree the legacy in-session fallback would review the
      // wrong tree (main checkout, not the PR) — count the failed job, which
      // also removes the worktree if no other job holds it, and abort.
      if (worktree) {
        prWorktreeJobDone(ctx, worktree.prNumber)
        ctx.ui.notify(
          `Subagent spawn failed (${message}). PR review aborted — the worktree is removed when remaining jobs finish; retry with /review pr.`,
          'error',
        )
        return true
      }
      ctx.ui.notify(
        `Subagent review unavailable (${message}). Falling back to in-session review.`,
        'warning',
      )
      return false
    }
  }

  /**
   * Execute the review
   */
  async function executeReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    useFreshSession: boolean,
  ): Promise<void> {
    const prompt = await buildReviewPrompt(pi, target)
    const semReviewInstructions = await buildSemReviewInstructions(target)
    const hint = getUserFacingHint(target)
    const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd)

    // Combine the review rubric with the specific prompt
    let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`

    if (semReviewInstructions) {
      fullPrompt += `\n\n${semReviewInstructions}`
    }

    if (projectGuidelines) {
      fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`
    }

    if (target.type === 'pullRequest' && target.tuicrInstructions) {
      fullPrompt += target.tuicrInstructions
    }

    // Subagent path — preferred whenever a mux is available. Runs before the
    // branch machinery so a mux present means no session-tree branch is created.
    if (isMuxAvailable()) {
      const prWorktree =
        target.type === 'pullRequest' && target.worktree
          ? { prNumber: target.prNumber, info: target.worktree }
          : undefined
      const reviewCwd =
        target.type === 'pullRequest' ? target.worktree?.path : undefined
      // Reserve both worktree jobs up front (reviewer + ocr scout) so a
      // fast-finishing reviewer can't tear the worktree out from under ocr.
      if (prWorktree) prWorktree.info.pending = 2

      const spawned = await startSubagentReview(
        ctx,
        fullPrompt,
        hint,
        reviewCwd,
        prWorktree,
      )

      if (spawned) {
        // AIDEV-NOTE: ocr second opinion — scout runs ocr in the review cwd
        // when the binary exists; skips silently otherwise. Target mapping:
        // pullRequest → review --from <base> --to <worktree branch> (worktree),
        // baseBranch → review --from <merge-base> --to HEAD,
        // uncommitted → review (workspace mode),
        // commit → review --commit <sha>,
        // folder → scan --path <paths> (no diff).
        // ocrDelegate is excluded — the reviewer itself applies the ocr rules.
        // custom is excluded — no diff equivalent.
        let ocrSpawned = false
        if (await commandExists(pi, 'ocr')) {
          let scope: string | null = null
          let ocrArgs: string[] = []
          if (target.type === 'pullRequest') {
            const toRef = prWorktree ? prWorktree.info.branch : 'HEAD'
            scope = `PR #${target.prNumber}`
            ocrArgs = ['review', '--from', target.baseBranch, '--to', toRef]
          } else if (target.type === 'baseBranch') {
            const mergeBase = await getMergeBase(pi, target.branch, ctx.cwd)
            if (mergeBase) {
              scope = `${target.branch}...HEAD`
              ocrArgs = ['review', '--from', mergeBase, '--to', 'HEAD']
            }
          } else if (target.type === 'uncommitted') {
            scope = 'uncommitted'
            ocrArgs = ['review']
          } else if (target.type === 'commit') {
            scope = `commit ${target.sha.slice(0, 7)}`
            ocrArgs = ['review', '--commit', target.sha]
          } else if (target.type === 'folder') {
            scope = `scan: ${target.paths.join(', ')}`
            ocrArgs = ['scan', '--path', target.paths.join(',')]
          }
          if (scope && ocrArgs.length > 0) {
            let jobDone: (() => void) | undefined
            if (target.type === 'pullRequest') {
              const prNumber = target.prNumber
              jobDone = () => prWorktreeJobDone(ctx, prNumber)
            }
            ocrSpawned = await startOcrReview(
              ctx,
              scope,
              ocrArgs,
              reviewCwd ?? ctx.cwd,
              jobDone,
            )
          }
        }
        if (prWorktree && !ocrSpawned) {
          prWorktreeJobDone(ctx, prWorktree.prNumber)
        }
        return
      }

      if (prWorktree) {
        // Reviewer spawn failed and aborted the PR review — release the
        // never-started ocr reservation so the worktree cleans up.
        prWorktreeJobDone(ctx, prWorktree.prNumber)
        return
      }
    }

    // Legacy in-session path (no mux, or subagent spawn failed)
    if (reviewOriginId) {
      ctx.ui.notify(
        'Already in a review. Use /end-review to finish first.',
        'warning',
      )
      return
    }

    if (useFreshSession) {
      // Store current position (where we'll return to)
      const originId = ctx.sessionManager.getLeafId() ?? undefined
      if (!originId) {
        ctx.ui.notify(
          'Failed to determine review origin. Try again from a session with messages.',
          'error',
        )
        return
      }
      reviewOriginId = originId

      // Keep a local copy so session_tree events during navigation don't wipe it
      const lockedOriginId = originId

      // Find the first user message in the session
      const entries = ctx.sessionManager.getEntries()
      const firstUserMessage = entries.find(
        (e) => e.type === 'message' && e.message.role === 'user',
      )

      if (!firstUserMessage) {
        ctx.ui.notify('No user message found in session', 'error')
        reviewOriginId = undefined
        return
      }

      // Navigate to first user message to create a new branch from that point
      // Label it as "code-review" so it's visible in the tree
      try {
        const result = await ctx.navigateTree(firstUserMessage.id, {
          summarize: false,
          label: 'code-review',
        })
        if (result.cancelled) {
          reviewOriginId = undefined
          return
        }
      } catch (error) {
        // Clean up state if navigation fails
        reviewOriginId = undefined
        let errMsg: string
        if (error instanceof Error) {
          errMsg = error.message
        } else {
          errMsg = String(error)
        }
        ctx.ui.notify(`Failed to start review: ${errMsg}`, 'error')
        return
      }

      // Restore origin after navigation events (session_tree can reset it)
      reviewOriginId = lockedOriginId

      // Clear the editor (navigating to user message fills it with the message text)
      ctx.ui.setEditorText('')

      // Show widget indicating review is active
      setReviewWidget(ctx, true)

      // Persist review state so tree navigation can restore/reset it
      pi.appendEntry(REVIEW_STATE_TYPE, {
        active: true,
        originId: lockedOriginId,
      })
    }

    let modeHint: string
    if (useFreshSession) {
      modeHint = ' (fresh session)'
    } else {
      modeHint = ''
    }
    ctx.ui.notify(`Starting review: ${hint}${modeHint}`, 'info')

    // Send as a user message that triggers a turn
    pi.sendUserMessage(fullPrompt)
  }

  /**
   * Parse command arguments for direct invocation
   * Returns the target or a special marker for PR that needs async handling
   */
  function parseArgs(
    args: string | undefined,
  ): ReviewTarget | { type: 'pr'; ref: string } | null {
    if (!args?.trim()) return null

    const parts = args.trim().split(/\s+/)
    const subcommand = parts[0]?.toLowerCase()

    switch (subcommand) {
      case 'uncommitted':
        return { type: 'uncommitted' }

      case 'branch': {
        const branch = parts[1]
        if (!branch) return null
        return { type: 'baseBranch', branch }
      }

      case 'commit': {
        const sha = parts[1]
        if (!sha) return null
        const title = parts.slice(2).join(' ') || undefined
        return { type: 'commit', sha, title }
      }

      case 'custom': {
        const instructions = parts.slice(1).join(' ')
        if (!instructions) return null
        return { type: 'custom', instructions }
      }

      case 'folder': {
        const paths = parseReviewPaths(parts.slice(1).join(' '))
        if (paths.length === 0) return null
        return { type: 'folder', paths }
      }

      case 'pr': {
        const ref = parts[1]
        if (!ref) return null
        return { type: 'pr', ref }
      }

      default:
        return null
    }
  }

  /**
   * Handle PR checkout and return a ReviewTarget (or null on failure).
   *
   * AIDEV-NOTE: worktree-first when Herdr + mux are available — the PR is
   * fetched into a dedicated review/pr-<n> worktree and the reviewer runs
   * there; the main checkout stays untouched (no clean-tree requirement).
   * Fallback (no mux / no Herdr / worktree failure) is the legacy in-place
   * `gh pr checkout`, which needs a clean tree.
   */
  async function handlePrCheckout(
    ctx: ExtensionContext,
    ref: string,
  ): Promise<ReviewTarget | null> {
    const prNumber = parsePrReference(ref)
    if (!prNumber) {
      ctx.ui.notify(
        'Invalid PR reference. Enter a number or GitHub PR URL.',
        'error',
      )
      return null
    }

    // Get PR info
    ctx.ui.notify(`Fetching PR #${prNumber} info...`, 'info')
    const prInfo = await getPrInfo(pi, prNumber)

    if (!prInfo) {
      ctx.ui.notify(
        `Could not find PR #${prNumber}. Make sure gh is authenticated and the PR exists.`,
        'error',
      )
      return null
    }

    let worktree: PrWorktreeInfo | undefined
    if (isMuxAvailable()) {
      ctx.ui.notify(`Preparing review worktree for PR #${prNumber}...`, 'info')
      worktree = (await preparePrWorktree(pi, ctx, prNumber)) ?? undefined
    }

    if (!worktree) {
      // Legacy in-place checkout — needs a clean tree
      if (await hasPendingChanges(pi)) {
        ctx.ui.notify(
          'Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.',
          'error',
        )
        return null
      }

      ctx.ui.notify(`Checking out PR #${prNumber}...`, 'info')
      const checkoutResult = await checkoutPr(pi, prNumber)

      if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, 'error')
        return null
      }

      ctx.ui.notify(
        `Checked out PR #${prNumber} (${prInfo.headBranch})`,
        'info',
      )
    }

    const tuicrInstructions = await maybeOpenTuicrForPr(
      pi,
      ctx,
      prNumber,
      worktree?.path,
    )

    return {
      type: 'pullRequest',
      prNumber,
      baseBranch: prInfo.baseBranch,
      title: prInfo.title,
      tuicrInstructions,
      worktree,
    }
  }

  async function buildSemReviewInstructions(
    target: ReviewTarget,
  ): Promise<string | null> {
    const tools = getSemToolAvailability(pi.getActiveTools())
    if (!tools.any) return null

    switch (target.type) {
      case 'baseBranch': {
        const mergeBase = await getMergeBase(pi, target.branch)
        return buildSemReviewGuidance(
          { type: 'baseBranch', branch: target.branch, mergeBase },
          tools,
        )
      }
      case 'pullRequest': {
        const mergeBase = await getMergeBase(
          pi,
          target.baseBranch,
          target.worktree?.path,
        )
        return buildSemReviewGuidance(
          {
            type: 'pullRequest',
            prNumber: target.prNumber,
            baseBranch: target.baseBranch,
            title: target.title,
            mergeBase,
          },
          tools,
        )
      }
      default:
        return buildSemReviewGuidance(target, tools)
    }
  }

  // Register the /review command
  pi.registerCommand('review', {
    description:
      'Review code changes (PR, uncommitted, branch, commit, folder, or custom)',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('Review requires interactive mode', 'error')
        return
      }

      // Check if we're in a git repository
      const { code } = await pi.exec('git', ['rev-parse', '--git-dir'])
      if (code !== 0) {
        ctx.ui.notify('Not a git repository', 'error')
        return
      }

      // Try to parse direct arguments
      let target: ReviewTarget | null = null
      let fromSelector = false
      const parsed = parseArgs(args)

      if (parsed) {
        if (parsed.type === 'pr') {
          // Handle PR checkout (async operation)
          target = await handlePrCheckout(ctx, parsed.ref)
          if (!target) {
            ctx.ui.notify(
              'PR review failed. Returning to review menu.',
              'warning',
            )
          }
        } else {
          target = parsed
        }
      }

      // If no args or invalid args, show selector
      if (!target) {
        fromSelector = true
      }

      while (true) {
        if (!target && fromSelector) {
          target = await showReviewSelector(ctx)
        }

        if (!target) {
          ctx.ui.notify('Review cancelled', 'info')
          return
        }

        // Determine if we should use fresh session mode
        // Check if this is a new session (no messages yet)
        const entries = ctx.sessionManager.getEntries()
        const messageCount = entries.filter((e) => e.type === 'message').length

        let useFreshSession = false

        // With a mux available, /review always spawns a subagent — no mode
        // question needed. The selector below is the legacy no-mux flow only.
        if (messageCount > 0 && !isMuxAvailable()) {
          const choice = await ctx.ui.select('Start review in:', [
            'Empty branch',
            'Current session',
          ])

          if (choice === undefined) {
            if (fromSelector) {
              target = null
              continue
            }
            ctx.ui.notify('Review cancelled', 'info')
            return
          }

          useFreshSession = choice === 'Empty branch'
        }
        // If messageCount === 0, useFreshSession stays false (current session mode)

        await executeReview(ctx, target, useFreshSession)
        return
      }
    },
  })

  // Custom prompt for review summaries - focuses on preserving actionable findings
  const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

Preserve exact file paths, function names, and error messages where available.`

  const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Run relevant tests/checks for touched code where practical.
5. End with: fixed items, deferred/skipped items (with reasons), and verification results.`

  type EndReviewAction = 'returnOnly' | 'returnAndFix' | 'returnAndSummarize'

  function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
    if (reviewOriginId) {
      return reviewOriginId
    }

    const state = getReviewState(ctx)
    if (state?.active && state.originId) {
      reviewOriginId = state.originId
      return reviewOriginId
    }

    if (state?.active) {
      setReviewWidget(ctx, false)
      pi.appendEntry(REVIEW_STATE_TYPE, { active: false })
      ctx.ui.notify(
        'Review state was missing origin info; cleared review status.',
        'warning',
      )
    }

    return undefined
  }

  function clearReviewState(ctx: ExtensionContext) {
    setReviewWidget(ctx, false)
    reviewOriginId = undefined
    pi.appendEntry(REVIEW_STATE_TYPE, { active: false })
  }

  async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify('End-review requires interactive mode', 'error')
      return
    }

    if (endReviewInProgress) {
      ctx.ui.notify('/end-review is already running', 'info')
      return
    }

    const originId = getActiveReviewOrigin(ctx)
    if (!originId) {
      if (!getReviewState(ctx)?.active) {
        ctx.ui.notify(
          'Not in a review branch (use /review first, or review was started in current session mode)',
          'info',
        )
      }
      return
    }

    endReviewInProgress = true
    try {
      const choice = await ctx.ui.select('Finish review:', [
        'Return only',
        'Return and fix findings',
        'Return and summarize',
      ])

      if (choice === undefined) {
        ctx.ui.notify('Cancelled. Use /end-review to try again.', 'info')
        return
      }

      let action: EndReviewAction
      if (choice === 'Return and fix findings') {
        action = 'returnAndFix'
      } else if (choice === 'Return and summarize') {
        action = 'returnAndSummarize'
      } else {
        action = 'returnOnly'
      }
      if (action === 'returnOnly') {
        try {
          const result = await ctx.navigateTree(originId, { summarize: false })
          if (result.cancelled) {
            ctx.ui.notify(
              'Navigation cancelled. Use /end-review to try again.',
              'info',
            )
            return
          }
        } catch (error) {
          let errMsg2: string
          if (error instanceof Error) {
            errMsg2 = error.message
          } else {
            errMsg2 = String(error)
          }
          ctx.ui.notify(`Failed to return: ${errMsg2}`, 'error')
          return
        }

        clearReviewState(ctx)
        ctx.ui.notify('Review complete! Returned to original position.', 'info')
        return
      }

      const summaryResult = await ctx.ui.custom<{
        cancelled: boolean
        error?: string
      } | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          'Returning and summarizing review branch...',
        )
        loader.onAbort = () => done(null)

        ctx
          .navigateTree(originId, {
            summarize: true,
            customInstructions: REVIEW_SUMMARY_PROMPT,
            replaceInstructions: true,
          })
          .then(done)
          .catch((err) => {
            let errStr: string
            if (err instanceof Error) {
              errStr = err.message
            } else {
              errStr = String(err)
            }
            done({ cancelled: false, error: errStr })
          })

        return loader
      })

      if (summaryResult === null) {
        ctx.ui.notify(
          'Summarization cancelled. Use /end-review to try again.',
          'info',
        )
        return
      }

      if (summaryResult.error) {
        ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, 'error')
        return
      }

      if (summaryResult.cancelled) {
        ctx.ui.notify(
          'Navigation cancelled. Use /end-review to try again.',
          'info',
        )
        return
      }

      clearReviewState(ctx)

      if (action === 'returnAndSummarize') {
        if (!ctx.ui.getEditorText().trim()) {
          ctx.ui.setEditorText('Act on the review findings')
        }
        ctx.ui.notify('Review complete! Returned and summarized.', 'info')
        return
      }

      pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: 'followUp' })
      ctx.ui.notify(
        'Review complete! Returned and queued a follow-up to fix findings.',
        'info',
      )
    } finally {
      endReviewInProgress = false
    }
  }

  // Register the /end-review command
  pi.registerCommand('end-review', {
    description: 'Complete review and return to original position',
    handler: async (_args, ctx) => {
      await runEndReview(ctx)
    },
  })
}
