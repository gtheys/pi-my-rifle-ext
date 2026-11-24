// AIDEV-NOTE (PMR-MSDJ 1.2): runTracking is the SINGLE source for a run's
// tracking ref + mode (extracted from the inline derivation in
// flow/cost-command.ts). Tombstone pushes (PMR-05MQ) build the Pushgateway
// group URL with it, so the work-mode `/mode/work` suffix rule pinned here
// must stay byte-identical to what cost pushes used before the extraction.
// The REAL rule (do not "simplify"): mode comes from the LAST run-start
// event's `mode` FIELD — not from whether trackRef is set; trackRef falls
// back to the aven ref only when that event's trackRef is absent or empty.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type FlowRunEvent, runTracking } from '../run-state.ts'

function runStart(
  mode: 'work' | 'personal',
  trackRef?: string,
  at = '2026-11-07T07:00:00.000Z',
): FlowRunEvent {
  const event: FlowRunEvent = {
    kind: 'run-start',
    at,
    ref: 'PMR-AB12',
    mode,
  }
  if (trackRef !== undefined) {
    // Mirrors the writer: stampFlowStart omits trackRef for personal runs,
    // so journals carry the key only when it is present.
    return { ...event, trackRef }
  }
  return event
}

test('runTracking: no run-start event falls back to the aven ref, personal mode', () => {
  const events: FlowRunEvent[] = [
    {
      kind: 'phase-start',
      at: '2026-11-07T07:00:00.000Z',
      ref: 'PMR-AB12',
      phase: 'plan',
    },
  ]
  assert.deepEqual(runTracking(events, 'PMR-AB12'), {
    trackRef: 'PMR-AB12',
    mode: 'personal',
  })
  assert.deepEqual(runTracking([], 'PMR-AB12'), {
    trackRef: 'PMR-AB12',
    mode: 'personal',
  })
})

test('runTracking: work run-start with trackRef yields the tracking ref and work mode', () => {
  const events = [runStart('work', 'DP-236')]
  assert.deepEqual(runTracking(events, 'PMR-AB12'), {
    trackRef: 'DP-236',
    mode: 'work',
  })
})

test('runTracking: mode is event.mode, so a work run-start without trackRef keeps fallbackRef', () => {
  // Real journals can carry this shape (work mode, no/invalid tracking ref
  // stamped). The group suffix is decided by mode, NOT by trackRef presence.
  const events = [runStart('work')]
  assert.deepEqual(runTracking(events, 'PMR-AB12'), {
    trackRef: 'PMR-AB12',
    mode: 'work',
  })
})

test('runTracking: a later run-start overwrites the earlier one (restart in work mode)', () => {
  const events = [
    runStart('personal', undefined, '2026-11-07T07:00:00.000Z'),
    runStart('work', 'DP-236', '2026-11-08T09:00:00.000Z'),
  ]
  assert.deepEqual(runTracking(events, 'PMR-AB12'), {
    trackRef: 'DP-236',
    mode: 'work',
  })
  // ...and the other direction: a personal restart drops the stale work ref.
  const back = [
    runStart('work', 'DP-236', '2026-11-07T07:00:00.000Z'),
    runStart('personal', undefined, '2026-11-08T09:00:00.000Z'),
  ]
  assert.deepEqual(runTracking(back, 'PMR-AB12'), {
    trackRef: 'PMR-AB12',
    mode: 'personal',
  })
})

test('runTracking: empty-string trackRef falls back to the aven ref (mode kept)', () => {
  const events = [runStart('work', '')]
  assert.deepEqual(runTracking(events, 'PMR-AB12'), {
    trackRef: 'PMR-AB12',
    mode: 'work',
  })
})
