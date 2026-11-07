import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearFlowEnv,
  FLOW_ENV_KEYS,
  newTraceparent,
  stampFlowPhase,
  stampFlowStart,
} from '../flow/attribution.ts'

// Deterministic rng: returns a fixed 24-byte pattern (0x00..0x17).
function fixedRng(): Uint8Array {
  return Uint8Array.from({ length: 24 }, (_, i) => i)
}

test('newTraceparent: W3C shape from injected randomness', () => {
  const tp = newTraceparent(fixedRng)
  assert.match(tp, /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  const parts = tp.split('-')
  assert.equal(parts[0], '00')
  assert.equal(parts[1], '000102030405060708090a0b0c0d0e0f')
  assert.equal(parts[2], '1011121314151617')
  assert.equal(parts[3], '01')
})

test('newTraceparent: each call gets a fresh trace id (default rng)', () => {
  const a = newTraceparent()
  const b = newTraceparent()
  assert.notEqual(a.split('-')[1], b.split('-')[1])
})

test('stampFlowStart: stamps ref, phase, traceparent', () => {
  const env: Record<string, string | undefined> = {}
  const result = stampFlowStart(env, 'PMR-AB12', 'implement', fixedRng)
  assert.deepEqual(result, { ok: true })
  assert.equal(env.PI_FLOW_REF, 'PMR-AB12')
  assert.equal(env.PI_FLOW_PHASE, 'implement')
  assert.match(
    env.PI_FLOW_TRACEPARENT ?? '',
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
  )
})

test('stampFlowStart: regenerates the traceparent on every start (no stale reuse)', () => {
  const env: Record<string, string | undefined> = {}
  stampFlowStart(env, 'PMR-1', 'plan', fixedRng)
  const first = env.PI_FLOW_TRACEPARENT
  stampFlowStart(env, 'PMR-1', 'plan', fixedRng)
  // Same injected rng WOULD produce the same value; production uses real
  // randomness — the contract tested here is that start always RE-STAMPS
  // rather than keeping whatever was there.
  assert.equal(env.PI_FLOW_TRACEPARENT, first)
  stampFlowStart(env, 'PMR-1', 'plan')
  assert.notEqual(env.PI_FLOW_TRACEPARENT, first)
})

test('stampFlowStart: rejects refs outside the safe charset (fail closed)', () => {
  for (const bad of [
    '',
    'PMR/../../etc',
    'has space',
    '.hidden',
    'a'.repeat(101),
  ]) {
    const env: Record<string, string | undefined> = {}
    const result = stampFlowStart(env, bad, 'plan')
    assert.equal(result.ok, false, `expected rejection for "${bad}"`)
    assert.deepEqual(env, {})
  }
})

test('stampFlowStart: rejects invalid phase', () => {
  const env: Record<string, string | undefined> = {}
  const result = stampFlowStart(env, 'PMR-1', 'not a phase')
  assert.equal(result.ok, false)
  assert.deepEqual(env, {})
})

test('stampFlowPhase: updates the phase, ignores invalid values', () => {
  const env: Record<string, string | undefined> = {}
  stampFlowStart(env, 'PMR-1', 'research')
  stampFlowPhase(env, 'validate')
  assert.equal(env.PI_FLOW_PHASE, 'validate')
  stampFlowPhase(env, 'bad phase!')
  assert.equal(env.PI_FLOW_PHASE, 'validate')
})

test('clearFlowEnv: removes every flow key', () => {
  const env: Record<string, string | undefined> = {
    PI_FLOW_REF: 'PMR-1',
    PI_FLOW_PHASE: 'done-ish',
    PI_FLOW_TRACEPARENT: '00-'.padEnd(55, '0'),
    PI_FLOW_SUBTASK: 'stale',
    UNRELATED: 'kept',
  }
  clearFlowEnv(env)
  assert.equal(env.PI_FLOW_REF, undefined)
  assert.equal(env.PI_FLOW_PHASE, undefined)
  assert.equal(env.PI_FLOW_TRACEPARENT, undefined)
  assert.equal(env.PI_FLOW_SUBTASK, undefined)
  assert.equal(env.UNRELATED, 'kept')
  for (const key of FLOW_ENV_KEYS) assert.equal(key in env, false)
})
