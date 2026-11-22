import assert from 'node:assert/strict'
import { test } from 'node:test'
// AIDEV-NOTE: unit tests for the herdr flow-viewer pane script.
// AIDEV-NOTE: PMR-ZGPY / interview note 53KD9C7NMNK3FJGV — the lifecycle no
// longer includes 'research' (four phases: plan/implement/validate/feedback).
// Tests asserting a rendered research row were sanctioned for modification;
// the drift-tolerance case pins that research-era input still renders the
// four phases without crashing (ISC-12). The pane
// script must be importable without side effects (main-module guard), so the
// import below is itself the first test: if the top-level prelude ever runs
// again, this module fails to load and every test here errors out.
import {
  journalFileFor,
  mapKeypress,
  parseJournal,
  renderActivity,
  renderState,
  replayBodyText,
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
  assert.match(out, /\[x\] plan\s+\(planned\)/)
  assert.match(out, /\[ \] implement\s+\(active\) <- running/)
  assert.match(out, /\[ \] validate\s+\(review-passed\)/)
  assert.match(out, /\[ \] feedback\s+\(done\)/)
  assert.match(out, /notes:\n {2}- 2026-11-14T10:05:00Z hello/)
  assert.match(out, /updated: 2026-11-14T10:10:00Z/)
})

test('renderState: research-era input drift-tolerates to four phases (ISC-12)', () => {
  // AIDEV-NOTE: pre-PMR-Z2K7 run-state files may still carry research-era
  // fields; renderState must ignore them and render exactly the four phases.
  const out = renderState({
    ...sampleState,
    completedPhases: ['research', 'plan'],
    researchSkipNote: 'scouted externally',
  })
  const phaseLines = out.split('\n').filter((l) => /^\[[x ]\] /.test(l))
  assert.equal(phaseLines.length, 4)
  assert.doesNotMatch(out, /research/)
})

test('renderState: empty completed phases and no notes', () => {
  const out = renderState({ completedPhases: [], currentPhase: 'plan' })
  assert.match(out, /\[ \] plan[^\n]*<- running/)
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

// ── createDebouncedRender ──
// AIDEV-NOTE: the watcher wiring routes fs.watch events AND watchFile polls
// through one trailing-edge debounce; these tests pin the coalescing behavior
// with a tiny delay so no real 150ms sleeps are needed.
import { createDebouncedRender } from '../../../plugins/herdr/flow-viewer.mjs'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('createDebouncedRender: N rapid calls coalesce to exactly 1 render', async () => {
  let renders = 0
  const debounced = createDebouncedRender(() => {
    renders += 1
  }, 20)
  debounced()
  debounced()
  debounced()
  debounced()
  assert.equal(renders, 0)
  await wait(60)
  assert.equal(renders, 1)
})

test('createDebouncedRender: calls after the quiet period fire again', async () => {
  let renders = 0
  const debounced = createDebouncedRender(() => {
    renders += 1
  }, 20)
  debounced()
  await wait(60)
  assert.equal(renders, 1)
  debounced()
  await wait(60)
  assert.equal(renders, 2)
})

// ── journal append triggers a re-render (integration, PMR-V3SM) ──
// AIDEV-NOTE: end-to-end regression for the watcher path — spawn the real pane
// script as a child process, append one note event to the journal, and poll
// stdout for the note text. fs.watch only attaches when the journal EXISTS at
// pane start, so the journal file is created before spawning; the watchFile
// interval fallback also satisfying the assertion is acceptable (fs.watch is
// the latency win, the render is the contract). This doubles as the no-env
// fallback case since subtask 1.5 landed: PI_FLOW_JOURNAL_FILE is deliberately
// NOT passed, so the pane must derive the journal path via journalFileFor and
// still render activity.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PANE_SCRIPT = join(
  import.meta.dirname,
  '../../../plugins/herdr/flow-viewer.mjs',
)

test('journal append triggers a pane re-render containing the appended note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-viewer-it-'))
  const child = { kill: () => {} }
  try {
    const runFile = join(dir, 'PMR-V3SM.json')
    const journalFile = join(dir, 'PMR-V3SM.journal.jsonl')
    const startedAt = '2026-11-14T10:00:00Z'
    const state = {
      ref: 'PMR-V3SM',
      completedPhases: ['research'],
      currentPhase: 'implement',
      mode: 'exec',
      startedAt,
      notes: [],
      updatedAt: startedAt,
    }
    writeFileSync(runFile, JSON.stringify(state))
    // Journal must exist before spawn so fs.watch attaches.
    writeFileSync(
      journalFile,
      `${JSON.stringify({ kind: 'note', at: startedAt, ref: 'PMR-V3SM', text: 'initial note' })}\n`,
    )

    const pane = spawn(process.execPath, [PANE_SCRIPT], {
      env: {
        ...process.env,
        PI_FLOW_REF: 'PMR-V3SM',
        PI_FLOW_RUN_FILE: runFile,
        HERDR_PANE_ID: 'test-pane-flow-viewer-it',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.kill = () => {
      if (pane.exitCode === null && pane.signalCode === null) {
        pane.kill('SIGKILL')
      }
    }

    let stdout = ''
    pane.stdout.setEncoding('utf8')
    pane.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    // Initial render should contain the phase list header.
    await waitFor(
      () => stdout.includes('RPIV flow · PMR-V3SM'),
      'initial render',
    )

    // One append, unique marker.
    const marker = `journal-push-marker-${Math.random().toString(36).slice(2)}`
    appendFileSync(
      journalFile,
      `${JSON.stringify({ kind: 'note', at: new Date().toISOString(), ref: 'PMR-V3SM', text: marker })}\n`,
    )
    await waitFor(() => stdout.includes(marker), 're-render with appended note')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

async function waitFor(predicate, what) {
  // AIDEV-NOTE: PMR-KWQW — 30s wall-clock bound, not 5s: under full parallel
  // `bun run test` load the spawned pane's node startup + fs.watch attach +
  // first render occasionally exceeded 5s and flaked the suite (and a
  // flow_land gate run). The poll loop returns as soon as the predicate
  // holds, so the headroom costs nothing on a healthy machine — it only
  // lets a genuinely slow-but-working render finish.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ── replayProject (PMR-FEM1, subtask 5.1) ──
// AIDEV-NOTE: display-only duplicate of run-state.ts projection semantics —
// the pane is plain .mjs and cannot import the TS module. Only the subset
// renderState consumes is projected (ref/mode/startedAt/completedPhases/
// currentPhase/notes/updatedAt); research-era events are ignored (ISC-12).
import { replayProject } from '../../../plugins/herdr/flow-viewer.mjs'

const REF = 'PMR-FEM1'
const ev = (at, extra) => ({ ref: REF, at, ...extra })

// run-start → phase-start plan → phase-complete plan → phase-start implement
// → phase-complete implement → phase-start validate → phase-complete validate
// → phase-start feedback → phase-complete feedback → note
const happyJournal = [
  ev('2026-11-14T10:00:00Z', { kind: 'run-start', mode: 'exec' }),
  ev('2026-11-14T10:01:00Z', { kind: 'phase-start', phase: 'plan' }),
  ev('2026-11-14T10:02:00Z', { kind: 'phase-complete', phase: 'plan' }),
  ev('2026-11-14T10:03:00Z', { kind: 'phase-start', phase: 'implement' }),
  ev('2026-11-14T10:04:00Z', { kind: 'phase-complete', phase: 'implement' }),
  ev('2026-11-14T10:05:00Z', { kind: 'phase-start', phase: 'validate' }),
  ev('2026-11-14T10:06:00Z', { kind: 'phase-complete', phase: 'validate' }),
  ev('2026-11-14T10:07:00Z', { kind: 'phase-start', phase: 'feedback' }),
  ev('2026-11-14T10:08:00Z', { kind: 'phase-complete', phase: 'feedback' }),
  ev('2026-11-14T10:09:00Z', { kind: 'note', text: 'shipped' }),
]

test('replayProject: full happy journal → terminal state', () => {
  const state = replayProject(happyJournal)
  assert.deepEqual(state, {
    ref: REF,
    mode: 'exec',
    startedAt: '2026-11-14T10:00:00Z',
    updatedAt: '2026-11-14T10:09:00Z',
    completedPhases: ['plan', 'implement', 'validate', 'feedback'],
    currentPhase: null,
    notes: [{ at: '2026-11-14T10:09:00Z', text: 'shipped' }],
  })
  // The projected state must render through renderState unchanged (that is
  // the only contract the caller relies on).
  const out = renderState(state)
  assert.match(out, /\[x\] feedback\s+\(done\)/)
  assert.match(out, /notes:\n {2}- 2026-11-14T10:09:00Z shipped/)
  assert.match(out, /updated: 2026-11-14T10:09:00Z/)
})

test('replayProject: prefixes at each phase boundary → intermediate states', () => {
  const at2 = replayProject(happyJournal.slice(0, 2))
  assert.equal(at2.currentPhase, 'plan')
  assert.deepEqual(at2.completedPhases, [])
  assert.equal(at2.updatedAt, '2026-11-14T10:01:00Z')

  const at3 = replayProject(happyJournal.slice(0, 3))
  assert.equal(at3.currentPhase, null)
  assert.deepEqual(at3.completedPhases, ['plan'])

  const at4 = replayProject(happyJournal.slice(0, 4))
  assert.equal(at4.currentPhase, 'implement')
  assert.deepEqual(at4.completedPhases, ['plan'])

  const at6 = replayProject(happyJournal.slice(0, 6))
  assert.equal(at6.currentPhase, 'validate')
  assert.deepEqual(at6.completedPhases, ['plan', 'implement'])

  const at8 = replayProject(happyJournal.slice(0, 8))
  assert.equal(at8.currentPhase, 'feedback')
  assert.deepEqual(at8.completedPhases, ['plan', 'implement', 'validate'])
})

test('replayProject: ignores unknown kinds and research events (ISC-12)', () => {
  const state = replayProject([
    ev('2026-11-14T10:00:00Z', { kind: 'run-start', mode: 'exec' }),
    { kind: 'future-kind', at: '2026-11-14T10:00:30Z', ref: REF },
    ev('2026-11-14T10:01:00Z', { kind: 'phase-start', phase: 'research' }),
    ev('2026-11-14T10:02:00Z', { kind: 'phase-complete', phase: 'research' }),
    ev('2026-11-14T10:03:00Z', { kind: 'phase-start', phase: 'plan' }),
  ])
  assert.deepEqual(state.completedPhases, [])
  assert.equal(state.currentPhase, 'plan')
  assert.equal(state.updatedAt, '2026-11-14T10:03:00Z')
  const out = renderState(state)
  assert.doesNotMatch(out, /research/)
})

test('replayProject: empty events → null (caller renders fallback)', () => {
  assert.equal(replayProject([]), null)
  assert.equal(replayProject(), null)
})

test('replayProject: run-start without a following ref stays isolated', () => {
  // AIDEV-NOTE: mirrors applyEvent's ref guard — events for another ref must
  // not mutate this run's display state.
  const state = replayProject([
    ev('2026-11-14T10:00:00Z', { kind: 'run-start', mode: 'plan' }),
    {
      kind: 'phase-start',
      at: '2026-11-14T10:01:00Z',
      ref: 'OTHER',
      phase: 'plan',
    },
    { kind: 'note', at: '2026-11-14T10:02:00Z', ref: 'OTHER', text: 'foreign' },
  ])
  assert.equal(state.ref, REF)
  assert.deepEqual(state.completedPhases, [])
  assert.deepEqual(state.notes, [])
  assert.equal(state.updatedAt, '2026-11-14T10:00:00Z')
})

// ── PMR-ZGPY 5.2 replay mode: pure helpers ──
import {
  composePaneLabel,
  nextCursor,
  replayFooter,
  shouldEnableKeyloop,
} from '../../../plugins/herdr/flow-viewer.mjs'

test('composePaneLabel: live label byte-identical to today (ISC-8, ISC-10)', () => {
  assert.equal(composePaneLabel('PMR-X', 'live'), 'flow · PMR-X')
  assert.equal(composePaneLabel('PMR-X', undefined), 'flow · PMR-X')
  assert.equal(composePaneLabel('PMR-X', 'anything-else'), 'flow · PMR-X')
})

test('composePaneLabel: replay label carries the distinct suffix (herdr dedupe key)', () => {
  assert.equal(composePaneLabel('PMR-X', 'replay'), 'flow · PMR-X · replay')
})

test('nextCursor: left at 0 stays 0; right at N stays N (clamped)', () => {
  assert.equal(nextCursor(0, 5, 'left'), 0)
  assert.equal(nextCursor(5, 5, 'right'), 5)
  assert.equal(nextCursor(0, 5, 'right'), 1)
  assert.equal(nextCursor(5, 5, 'left'), 4)
})

test('nextCursor: h/l/g/G stepping', () => {
  assert.equal(nextCursor(2, 5, 'h'), 1)
  assert.equal(nextCursor(2, 5, 'l'), 3)
  assert.equal(nextCursor(3, 5, 'g'), 0)
  assert.equal(nextCursor(3, 5, 'G'), 5)
})

test('nextCursor: unknown key unchanged; N=0 clamps to 0', () => {
  assert.equal(nextCursor(2, 5, 'up'), 2)
  assert.equal(nextCursor(2, 5, undefined), 2)
  assert.equal(nextCursor(0, 0, 'right'), 0)
})

test('shouldEnableKeyloop: true only when stdin is a TTY', () => {
  assert.equal(shouldEnableKeyloop(true), true)
  assert.equal(shouldEnableKeyloop(false), false)
  assert.equal(shouldEnableKeyloop(undefined), false)
})

test('replayFooter: renders event k/N and key hints', () => {
  const footer = replayFooter(2, 5)
  assert.match(footer, /event 2\/5/)
  assert.match(footer, /←\/→/)
  assert.match(footer, /g\/G/)
})

// PMR-ZGPY fix round 2 (deviation 1): the footer renders at EVERY cursor
// position when the journal has events — k=0 included (ISC-9). The
// empty-state screen is reserved for a truly empty journal (N=0).
test('replayBodyText: footer renders at k=0 with events; absent only for empty journal', () => {
  const body0 = replayBodyText(happyJournal, 0, REF)
  assert.match(body0, /no events yet/)
  assert.match(body0, /event 0\/[0-9]+/)
  const bodyLast = replayBodyText(happyJournal, happyJournal.length, REF)
  assert.match(bodyLast, /event [0-9]+\/[0-9]+/)
  const empty = replayBodyText([], 0, REF)
  assert.match(empty, /no events yet/)
  assert.doesNotMatch(empty, /event /)
})

// PMR-ZGPY deviation round 3 (note 1WJYXZ1MXAPAREDC): Shift+G must reach the
// jump-to-latest action. Node readline maps a capital-G keystroke to
// {name:'g', shift:true} — the name-only wiring collapsed g/G into the same
// action. mapKeypress honors name + shift.
test('mapKeypress: shift+g maps to G (jump-to-latest); plain g to g (jump-to-first)', () => {
  assert.equal(mapKeypress({ name: 'g', shift: true }), 'G')
  assert.equal(mapKeypress({ name: 'g', shift: false }), 'g')
  assert.equal(mapKeypress({ name: 'g' }), 'g')
})
test('mapKeypress: arrows and h/l unaffected by shift; unknown → null', () => {
  assert.equal(mapKeypress({ name: 'left' }), 'left')
  assert.equal(mapKeypress({ name: 'right' }), 'right')
  assert.equal(mapKeypress({ name: 'h' }), 'h')
  assert.equal(mapKeypress({ name: 'l' }), 'l')
  assert.equal(mapKeypress({ name: 'l', shift: true }), 'l')
  assert.equal(mapKeypress({ name: 'x', shift: true }), null)
  assert.equal(mapKeypress(undefined), null)
  assert.equal(mapKeypress({}), null)
})
