/**
 * Shared Jira branch derivation/creation logic.
 * Ports scripts/jira-branch.sh (acli + slugify + git-town) to TS so both
 * create-plan/implement-plan and debug skills share one implementation
 * instead of a duplicated bash script.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { fetchJiraIssue } from './jira-issue.ts'

// AIDEV-NOTE: Extend this map for additional Jira issue types. Keys lowercase.
const TYPE_PREFIX_MAP: Record<string, string> = {
  bug: 'bugfix',
  hotfix: 'hotfix',
  story: 'feature',
  feature: 'feature',
  epic: 'feature',
  task: 'chore',
  'sub-task': 'chore',
  subtask: 'chore',
  improvement: 'feature',
  'technical debt': 'chore',
  spike: 'chore',
}
const DEFAULT_PREFIX = 'feature'
const PARENT_BRANCH = 'develop'

function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .split('-')
    .slice(0, 5)
    .join('-')
    .replace(/^-|-$/g, '')
}

export interface DeriveBranchResult {
  branch: string
  summary: string
  issueType: string
  prefix: string
}

/**
 * Fetch the issue from Jira via acli and derive the branch name.
 *
 * AIDEV-NOTE: PMR-9DZ0 — the acli fetch/validation/parse moved to the shared
 * helper (plan-tools/jira-issue.ts); its thrown messages are unchanged, so
 * this stays fail-closed: an invalid key, a failing acli, or a summary-less
 * ticket aborts branch derivation before any git ref is built.
 */
export async function deriveBranchName(
  pi: ExtensionAPI,
  jiraId: string,
): Promise<DeriveBranchResult> {
  const { summary, issueType } = await fetchJiraIssue(pi, jiraId)

  const prefix = TYPE_PREFIX_MAP[issueType.toLowerCase()] ?? DEFAULT_PREFIX
  const branch = `${prefix}/${jiraId}-${slugify(summary)}`

  return { branch, summary, issueType, prefix }
}

export interface CreateBranchResult extends DeriveBranchResult {
  created: boolean
  alreadyExisted: boolean
}

/**
 * Derive the branch name for a Jira issue and, unless dryRun, create it and
 * set the git-town parent to 'develop'. cwd must be the target repo root.
 */
export async function createJiraBranch(
  pi: ExtensionAPI,
  jiraId: string,
  cwd: string,
  dryRun: boolean,
): Promise<CreateBranchResult> {
  const derived = await deriveBranchName(pi, jiraId)
  const branchRef = `refs/heads/${derived.branch}`

  const existing = await pi.exec(
    'git',
    ['show-ref', '--verify', '--quiet', branchRef],
    { cwd },
  )
  const alreadyExisted = existing.code === 0

  if (dryRun || alreadyExisted) {
    return { ...derived, created: false, alreadyExisted }
  }

  const checkout = await pi.exec('git', ['checkout', '-b', derived.branch], {
    cwd,
  })
  if (checkout.code !== 0) {
    throw new Error(
      `git checkout -b '${derived.branch}' failed: ${checkout.stderr}`,
    )
  }

  await pi.exec('git', ['town', 'set-parent', PARENT_BRANCH], { cwd })

  return { ...derived, created: true, alreadyExisted: false }
}
