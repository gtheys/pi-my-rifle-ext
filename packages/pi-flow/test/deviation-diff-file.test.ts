import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDeviationReviewPrompt,
  checkDiffLinesRead,
  countDiffLines,
  fenceBlock,
} from '../review/deviation.ts'

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

test('countDiffLines: detection matrix — trailing newline, none, single line, empty', () => {
  // PMR-Q23K: git diffs end with a newline; countDiffLines reports the
  // wc -l count by design, not split('\n').length. Read tools show the
  // split convention (expected + 1) instead (PMR-Z2RA), which is why
  // checkDiffLinesRead accepts both counts — this matrix pins the wc -l
  // side of that contract.
  assert.equal(countDiffLines('a\nb\n'), 2)
  assert.equal(countDiffLines('a\nb\nc'), 3)
  assert.equal(countDiffLines('a\n'), 1)
  assert.equal(countDiffLines('a'), 1)
  assert.equal(countDiffLines(''), 0)
  assert.equal(countDiffLines('a\n\n'), 2)
})

test('countDiffLines: a real 1142-line trailing-newline diff counts 1142 (incident regression)', () => {
  // PMR-Q23K incident: git diff 5e46608..HEAD was exactly 1142 lines by
  // wc -l; the gate expected 1143 and no reviewer could ever pass.
  const lines = Array.from({ length: 1142 }, (_, i) => `+line ${i + 1}`)
  const diff = `${lines.join('\n')}\n`
  assert.equal(countDiffLines(diff), 1142)
})

test('gate contract: a verdict echoing every line passes; a skipped line fails (PMR-Q23K)', () => {
  const lines = Array.from({ length: 1142 }, (_, i) => `+line ${i + 1}`)
  const diff = `${lines.join('\n')}\n`
  // Reviewer read all 1142 lines of the trailing-newline diff → accepted.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 1142'), {
    ok: true,
  })
  // Reviewer genuinely skipped a line → still rejected.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 1141'), {
    ok: false,
    expected: 1142,
    got: 1141,
  })
  // No echo at all → rejected.
  assert.deepEqual(checkDiffLinesRead(diff, 'looks fine'), {
    ok: false,
    expected: 1142,
    got: null,
  })
  // Diff without a trailing newline: the unterminated last line counts.
  assert.deepEqual(checkDiffLinesRead('a\nb\nc', 'diff_lines_read: 3'), {
    ok: true,
  })
})

test('gate contract: read-tool split-convention echo (expected+1) is accepted on newline-terminated diffs (PMR-Z2RA)', () => {
  // PMR-ZGPY incident shape, miniaturized: a 3294-line diff ending in a
  // newline; the reviewer's read tool numbers the phantom final segment and
  // echoes 3295. The gate (wc-l convention) demanded 3294 and hard-failed.
  const lines = Array.from({ length: 3294 }, (_, i) => `+line ${i + 1}`)
  const diff = `${lines.join('\n')}\n`
  assert.equal(countDiffLines(diff), 3294)
  // The read tool's split-convention total: 3294 real lines + phantom 3295th.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 3295'), {
    ok: true,
  })
})

test('gate contract: anti-skim holds under either-convention acceptance (PMR-Z2RA)', () => {
  const lines = Array.from({ length: 3294 }, (_, i) => `+line ${i + 1}`)
  const diff = `${lines.join('\n')}\n`
  // wc-l convention echo still accepted (PMR-Q23K contract unchanged).
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 3294'), {
    ok: true,
  })
  // Skipped the last line → rejected under BOTH conventions.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 3293'), {
    ok: false,
    expected: 3294,
    got: 3293,
  })
  // Arbitrary skim count → rejected.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 100'), {
    ok: false,
    expected: 3294,
    got: 100,
  })
  // Acceptance set is exactly {expected, expected+1} (PMR-6AE0): an echo
  // ABOVE the split-convention total is rejected — a reviewer cannot claim
  // to have read more lines than the diff can produce.
  assert.deepEqual(checkDiffLinesRead(diff, 'diff_lines_read: 3296'), {
    ok: false,
    expected: 3294,
    got: 3296,
  })
  // No trailing newline: conventions agree, so expected+1 must NOT pass —
  // the final segment is a real line, not a phantom one.
  assert.deepEqual(checkDiffLinesRead('a\nb\nc', 'diff_lines_read: 4'), {
    ok: false,
    expected: 3,
    got: 4,
  })
})
