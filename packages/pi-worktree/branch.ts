import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export type PersonalType = 'feat' | 'fix' | 'chore' | 'docs' | 'refactor'

export type BranchInput =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'personal'; name: string; type: PersonalType }
  | { kind: 'literal'; branch: string }

const PERSONAL_TYPES: readonly PersonalType[] = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
]

export interface RawBranchInput {
  jira_id?: string
  name?: string
  type?: string
  branch?: string
}

/**
 * Validate raw tool input into exactly one branch derivation mode:
 * jira_id XOR name XOR branch.
 */
export function parseBranchInput(raw: RawBranchInput): BranchInput {
  const modes = [
    Boolean(raw.jira_id),
    Boolean(raw.name),
    Boolean(raw.branch),
  ].filter(Boolean).length

  if (modes === 0) {
    throw new Error(
      'Missing branch input — provide exactly one of: jira_id, name, branch',
    )
  }
  if (modes > 1) {
    throw new Error(
      'Ambiguous branch input — provide exactly one of: jira_id, name, branch',
    )
  }

  if (raw.jira_id) {
    return { kind: 'jira', jiraId: raw.jira_id }
  }

  if (raw.name) {
    let type: PersonalType = 'feat'
    if (raw.type !== undefined) {
      if (!PERSONAL_TYPES.includes(raw.type as PersonalType)) {
        throw new Error(
          `Invalid type '${raw.type}' — expected one of: ${PERSONAL_TYPES.join(', ')}`,
        )
      }
      type = raw.type as PersonalType
    }
    return { kind: 'personal', name: raw.name, type }
  }

  return { kind: 'literal', branch: raw.branch as string }
}

// AIDEV-NOTE: PMR-XCA9 — intentionally duplicates pi-flow's jira-branch
// slugify rules (plan-tools/jira-branch.ts; pi-planning retired).
// Cross-package runtime import avoided; keep the rules in sync when they change.
export function slugify(text: string): string {
  return text
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

export function personalBranch(name: string, type: PersonalType): string {
  return `${type}/${slugify(name)}`
}

// AIDEV-NOTE: PMR-XCA9 — deriveBranchName inlined from the retired
// pi-planning shared/jira-branch.ts (only pi-worktree consumed it; pi-flow
// keeps the tool-facing copy in plan-tools/jira-branch.ts). Keys lowercase.
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
// AIDEV-NOTE: guarantees jiraId only ever contains [A-Z0-9-] before it's
// interpolated into a branch ref / exec arg.
const JIRA_ID_RE = /^[A-Z]+-[0-9]+$/

/** Fetch the issue from Jira via acli and derive the branch name. */
async function deriveBranchName(
  pi: ExtensionAPI,
  jiraId: string,
): Promise<{ branch: string }> {
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
  return { branch: `${prefix}/${jiraId}-${slugify(summary)}` }
}

export interface DerivedBranch {
  branch: string
  source: 'jira' | 'personal' | 'literal'
}

export async function deriveBranch(
  pi: ExtensionAPI,
  input: BranchInput,
): Promise<DerivedBranch> {
  if (input.kind === 'jira') {
    const result = await deriveBranchName(pi, input.jiraId)
    return { branch: result.branch, source: 'jira' }
  }
  if (input.kind === 'personal') {
    return {
      branch: personalBranch(input.name, input.type),
      source: 'personal',
    }
  }
  return { branch: input.branch, source: 'literal' }
}
