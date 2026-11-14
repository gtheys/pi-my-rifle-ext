import assert from 'node:assert/strict'
import { test } from 'node:test'
// AIDEV-NOTE: unit tests for the herdr flow-viewer pane script. The pane
// script must be importable without side effects (main-module guard), so the
// import below is itself the first test: if the top-level prelude ever runs
// again, this module fails to load and every test here errors out.
import { renderState } from '../../../plugins/herdr/flow-viewer.mjs'

const sampleState = {
  ref: 'PMR-TEST',
  completedPhases: ['research', 'plan'],
  currentPhase: 'implement',
  mode: 'exec',
  startedAt: '2026-11-14T10:00:00Z',
  notes: [{ at: '2026-11-14T10:05:00Z', text: 'hello' }],
  updatedAt: '2026-11-14T10:10:00Z',
}

test('importing flow-viewer.mjs executes nothing (no env exit, no stdout)', () => {
  // Reaching this test body at all proves the import had no fatal side
  // effects (the old top-level prelude called process.exit(1) on missing env).
  assert.equal(typeof renderState, 'function')
})

test('renderState: renders phases, mode, notes, updated timestamp', () => {
  const out = renderState(sampleState)
  const lines = out.split('\n')
  assert.equal(lines[0], 'RPIV flow · PMR-TEST')
  assert.match(out, /mode: exec/)
  assert.match(out, /\[x\] research\s+\(researched\)/)
  assert.match(out, /\[x\] plan\s+\(planned\)/)
  assert.match(out, /\[ \] implement\s+\(active\) <- running/)
  assert.match(out, /\[ \] validate\s+\(review-passed\)/)
  assert.match(out, /\[ \] feedback\s+\(done\)/)
  assert.match(out, /notes:\n {2}- 2026-11-14T10:05:00Z hello/)
  assert.match(out, /updated: 2026-11-14T10:10:00Z/)
})

test('renderState: empty completed phases and no notes', () => {
  const out = renderState({ completedPhases: [], currentPhase: 'research' })
  assert.match(out, /\[ \] research/)
  assert.doesNotMatch(out, /notes:/)
  assert.match(out, /updated: \?/)
})
