import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFlowEnv } from '../pi-extension/subagents/flow-env.ts'

test('applyFlowEnv forwards the tracking ref and mode (work/personal separation)', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(env, {
    PI_FLOW_REF: 'DP-AB12',
    PI_FLOW_TRACK_REF: 'DP-236',
    PI_FLOW_MODE: 'work',
  })
  assert.equal(env.PI_FLOW_TRACK_REF, 'DP-236')
  assert.equal(env.PI_FLOW_MODE, 'work')
})

test('applyFlowEnv drops an invalid tracking ref and an unknown mode', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(env, {
    PI_FLOW_REF: 'DP-AB12',
    PI_FLOW_TRACK_REF: 'bad ref!',
    PI_FLOW_MODE: 'weird',
  })
  assert.equal(env.PI_FLOW_TRACK_REF, undefined)
  assert.equal(env.PI_FLOW_MODE, undefined)
})
