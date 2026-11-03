/**
 * Shared Jira branch derivation/creation logic.
 * Ports scripts/jira-branch.sh (acli + slugify + git-town) to TS so both
 * create-plan/implement-plan and debug skills share one implementation
 * instead of a duplicated bash script.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

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
// AIDEV-NOTE: Ported from the original bash script's arg-parsing regex.
// Also closes a real gap: guarantees jiraId only ever contains [A-Z0-9-]
// before it's interpolated into a branch ref / exec arg.
const JIRA_ID_RE = /^[A-Z]+-[0-9]+$/

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

/** Fetch the issue from Jira via acli and derive the branch name. */
export async function deriveBranchName(
  pi: ExtensionAPI,
  jiraId: string,
): Promise<DeriveBranchResult> {
  if (!JIRA_ID_RE.test(jiraId)) {
    throw new Error(
      `Invalid Jira key '${jiraId}' — expected format like IMP-1234`,
    )
  }

  const result = await pi.exec(
    'acli',
    [
      'jira',
      'workitem',
      'view',
      jiraId,
      '--json',
      '--fields',
      'summary,issuetype',
    ],
    {},
  )
  if (result.code !== 0) {
    throw new Error(
      `acli failed to fetch '${jiraId}': ${result.stderr || result.stdout}`,
    )
  }

  let parsed: { fields?: { summary?: string; issuetype?: { name?: string } } }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`Could not parse acli JSON response for '${jiraId}'`)
  }

  const summary = parsed.fields?.summary ?? ''
  const issueType = parsed.fields?.issuetype?.name ?? ''
  if (!summary) {
    throw new Error(
      `Could not parse summary from Jira response for '${jiraId}'`,
    )
  }

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
