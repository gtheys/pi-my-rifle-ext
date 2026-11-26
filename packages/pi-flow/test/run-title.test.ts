import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveRunTitle, sanitizeTitle, TITLE_MAX } from '../run-title.ts'

// AIDEV-NOTE: PMR-9DZ0 — run-title resolver tests. Two public seams: the pure
// sanitizer and the pi-bound resolver. The ONLY boundary faked for the
// resolver is pi.exec (the acli call inside fetchJiraIssue) — same fakePi
// shape as test/jira-issue.test.ts. resolveRunTitle must never throw.

// --- sanitizeTitle ----------------------------------------------------------

test('sanitizeTitle: control chars become spaces and the result is single-line', () => {
  assert.equal(sanitizeTitle('line1\nline2\rline3'), 'line1 line2 line3')
  assert.equal(sanitizeTitle('bell\u0007tab\u0009done'), 'bell tab done')
  assert.equal(sanitizeTitle('nul\u0000sep'), 'nul sep')
  assert.equal(sanitizeTitle('del\u007fend'), 'del end')
  assert.equal(sanitizeTitle('c1\u0085c2\u009fend'), 'c1 c2 end')
})

test('sanitizeTitle: whitespace runs collapse to one space and edges trim', () => {
  assert.equal(sanitizeTitle('  lots   of \t space  '), 'lots of space')
  // a newline is a control char AND whitespace: replaced then collapsed
  assert.equal(sanitizeTitle('a \n\n  b'), 'a b')
})

test('sanitizeTitle: caps at TITLE_MAX (120) after collapsing/trimming', () => {
  assert.equal(TITLE_MAX, 120)
  const long = 'x'.repeat(200)
  const capped = sanitizeTitle(long)
  assert.ok(capped !== undefined)
  assert.equal(capped.length, 120)
  assert.equal(capped, 'x'.repeat(120))
  // exactly 120 stays 120, 119 stays 119
  assert.equal(sanitizeTitle('y'.repeat(120))?.length, 120)
  assert.equal(sanitizeTitle('y'.repeat(119))?.length, 119)
})

test('sanitizeTitle: empty or whitespace/control-only input yields undefined', () => {
  assert.equal(sanitizeTitle(''), undefined)
  assert.equal(sanitizeTitle('   '), undefined)
  assert.equal(sanitizeTitle('\n\r\t'), undefined)
  assert.equal(sanitizeTitle('\u0000 \u001f'), undefined)
})

test('sanitizeTitle: unicode (accented, CJK, emoji, em dash) is preserved', () => {
  assert.equal(
    sanitizeTitle('Café — 日本語 🚀 DP-257'),
    'Café — 日本語 🚀 DP-257',
  )
})

// --- resolveRunTitle --------------------------------------------------------

// AIDEV-NOTE: fakePi mirrors test/jira-issue.test.ts — pi.exec is the only
// boundary faked. fetchJiraIssue's throws (nonzero exit, bad JSON, missing
// summary) are produced through the exec result, never by stubbing the helper.
interface FakeExecResult {
  stdout: string
  stderr: string
  code: number
}

function fakePi(result: FakeExecResult): {
  pi: ExtensionAPI
  calls: string[][]
} {
  const calls: string[][] = []
  const pi = {
    exec: async (command: string, args: string[]) => {
      calls.push([command, ...args])
      return result
    },
  } as unknown as ExtensionAPI
  return { pi, calls }
}

function acliJson(input: unknown): FakeExecResult {
  return { stdout: JSON.stringify(input), stderr: '', code: 0 }
}

test('resolveRunTitle: personal mode returns the aven snapshot title, no lookup', async () => {
  const { pi, calls } = fakePi({ stdout: '', stderr: '', code: 0 })
  const result = await resolveRunTitle(pi, {
    mode: 'personal',
    avenTitle: 'Show the ticket title on dashboards\n(second line)',
    jiraKey: null,
  })
  assert.deepEqual(result, {
    title: 'Show the ticket title on dashboards (second line)',
    warning: null,
  })
  assert.deepEqual(calls, [])
})

test('resolveRunTitle: personal mode without an avenTitle is silent', async () => {
  const { pi, calls } = fakePi({ stdout: '', stderr: '', code: 0 })
  const result = await resolveRunTitle(pi, {
    mode: 'personal',
    jiraKey: null,
  })
  assert.deepEqual(result, { warning: null })
  assert.deepEqual(calls, [])
})

test('resolveRunTitle: personal mode with a blank avenTitle is silent', async () => {
  const { pi } = fakePi({ stdout: '', stderr: '', code: 0 })
  const result = await resolveRunTitle(pi, {
    mode: 'personal',
    avenTitle: '   \n  ',
    jiraKey: null,
  })
  assert.equal(result.title, undefined)
  assert.equal(result.warning, null)
})

test('resolveRunTitle: personal mode still ignores a present jiraKey', async () => {
  const { pi, calls } = fakePi(
    acliJson({ fields: { summary: 'Should not be fetched' } }),
  )
  const result = await resolveRunTitle(pi, {
    mode: 'personal',
    avenTitle: 'Aven title',
    jiraKey: 'DP-257',
  })
  assert.deepEqual(result, { title: 'Aven title', warning: null })
  assert.deepEqual(calls, [])
})

test('resolveRunTitle: work mode fetches and sanitizes the Jira summary', async () => {
  const { pi, calls } = fakePi(
    acliJson({
      fields: { summary: 'Add  save\nbutton 🚀', issuetype: { name: 'Story' } },
    }),
  )
  const result = await resolveRunTitle(pi, {
    mode: 'work',
    jiraKey: 'DP-257',
  })
  assert.deepEqual(result, { title: 'Add save button 🚀', warning: null })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [
    'acli',
    'jira',
    'workitem',
    'view',
    'DP-257',
    '--json',
    '--fields',
    'summary,issuetype',
  ])
})

test('resolveRunTitle: work mode with a null jiraKey is silent, no exec', async () => {
  const { pi, calls } = fakePi(
    acliJson({ fields: { summary: 'Unused', issuetype: { name: 'Story' } } }),
  )
  const result = await resolveRunTitle(pi, { mode: 'work', jiraKey: null })
  assert.equal(result.title, undefined)
  assert.equal(result.warning, null)
  assert.deepEqual(calls, [])
})

test('resolveRunTitle: work mode acli failure warns and never throws', async () => {
  const { pi } = fakePi({ stdout: '', stderr: 'boom', code: 1 })
  const result = await resolveRunTitle(pi, { mode: 'work', jiraKey: 'DP-257' })
  assert.equal(result.title, undefined)
  assert.equal(
    result.warning,
    "title lookup failed for DP-257 — continuing without a title (acli failed to fetch 'DP-257': boom)",
  )
})

test('resolveRunTitle: work mode invalid key failure warns, never throws', async () => {
  const { pi, calls } = fakePi({ stdout: '', stderr: '', code: 0 })
  const result = await resolveRunTitle(pi, { mode: 'work', jiraKey: 'dp-257' })
  assert.equal(result.title, undefined)
  assert.equal(
    result.warning,
    "title lookup failed for dp-257 — continuing without a title (Invalid Jira key 'dp-257' — expected format like IMP-1234)",
  )
  assert.deepEqual(calls, [])
})

test('resolveRunTitle: work mode missing summary warns, never throws', async () => {
  const { pi } = fakePi(acliJson({ fields: { issuetype: { name: 'Bug' } } }))
  const result = await resolveRunTitle(pi, { mode: 'work', jiraKey: 'DP-257' })
  assert.equal(result.title, undefined)
  assert.ok(result.warning !== null)
  assert.ok(result.warning.startsWith('title lookup failed for DP-257 — '))
})

test('resolveRunTitle: an exec that rejects is caught too (never throws)', async () => {
  const pi = {
    exec: async () => {
      throw new Error('spawn ENOENT')
    },
  } as unknown as ExtensionAPI
  const result = await resolveRunTitle(pi, { mode: 'work', jiraKey: 'DP-257' })
  assert.equal(result.title, undefined)
  assert.equal(
    result.warning,
    'title lookup failed for DP-257 — continuing without a title (spawn ENOENT)',
  )
})
