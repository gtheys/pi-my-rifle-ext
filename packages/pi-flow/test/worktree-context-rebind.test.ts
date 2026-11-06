import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  getFlowWorktree,
  reactivateFlowRef,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'

afterEach(() => setActiveFlowRef(null))

test('halt then rerun of same ref restores the worktree binding', () => {
  setActiveFlowRef('PMR-9')
  setFlowWorktree('/tmp', 'fix/x')
  setActiveFlowRef(null)
  assert.equal(getFlowWorktree(), null)
  reactivateFlowRef('PMR-9')
  assert.equal(getFlowWorktree()?.path, '/tmp')
})

test('a different ref does not inherit the binding', () => {
  setActiveFlowRef('PMR-9')
  setFlowWorktree('/tmp', 'fix/x')
  setActiveFlowRef(null)
  reactivateFlowRef('PMR-10')
  assert.equal(getFlowWorktree(), null)
})

test('missing path is not restored', () => {
  setActiveFlowRef('PMR-9')
  setFlowWorktree('/nonexistent/wt-xyz', 'fix/x')
  setActiveFlowRef(null)
  reactivateFlowRef('PMR-9')
  assert.equal(getFlowWorktree(), null)
})

test('plain setActiveFlowRef stays a clean slate', () => {
  setActiveFlowRef('PMR-9')
  setFlowWorktree('/tmp', 'fix/x')
  setActiveFlowRef(null)
  setActiveFlowRef('PMR-9')
  assert.equal(getFlowWorktree(), null)
})
