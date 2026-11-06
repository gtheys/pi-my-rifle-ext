import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlowBindingSnapshot } from '../flow/worktree-context.ts'

test('accepts valid snapshot', () => {
  const s = {
    ref: 'PMR-1',
    worktree: { ref: 'PMR-1', path: '/tmp/w', branch: 'fix/x' },
  }
  assert.deepEqual(parseFlowBindingSnapshot(s), s)
})

test('accepts null ref and missing worktree', () => {
  assert.deepEqual(parseFlowBindingSnapshot({ ref: null }), {
    ref: null,
    worktree: null,
  })
})

test('rejects malformed shapes', () => {
  assert.equal(parseFlowBindingSnapshot(null), null)
  assert.equal(parseFlowBindingSnapshot('x'), null)
  assert.equal(parseFlowBindingSnapshot({ ref: 3 }), null)
  assert.equal(
    parseFlowBindingSnapshot({ ref: 'A', worktree: { ref: 'A', path: 1 } }),
    null,
  )
})
