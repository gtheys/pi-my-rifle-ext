import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type Exec,
  getMergeBase,
  resolveFlowRange,
} from '../shared/diff-base.ts'

function fake(map: Record<string, { stdout?: string; code?: number }>): Exec {
  return async (_cmd, args) => {
    const hit = map[args.join(' ')]
    if (hit === undefined) return { stdout: '', code: 1 }
    return { stdout: hit.stdout ?? '', code: hit.code ?? 0 }
  }
}

test('getMergeBase prefers upstream', async () => {
  const exec = fake({
    'rev-parse --abbrev-ref main@{upstream}': { stdout: 'origin/main\n' },
    'merge-base HEAD origin/main': { stdout: 'aaa\n' },
    'merge-base HEAD main': { stdout: 'bbb\n' },
  })
  assert.equal(await getMergeBase(exec, 'main'), 'aaa')
})

test('getMergeBase falls back to local branch', async () => {
  const exec = fake({ 'merge-base HEAD main': { stdout: 'bbb\n' } })
  assert.equal(await getMergeBase(exec, 'main'), 'bbb')
})

test('getMergeBase null when unresolvable or exec throws', async () => {
  assert.equal(await getMergeBase(fake({}), 'main'), null)
  const boom: Exec = async () => {
    throw new Error('x')
  }
  assert.equal(await getMergeBase(boom, 'main'), null)
})

test('resolveFlowRange ok', async () => {
  const exec = fake({
    'merge-base HEAD main': { stdout: 'bbb\n' },
    'rev-parse HEAD': { stdout: 'ccc\n' },
    'rev-list --count bbb..HEAD': { stdout: '3\n' },
  })
  const r = await resolveFlowRange(exec, '/w', 'main')
  assert.deepEqual(r, {
    ok: true,
    value: {
      baseBranch: 'main',
      baseSha: 'bbb',
      headSha: 'ccc',
      range: 'bbb..HEAD',
      commitCount: 3,
    },
  })
})

test('resolveFlowRange errors when unresolvable', async () => {
  const r = await resolveFlowRange(fake({}), '/w', 'main')
  assert.equal(r.ok, false)
})

test('resolveFlowRange errors on empty range', async () => {
  const exec = fake({
    'merge-base HEAD main': { stdout: 'bbb\n' },
    'rev-parse HEAD': { stdout: 'bbb\n' },
  })
  const r = await resolveFlowRange(exec, '/w', 'main')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /empty range/)
})
