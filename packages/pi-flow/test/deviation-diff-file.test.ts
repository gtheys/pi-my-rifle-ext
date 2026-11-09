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
