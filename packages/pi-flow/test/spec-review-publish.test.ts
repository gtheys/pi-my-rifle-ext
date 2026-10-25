// AIDEV-NOTE: tests for /spec-publish (PMR-MR36, subtask PMR-2D2X) — pure
// parts only: root resolution, worker task text, arg parsing. The subagent
// spawn itself needs mux and is not unit-tested.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildPublishWorkerTask,
  isPublishSuccess,
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
  it('accepts one ref plus --workspace in any position', () => {
    assert.deepEqual(parseSpecPublishArgs('--workspace ws2 PMR-AB12'), {
      kind: 'ok',
      ref: 'PMR-AB12',
      workspace: 'ws2',
    })
    assert.deepEqual(parseSpecPublishArgs('PMR-AB12 --workspace ws2'), {
      kind: 'ok',
      ref: 'PMR-AB12',
      workspace: 'ws2',
    })
  })
  it('omits workspace when the flag is absent', () => {
    assert.deepEqual(parseSpecPublishArgs('PMR-AB12'), {
      kind: 'ok',
      ref: 'PMR-AB12',
    })
  })
  it('rejects --workspace without a value or without a ref', () => {
    assert.equal(parseSpecPublishArgs('--workspace').kind, 'help')
    assert.equal(parseSpecPublishArgs('--workspace ws2').kind, 'help')
    assert.equal(parseSpecPublishArgs('a b c').kind, 'help')
  })
  it('rejects zero and multiple args', () => {
    assert.equal(parseSpecPublishArgs('').kind, 'help')
    assert.equal(parseSpecPublishArgs('a b').kind, 'help')
  })
})

describe('resolvePublishRoot', () => {
  // AIDEV-NOTE: PMR-7FEP — root derives from the planPath prefix, not the
  // repo toplevel mode: local (non-Jira) plans live under a notes root in ANY
  // mode. Each case must match on the <root>/<repo>/ boundary.
  const repo = 'pi-my-rifle-ext'
  const planUnder = (notesRoot: string) => `${notesRoot}/${repo}/plan.md`
  it('publishes a plan under PERSONAL_FEATURES/<repo> there', () => {
    const result = resolvePublishRoot({
      repo,
      planPath: planUnder('/home/x/features'),
      env: { PERSONAL_FEATURES: '/home/x/features' },
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/home/x/features/pi-my-rifle-ext',
      planFile: planUnder('/home/x/features'),
      isFallback: false,
    })
  })
  it('publishes a plan under LLM_NOTES_ROOT/<repo> there (work mode too)', () => {
    const result = resolvePublishRoot({
      repo,
      planPath: planUnder('/home/x/notes'),
      env: { LLM_NOTES_ROOT: '/home/x/notes' },
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/home/x/notes/pi-my-rifle-ext',
      planFile: planUnder('/home/x/notes'),
      isFallback: false,
    })
  })
  it('ignores a trailing slash on the notes root env var', () => {
    const result = resolvePublishRoot({
      repo,
      planPath: planUnder('/home/x/features'),
      env: { PERSONAL_FEATURES: '/home/x/features/' },
    })
    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.equal(result.root, '/home/x/features/pi-my-rifle-ext')
      assert.equal(result.isFallback, false)
    }
  })
  it('does not match a sibling repo with a prefix-colliding name', () => {
    const result = resolvePublishRoot({
      repo: 'my-rifle-ext',
      planPath: '/home/x/notes/pi-my-rifle-ext/plan.md',
      toplevel: '/repo/toplevel',
      env: { LLM_NOTES_ROOT: '/home/x/notes' },
    })
    assert.equal(result.kind, 'ok')
    if (result.kind === 'ok') {
      assert.equal(result.root, '/repo/toplevel')
      assert.equal(result.isFallback, true)
    }
  })
  it('falls back to project toplevel when planPath is under neither root', () => {
    const result = resolvePublishRoot({
      repo,
      planPath: '/repo/toplevel/.pi/plans/plan.md',
      toplevel: '/repo/toplevel',
      env: {
        PERSONAL_FEATURES: '/home/x/features',
        LLM_NOTES_ROOT: '/home/x/notes',
      },
    })
    assert.deepEqual(result, {
      kind: 'ok',
      root: '/repo/toplevel',
      planFile: '/repo/toplevel/.pi/plans/plan.md',
      isFallback: true,
    })
  })
  it('falls back to project toplevel when both env vars are unset', () => {
    const result = resolvePublishRoot({
      repo,
      planPath: '/repo/toplevel/.pi/plans/plan.md',
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
      repo,
      planPath: '/somewhere/else/plan.md',
      env: {},
    })
    assert.equal(result.kind, 'error')
  })
  it('reads process.env when no env override is passed', () => {
    const old = process.env.PERSONAL_FEATURES
    process.env.PERSONAL_FEATURES = '/env/features'
    try {
      const result = resolvePublishRoot({
        repo,
        planPath: planUnder('/env/features'),
      })
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

describe('isPublishSuccess', () => {
  it('requires the PUBLISH OK marker', () => {
    assert.equal(isPublishSuccess('all steps ok\nPUBLISH OK'), true)
  })
  it('treats exit-0 output without the marker as failure', () => {
    assert.equal(isPublishSuccess('exited with code 0, did some work'), false)
  })
  it('fails loud on PUBLISH FAILED', () => {
    assert.equal(isPublishSuccess('PUBLISH FAILED: push rejected'), false)
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
