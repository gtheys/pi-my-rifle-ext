import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyFlowEnv,
  emitFlowSpawn,
  FLOW_VALUE_RE,
  isValidFlowValue,
  isValidTraceparent,
  onFlowSpawn,
  TRACEPARENT_RE,
} from '../pi-extension/subagents/flow-env.ts'

test('FLOW_VALUE_RE accepts ticket-shaped refs, rejects path escapes', () => {
  assert.equal(FLOW_VALUE_RE.test('PMR-AB12'), true)
  assert.equal(FLOW_VALUE_RE.test('DP-71'), true)
  assert.equal(FLOW_VALUE_RE.test('implement'), true)
  assert.equal(FLOW_VALUE_RE.test(''), false)
  assert.equal(FLOW_VALUE_RE.test('PMR/../../etc'), false)
  assert.equal(FLOW_VALUE_RE.test('has space'), false)
  assert.equal(FLOW_VALUE_RE.test('.hidden'), false)
  assert.equal(FLOW_VALUE_RE.test('a'.repeat(101)), false)
})

test('applyFlowEnv: forwards valid parent flow vars into the child env', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(
    env,
    {
      PI_FLOW_REF: 'PMR-AB12',
      PI_FLOW_PHASE: 'implement',
      PI_FLOW_TRACEPARENT:
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      PI_SUBAGENT_NAME: 'worker-1',
    },
    'PMR-CD34',
  )
  assert.deepEqual(env, {
    PI_FLOW_REF: 'PMR-AB12',
    PI_FLOW_PHASE: 'implement',
    PI_FLOW_TRACEPARENT:
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    PI_FLOW_SUBTASK: 'PMR-CD34',
  })
})

test('applyFlowEnv: no flow vars set -> child env untouched (plain subagent use)', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(env, { HOME: '/home/x' })
  assert.deepEqual(env, {})
})

test('applyFlowEnv: invalid values are dropped, never forwarded mangled', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(
    env,
    {
      PI_FLOW_REF: 'bad ref!',
      PI_FLOW_PHASE: '../escape',
      PI_FLOW_TRACEPARENT: 'not-a-traceparent',
    },
    'also bad!',
  )
  assert.deepEqual(env, {})
})

test('applyFlowEnv: subtask omitted for scouts (no subtask arg)', () => {
  const env: Record<string, string> = {}
  applyFlowEnv(env, { PI_FLOW_REF: 'PMR-1', PI_FLOW_PHASE: 'research' })
  assert.equal(env.PI_FLOW_REF, 'PMR-1')
  assert.equal('PI_FLOW_SUBTASK' in env, false)
})

test('traceparent validation', () => {
  assert.equal(
    isValidTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    ),
    true,
  )
  assert.equal(isValidTraceparent('00-UPPER-00f067aa0ba902b7-01'), false)
  assert.equal(
    isValidTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'),
    false,
  )
  assert.equal(isValidTraceparent(undefined), false)
})

test('isValidFlowValue handles undefined', () => {
  assert.equal(isValidFlowValue(undefined), false)
  assert.equal(isValidFlowValue('PMR-1'), true)
})

test('onFlowSpawn/emitFlowSpawn: listener receives info; unsubscribe works', () => {
  const seen: string[] = []
  const off = onFlowSpawn((info) => {
    seen.push(`${info.kind}:${info.childId}:${info.subtask ?? '-'}`)
  })
  emitFlowSpawn({ kind: 'spawn', childId: 'c1', name: 'worker' })
  emitFlowSpawn({ kind: 'resume', childId: 'c2', name: 'w2', subtask: 'PMR-9' })
  off()
  emitFlowSpawn({ kind: 'reattach', childId: 'c3', name: 'w3' })
  assert.deepEqual(seen, ['spawn:c1:-', 'resume:c2:PMR-9'])
})

test('emitFlowSpawn: a throwing listener never breaks the spawn', () => {
  const seen: string[] = []
  onFlowSpawn(() => {
    throw new Error('boom')
  })
  onFlowSpawn((info) => {
    seen.push(info.childId)
  })
  emitFlowSpawn({ kind: 'spawn', childId: 'c9', name: 'worker' })
  assert.deepEqual(seen, ['c9'])
})
