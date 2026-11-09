import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDeviationReviewPrompt, fenceBlock } from '../review/deviation.ts'

const base = {
  mode: 'work' as const,
  spec: 'A spec that is long enough to be compared against the diff.',
  commitMessages: 'feat: x',
  avenNotes: '',
}

test('fenceBlock: fence is longer than any backtick run inside', () => {
  const out = fenceBlock('a ```` b', 'diff')
  assert.ok(out.startsWith('`````diff\n'))
  assert.ok(out.endsWith('\n`````'))
})

test('prompt: inline diff is fenced', () => {
  const p = buildDeviationReviewPrompt({ ...base, diff: '> quote\n+ add' })
  assert.ok(p.includes('```diff\n> quote\n+ add\n```'))
})

test('prompt: diffPath replaces the inline diff', () => {
  const p = buildDeviationReviewPrompt({
    ...base,
    diff: 'SECRET-DIFF-BODY',
    diffPath: '/tmp/x/pinned.diff',
  })
  assert.ok(p.includes('/tmp/x/pinned.diff'))
  assert.ok(!p.includes('SECRET-DIFF-BODY'))
})

test('diff_lines_read: last line wins, absent is null, count matches split', async () => {
  const { extractDiffLinesRead, countDiffLines } = await import(
    '../review/deviation.ts'
  )
  assert.equal(
    extractDiffLinesRead('x\ndiff_lines_read: 5\ndiff_lines_read: 7\n'),
    7,
  )
  assert.equal(extractDiffLinesRead('nothing'), null)
  assert.equal(countDiffLines('a\nb\nc'), 3)
})

test('prompt: file mode asks for the proof without leaking the count', () => {
  const diff = 'a\nb\nc\nd'
  const p = buildDeviationReviewPrompt({
    ...base,
    diff,
    diffPath: '/tmp/p.diff',
  })
  assert.ok(p.includes('diff_lines_read: <N>'))
  assert.ok(!p.includes('diff_lines_read: 4'))
})
