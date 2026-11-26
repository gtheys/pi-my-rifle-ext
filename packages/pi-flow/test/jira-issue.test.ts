import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { deriveBranchName } from '../plan-tools/jira-branch.ts'
import { fetchJiraIssue } from '../plan-tools/jira-issue.ts'
import { deriveBranch } from '../worktree/branch.ts'

// AIDEV-NOTE: PMR-9DZ0 — pi.exec is the only boundary this test mocks. Every
// case pins the exact thrown message that the two migrated branch callers
// (plan-tools/jira-branch.ts, worktree/branch.ts) used to produce inline, so a
// future edit cannot silently change their fail-closed contract.

interface FakeExecResult {
  stdout: string
  stderr: string
  code: number
}

interface ExecCall {
  command: string
  args: string[]
  options: Record<string, unknown>
}

function fakePi(result: FakeExecResult): {
  pi: ExtensionAPI
  calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  const pi = {
    exec: async (
      command: string,
      args: string[],
      options: Record<string, unknown> = {},
    ) => {
      calls.push({ command, args, options })
      return result
    },
  } as unknown as ExtensionAPI
  return { pi, calls }
}

function acliJson(input: unknown): FakeExecResult {
  return { stdout: JSON.stringify(input), stderr: '', code: 0 }
}

test('fetchJiraIssue: returns summary and issuetype name', async () => {
  const { pi, calls } = fakePi(
    acliJson({
      fields: { summary: 'Add save button', issuetype: { name: 'Story' } },
    }),
  )
  const issue = await fetchJiraIssue(pi, 'DP-257')
  assert.deepEqual(issue, { summary: 'Add save button', issueType: 'Story' })
  assert.deepEqual(calls, [
    {
      command: 'acli',
      args: [
        'jira',
        'workitem',
        'view',
        'DP-257',
        '--json',
        '--fields',
        'summary,issuetype',
      ],
      options: { timeout: 15000 },
    },
  ])
})

test('fetchJiraIssue: missing issuetype name yields an empty issueType', async () => {
  const { pi } = fakePi(acliJson({ fields: { summary: 'Only a summary' } }))
  const issue = await fetchJiraIssue(pi, 'DP-257')
  assert.deepEqual(issue, { summary: 'Only a summary', issueType: '' })
})

test('fetchJiraIssue: invalid key throws before any exec', async () => {
  const { pi, calls } = fakePi(
    acliJson({ fields: { summary: 'Unused', issuetype: { name: 'Bug' } } }),
  )
  await assert.rejects(
    () => fetchJiraIssue(pi, 'dp-257'),
    /^Error: Invalid Jira key 'dp-257' — expected format like IMP-1234$/,
  )
  assert.deepEqual(calls, [])
})

test('fetchJiraIssue: nonzero exit throws with stderr', async () => {
  const { pi } = fakePi({ stdout: '', stderr: 'boom', code: 1 })
  await assert.rejects(
    () => fetchJiraIssue(pi, 'DP-257'),
    /^Error: acli failed to fetch 'DP-257': boom$/,
  )
})

test('fetchJiraIssue: nonzero exit with empty stderr falls back to stdout', async () => {
  const { pi } = fakePi({ stdout: 'nope', stderr: '', code: 2 })
  await assert.rejects(
    () => fetchJiraIssue(pi, 'DP-257'),
    /^Error: acli failed to fetch 'DP-257': nope$/,
  )
})

test('fetchJiraIssue: malformed JSON throws', async () => {
  const { pi } = fakePi({ stdout: 'not json', stderr: '', code: 0 })
  await assert.rejects(
    () => fetchJiraIssue(pi, 'DP-257'),
    /^Error: Could not parse acli JSON response for 'DP-257'$/,
  )
})

test('fetchJiraIssue: missing summary throws', async () => {
  const { pi } = fakePi(acliJson({ fields: { issuetype: { name: 'Bug' } } }))
  await assert.rejects(
    () => fetchJiraIssue(pi, 'DP-257'),
    /^Error: Could not parse summary from Jira response for 'DP-257'$/,
  )
})

// --- caller delegation pins (PMR-9DZ0) -------------------------------------
// AIDEV-NOTE: these cases pin the migrated callers' observable output so the
// extraction cannot silently change a branch name or an error message. The
// expected values were verified against the pre-refactor inline implementation
// (same tests green with the old callers checked out).

test('plan-tools deriveBranchName delegates to the helper', async () => {
  const { pi, calls } = fakePi(
    acliJson({
      fields: { summary: 'Add save button', issuetype: { name: 'Story' } },
    }),
  )
  const derived = await deriveBranchName(pi, 'DP-257')
  assert.deepEqual(derived, {
    branch: 'feature/DP-257-add-save-button',
    summary: 'Add save button',
    issueType: 'Story',
    prefix: 'feature',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'acli')
})

test('plan-tools deriveBranchName throws the helper message on bad key', async () => {
  const { pi, calls } = fakePi(
    acliJson({ fields: { summary: 'Unused', issuetype: { name: 'Bug' } } }),
  )
  await assert.rejects(
    () => deriveBranchName(pi, 'dp-257'),
    /^Error: Invalid Jira key 'dp-257' — expected format like IMP-1234$/,
  )
  assert.deepEqual(calls, [])
})

test('worktree deriveBranch delegates to the helper for jira input', async () => {
  const { pi, calls } = fakePi(
    acliJson({
      fields: { summary: 'Add save button', issuetype: { name: 'Bug' } },
    }),
  )
  const branch = await deriveBranch(pi, { kind: 'jira', jiraId: 'DP-257' })
  assert.deepEqual(branch, {
    branch: 'bugfix/DP-257-add-save-button',
    source: 'jira',
  })
  assert.equal(calls.length, 1)
})

test('worktree deriveBranch throws the helper message on bad key', async () => {
  const { pi, calls } = fakePi(
    acliJson({ fields: { summary: 'Unused', issuetype: { name: 'Bug' } } }),
  )
  await assert.rejects(
    () => deriveBranch(pi, { kind: 'jira', jiraId: 'dp-257' }),
    /^Error: Invalid Jira key 'dp-257' — expected format like IMP-1234$/,
  )
  assert.deepEqual(calls, [])
})

// AIDEV-NOTE: pi's execCommand reports a timed-out exec as
// {code: 0, killed: true, stdout: ''} (verified live against the installed pi
// 1.5.2 runtime), so a hung acli surfaces from the helper as the JSON-parse
// throw, not the nonzero-exit one.
test('fetchJiraIssue: exec timeout shape (code 0, empty stdout) throws', async () => {
  const { pi } = fakePi({ stdout: '', stderr: '', code: 0 })
  await assert.rejects(
    () => fetchJiraIssue(pi, 'DP-257'),
    /^Error: Could not parse acli JSON response for 'DP-257'$/,
  )
})
