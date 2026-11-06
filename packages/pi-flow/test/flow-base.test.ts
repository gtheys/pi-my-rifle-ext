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

test('recordFlowBase writes branch.<feature>.flowbase', async () => {
  const calls: string[][] = []
  const exec: Exec = async (_c, args) => {
    calls.push(args)
    return { stdout: '', code: 0 }
  }
  const r = await recordFlowBase(exec, '/w', 'feat/x', 'staging')
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], ['config', 'branch.feat/x.flowbase', 'staging'])
})

test('readFlowBase reads recorded base', async () => {
  const exec = fake({
    'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' },
    'config branch.feat/x.flowbase': { stdout: 'develop\n' },
  })
  assert.deepEqual(await readFlowBase(exec, '/w'), {
    ok: true,
    branch: 'develop',
  })
})

test('readFlowBase errors clearly when unset', async () => {
  const exec = fake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' } })
  const r = await readFlowBase(exec, '/w')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /no recorded flow base/)
})
