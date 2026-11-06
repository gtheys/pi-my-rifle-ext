import assert from 'node:assert/strict'
import test from 'node:test'
import type { Exec } from '../shared/diff-base.ts'
import {
  currentBranch,
  readFlowBase,
  recordFlowBase,
} from '../shared/flow-base.ts'

function fake(map: Record<string, { stdout?: string; code?: number }>): Exec {
  return async (_cmd, args) => {
    const hit = map[args.join(' ')]
    if (hit === undefined) return { stdout: '', code: 1 }
    return { stdout: hit.stdout ?? '', code: hit.code ?? 0 }
  }
}

test('currentBranch returns develop', async () => {
  const exec = fake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'develop\n' } })
  assert.deepEqual(await currentBranch(exec, '/m'), {
    ok: true,
    branch: 'develop',
  })
})

test('currentBranch refuses detached HEAD', async () => {
  const exec = fake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' } })
  const r = await currentBranch(exec, '/m')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /detached HEAD/)
})

test('recordFlowBase writes flowbase and flowbasesha', async () => {
  const calls: string[][] = []
  const exec: Exec = async (_c, args) => {
    calls.push(args)
    return { stdout: '', code: 0 }
  }
  const r = await recordFlowBase(exec, '/w', 'feat/x', 'staging', 'abc123')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['config', 'branch.feat/x.flowbase', 'staging'])
  assert.deepEqual(calls[1], ['config', 'branch.feat/x.flowbasesha', 'abc123'])
})

test('readFlowBase reads recorded branch and sha', async () => {
  const exec = fake({
    'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' },
    'config branch.feat/x.flowbase': { stdout: 'develop\n' },
    'config branch.feat/x.flowbasesha': { stdout: 'abc\n' },
  })
  assert.deepEqual(await readFlowBase(exec, '/w'), {
    ok: true,
    value: { branch: 'develop', sha: 'abc' },
  })
})

test('readFlowBase: legacy worktree has branch but null sha', async () => {
  const exec = fake({
    'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' },
    'config branch.feat/x.flowbase': { stdout: 'develop\n' },
  })
  const r = await readFlowBase(exec, '/w')
  assert.equal(r.ok && r.value.sha, null)
})

test('readFlowBase errors clearly when unset', async () => {
  const exec = fake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' } })
  const r = await readFlowBase(exec, '/w')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /no recorded flow base/)
})

test('readFlowBase unset: reports worktree not bound with resume steps, no flowbase hint', async () => {
  const exec = fake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' } })
  const r = await readFlowBase(exec, '/w')
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.reason, /worktree is not bound/)
    assert.match(r.reason, /\/flow <ref>/)
    assert.match(r.reason, /worktree action=bind/)
    assert.doesNotMatch(r.reason, /git config/)
  }
})

test('recordFlowBase retries a locked config write then succeeds', async () => {
  let failures = 2
  const exec: Exec = async () => {
    if (failures > 0) {
      failures--
      return { stdout: '', stderr: 'could not lock config file', code: 255 }
    }
    return { stdout: '', code: 0 }
  }
  const r = await recordFlowBase(exec, '/w', 'feat/x', 'main', 'abc', 1)
  assert.equal(r.ok, true)
  assert.equal(failures, 0)
})

test('recordFlowBase gives up after bounded attempts with the last error', async () => {
  let calls = 0
  const exec: Exec = async () => {
    calls++
    return { stdout: '', stderr: 'could not lock config file', code: 255 }
  }
  const r = await recordFlowBase(exec, '/w', 'feat/x', 'main', 'abc', 1)
  assert.equal(r.ok, false)
  assert.equal(calls, 4)
  if (!r.ok) assert.match(r.reason, /could not lock config file/)
})
