import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addSecondsIso,
  LIVE_WAIT_HEARTBEAT_MS,
  LIVE_WAIT_LEASE_SECONDS,
} from '../flow/live-wait.ts'

test('addSecondsIso: fixed-width UTC in, fixed-width UTC out', () => {
  const at = '2026-11-28T00:00:00.000Z'
  const next = addSecondsIso(at, 180)
  assert.equal(next, '2026-11-28T00:03:00.000Z')
  // Fixed-width like every journal `at` (new Date().toISOString()): same
  // length as the input, one T, one trailing Z, millisecond precision.
  assert.equal(next.length, at.length)
  assert.match(next, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('addSecondsIso: zero seconds is the same instant', () => {
  assert.equal(
    addSecondsIso('2026-11-28T00:00:00.000Z', 0),
    '2026-11-28T00:00:00.000Z',
  )
})

test('addSecondsIso: crosses a day boundary', () => {
  assert.equal(
    addSecondsIso('2026-11-28T23:59:30.000Z', 90),
    '2026-11-29T00:01:00.000Z',
  )
})

test('addSecondsIso: millisecond precision is preserved', () => {
  assert.equal(
    addSecondsIso('2026-11-28T00:00:00.456Z', 1),
    '2026-11-28T00:00:01.456Z',
  )
})

test('tunables: heartbeat is 60s, lease window is 180s', () => {
  assert.equal(LIVE_WAIT_HEARTBEAT_MS, 60_000)
  assert.equal(LIVE_WAIT_LEASE_SECONDS, 180)
})

test('invariant: lease window tolerates at least 2 missed beats', () => {
  // AIDEV-NOTE: pins the window/beat ratio from flow/live-wait.ts — if either
  // tunable moves so the window covers fewer than two heartbeats, a single
  // missed beat would release a live wait (the strand this lease prevents).
  const beats = (LIVE_WAIT_LEASE_SECONDS * 1000) / LIVE_WAIT_HEARTBEAT_MS
  assert.ok(beats >= 2, `lease covers only ${beats} heartbeat(s)`)
})
