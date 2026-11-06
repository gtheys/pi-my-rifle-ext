import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getActiveFlowRef,
  getFlowWorktree,
  restoreFlowBinding,
  setActiveFlowRef,
  setBindingChangeListener,
  setFlowWorktree,
} from '../flow/worktree-context.ts'

afterEach(() => {
  setBindingChangeListener(null)
  setActiveFlowRef(null)
})

test('changes notify the listener with the current snapshot', () => {
  const seen: unknown[] = []
  setBindingChangeListener((s) => seen.push(s))
  setActiveFlowRef('PMR-1')
  setFlowWorktree('/tmp/wt', 'fix/x')
  assert.deepEqual(seen.at(-1), {
    ref: 'PMR-1',
    worktree: { ref: 'PMR-1', path: '/tmp/wt', branch: 'fix/x' },
  })
})

test('restoreFlowBinding rebuilds ref + worktree without notifying', () => {
  let calls = 0
  setBindingChangeListener(() => calls++)
  restoreFlowBinding({
    ref: 'PMR-2',
    worktree: { ref: 'PMR-2', path: '/tmp/wt', branch: 'b' },
  })
  assert.equal(getActiveFlowRef(), 'PMR-2')
  assert.equal(getFlowWorktree()?.path, '/tmp/wt')
  assert.equal(calls, 0)
})

test('restoreFlowBinding drops a worktree belonging to another ref', () => {
  restoreFlowBinding({
    ref: 'PMR-3',
    worktree: { ref: 'PMR-9', path: '/tmp/wt', branch: 'b' },
  })
  assert.equal(getFlowWorktree(), null)
})
