// AIDEV-NOTE: tests for /spec-publish (PMR-MR36, subtask PMR-2D2X) — pure
// parts only: root resolution, worker task text, arg parsing. The subagent
// spawn itself needs mux and is not unit-tested.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildPublishWorkerTask,
  resolvePublishRoot,
} from '../spec-review/publish.ts'
import { parseSpecPublishArgs } from '../spec-review/publish-args.ts'

describe('parseSpecPublishArgs', () => {
  it('accepts exactly one ref', () => {
    assert.deepEqual(parseSpecPublishArgs('PMR-AB12'), {
      kind: 'ok',
      ref: 'PMR-AB12',
    })
    assert.deepEqual(parseSpecPublishArgs('  PMR-AB12  '), {
      kind: 'ok',
      ref: 'PMR-AB12',
    })
  })
  it('rejects zero and multiple args', () => {
    assert.equal(parseSpecPublishArgs('').kind, 'help')
    assert.equal(parseSpecPublishArgs('a b').kind, 'help')
  })
})

describe('resolvePublishRoot', () => {
  const base = {
    repo: 'pi-my-rifle-ext',
    planPath: '/plan/dir/plan.md',
  }
  it('personal mode uses PERSONAL_FEATURES when set', () => {
    const result = resolvePublishRoot({
      ...base,
      mode: 'personal',
      env: { PERSONAL_FEATURES: '/home/x/features' },
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/home/x/features/pi-my-rifle-ext',
      planFile: '/plan/dir/plan.md',
      isFallback: false,
    })
  })
  it('work mode uses LLM_NOTES_ROOT when set', () => {
    const result = resolvePublishRoot({
      ...base,
      mode: 'work',
      env: { LLM_NOTES_ROOT: '/home/x/notes' },
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/home/x/notes/pi-my-rifle-ext',
      planFile: '/plan/dir/plan.md',
      isFallback: false,
    })
  })
  it('personal mode falls back to project toplevel when env unset', () => {
    const result = resolvePublishRoot({
      ...base,
      mode: 'personal',
      toplevel: '/repo/toplevel',
      env: {},
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/repo/toplevel',
      planFile: '/plan/dir/plan.md',
      isFallback: true,
    })
  })
  it('work mode falls back to project toplevel when env unset', () => {
    const result = resolvePublishRoot({
      ...base,
      mode: 'work',
      toplevel: '/repo/toplevel',
      env: {},
    })
    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.equal(result.root, '/repo/toplevel')
      assert.equal(result.isFallback, true)
    }
  })
  it('fallback without toplevel is an error', () => {
    const result = resolvePublishRoot({
      ...base,
      mode: 'personal',
      env: {},
    })
    assert.equal(result.kind, 'error')
  })
  it('reads process.env when no env override is passed', () => {
    const old = process.env.PERSONAL_FEATURES
    process.env.PERSONAL_FEATURES = '/env/features'
    try {
      const result = resolvePublishRoot({ ...base, mode: 'personal' })
      assert.equal(result.kind, 'ok')
      if (result.kind === 'ok') {
        assert.equal(result.root, '/env/features/pi-my-rifle-ext')
      }
    } finally {
      if (old === undefined) delete process.env.PERSONAL_FEATURES
      else process.env.PERSONAL_FEATURES = old
    }
  })
})

describe('buildPublishWorkerTask', () => {
  const task = buildPublishWorkerTask({
    ref: 'PMR-AB12',
    repo: 'my-repo',
    root: '/notes/my-repo',
    planFile: '/notes/my-repo/plan.md',
    isFallback: false,
  })
  it('mentions root, planFile, and each git step', () => {
    assert.ok(task.includes('/notes/my-repo'))
    assert.ok(task.includes('/notes/my-repo/plan.md'))
    assert.ok(task.includes('git fetch'))
    assert.ok(task.includes('git pull'))
    assert.ok(task.includes('git add /notes/my-repo/plan.md'))
    assert.ok(task.includes('git push origin HEAD'))
  })
  it('uses the docs(<repo>) commit message convention', () => {
    assert.ok(task.includes('docs(my-repo): publish PMR-AB12 plan'))
  })
  it('forbids add -A and caps retries at 2', () => {
    assert.ok(task.includes('never') && task.includes('no -A flag'))
    assert.ok(task.includes('2'))
    assert.ok(!task.includes('git add -A'))
  })
})
