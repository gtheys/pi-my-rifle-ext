/**
 * Shared Jira issue lookup via acli.
 *
 * AIDEV-NOTE: PMR-9DZ0 — two callers already fetched the same Jira issue the
 * same way (plan-tools/jira-branch.ts and worktree/branch.ts had verbatim
 * copies of this exec/validate/parse block). The pi-flow title journaling at
 * run-start is the third consumer, so the fetch lives here once. The helper
 * THROWS with the exact messages the branch callers threw before the split —
 * their contract is fail-closed (a wrong branch name must never be built from
 * a half-read ticket) — and callers that want best-effort behaviour catch.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// AIDEV-NOTE: the guard guarantees jiraId only ever contains [A-Z0-9-] before
// it is interpolated into an exec arg (and, in the callers, a branch ref).
// Moved here from the two branch callers so the safe-by-construction property
// covers every acli consumer, including the run-start title lookup. Ported
// from the original jira-branch bash script's arg-parsing regex.
const JIRA_ID_RE = /^[A-Z]+-[0-9]+$/

// AIDEV-NOTE: the branch callers passed `{}` — no timeout — so a hanging acli
// stalled them forever. 15 s is generous for a workitem view. Verified against
// pi's execCommand: a timed-out exec resolves as {code: 0, killed: true, stdout:
// ''}, so the hang case lands in the `Could not parse acli JSON response` throw
// rather than the nonzero-exit one — still fail-closed, just a different message.
const ACLI_TIMEOUT_MS = 15_000

export interface JiraIssue {
  summary: string
  issueType: string
}

/**
 * Fetch a Jira work item's summary and issue-type name via `acli`.
 * Throws on an invalid key, a nonzero exit, unparseable JSON, or a missing
 * summary — callers decide whether that aborts (branch derivation) or is
 * merely a warning (best-effort title lookup).
 */
export async function fetchJiraIssue(
  pi: ExtensionAPI,
  jiraId: string,
): Promise<JiraIssue> {
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
    { timeout: ACLI_TIMEOUT_MS },
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

  return { summary, issueType }
}
