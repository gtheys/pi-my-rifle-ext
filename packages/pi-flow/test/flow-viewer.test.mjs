import assert from 'node:assert/strict'
import { test } from 'node:test'
// AIDEV-NOTE: unit tests for the herdr flow-viewer pane script. The pane
// script must be importable without side effects (main-module guard), so the
// import below is itself the first test: if the top-level prelude ever runs
// again, this module fails to load and every test here errors out.
import {
  journalFileFor,
  parseJournal,
  renderActivity,
  renderState,
} from '../../../plugins/herdr/flow-viewer.mjs'

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

// ── parseJournal ──
// AIDEV-NOTE: FlowRunEvent literals mirror packages/pi-flow/run-state.ts:33
// (field is `at`, not `ts`). Clock rendering is local-time, so expectations
// compute HH:MM the same way instead of assuming UTC.
const clockOf = (at) => {
  const d = new Date(at)
  return `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}]`
}
const noteEvent = {
  kind: 'note',
  at: '2026-11-14T10:01:00Z',
  ref: 'PMR-TEST',
  text: 'first note',
}
const phaseStartEvent = {
  kind: 'phase-start',
  at: '2026-11-14T10:02:00Z',
  ref: 'PMR-TEST',
  phase: 'implement',
}
const phaseCompleteEvent = {
  kind: 'phase-complete',
  at: '2026-11-14T10:03:00Z',
  ref: 'PMR-TEST',
  phase: 'research',
  label: 'scouted',
}

test('parseJournal: keeps valid events in order', () => {
  const raw = [
    JSON.stringify(phaseCompleteEvent),
    JSON.stringify(noteEvent),
    JSON.stringify(phaseStartEvent),
  ].join('\n')
  const events = parseJournal(raw)
  assert.deepEqual(
    events.map((e) => e.kind),
    ['phase-complete', 'note', 'phase-start'],
  )
})

test('parseJournal: skips torn/invalid JSON lines without throwing', () => {
  const raw = [
    JSON.stringify(noteEvent),
    '{"kind":"note","at":"2026-11-14T10:0', // torn tail
    'not json at all',
    '',
    JSON.stringify(phaseStartEvent),
  ].join('\n')
  const events = parseJournal(raw)
  assert.deepEqual(
    events.map((e) => e.kind),
    ['note', 'phase-start'],
  )
})

test('parseJournal: skips unknown kinds (forward-compat) and non-objects', () => {
  const raw = [
    JSON.stringify({ kind: 'future-kind', at: '2026-11-14T10:00:00Z' }),
    JSON.stringify({ noKind: true }),
    '"just a string"',
    JSON.stringify(noteEvent),
  ].join('\n')
  const events = parseJournal(raw)
  assert.deepEqual(
    events.map((e) => e.kind),
    ['note'],
  )
})

test('parseJournal: empty input returns empty array', () => {
  assert.deepEqual(parseJournal(''), [])
  assert.deepEqual(parseJournal('\n\n'), [])
})

// ── renderActivity ──

test('renderActivity: empty events yields empty string', () => {
  assert.equal(renderActivity([]), '')
})

test('renderActivity: renders last 8 events, oldest-first, bounded note text', () => {
  const events = []
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: 'note',
      at: `2026-11-14T10:${String(i).padStart(2, '0')}:00Z`,
      ref: 'PMR-TEST',
      text: `note ${i}`,
    })
  }
  const out = renderActivity(events)
  const lines = out.split('\n')
  // header + 8 event lines
  assert.equal(lines.length, 9)
  assert.match(out, /activity:/)
  assert.ok(lines[1].includes(`${clockOf('2026-11-14T10:04:00Z')} note note 4`))
  assert.ok(
    lines[8].includes(`${clockOf('2026-11-14T10:11:00Z')} note note 11`),
  )
  assert.doesNotMatch(out, /note 3/)
})

test('renderActivity: long note text truncated to ~60 chars', () => {
  const out = renderActivity([
    {
      kind: 'note',
      at: '2026-11-14T10:00:00Z',
      ref: 'PMR-TEST',
      text: 'x'.repeat(200),
    },
  ])
  const noteLine = out.split('\n').find((l) => l.includes('note'))
  // [HH:MM] + 'note ' prefix plus 60 chars of text
  assert.ok(noteLine.length <= 75)
  assert.equal((noteLine.match(/x/gu) ?? []).length, 60)
})

test('renderActivity: formats known kinds with their fields', () => {
  const out = renderActivity([
    phaseCompleteEvent,
    {
      kind: 'gate-decision',
      at: '2026-11-14T11:00:00Z',
      ref: 'PMR-TEST',
      gate: 'code-review',
      targetId: 't1',
      status: 'pass',
    },
    {
      kind: 'main-session',
      at: '2026-11-14T11:05:00Z',
      ref: 'PMR-TEST',
      sessionFile: '/tmp/s.jsonl',
    },
  ])
  assert.ok(
    out.includes(
      `${clockOf(phaseCompleteEvent.at)} phase-complete research (scouted)`,
    ),
  )
  assert.ok(
    out.includes(
      `${clockOf('2026-11-14T11:00:00Z')} gate-decision code-review pass`,
    ),
  )
  assert.ok(out.includes(`${clockOf('2026-11-14T11:05:00Z')} main-session`))
})

test('journalFileFor: derives sibling journal path or empty for non-json', () => {
  assert.equal(
    journalFileFor('/tmp/PMR-TEST.json'),
    '/tmp/PMR-TEST.journal.jsonl',
  )
  assert.equal(journalFileFor('/tmp/run-state'), '')
})
