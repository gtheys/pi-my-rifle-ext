import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyEvent,
  type FlowRunEvent,
  isFlowRunState,
  projectRunState,
  recordRunEvent,
  runFileName,
  runStatePath,
} from '../run-state.ts'

// --- runFileName / runStatePath ---

test('runFileName: valid refs', () => {
  assert.equal(runFileName('PMR-ABC123'), 'PMR-ABC123.json')
  assert.equal(runFileName('DP-71'), 'DP-71.json')
  assert.equal(runFileName('a.b_c-1'), 'a.b_c-1.json')
})

test('runFileName: rejects path traversal and junk', () => {
  assert.equal(runFileName('../etc/passwd'), null)
  assert.equal(runFileName('a/b'), null)
  assert.equal(runFileName(''), null)
  assert.equal(runFileName('-leading-dash'), null)
  assert.equal(runFileName('has space'), null)
  assert.equal(runFileName('x'.repeat(101)), null)
})

test('runStatePath: joins under runs dir', () => {
  assert.equal(
    runStatePath('/agent', 'PMR-1'),
    '/agent/pi-flow/runs/PMR-1.json',
  )
  assert.equal(runStatePath('/agent', 'bad/ref'), null)
})

// --- applyEvent / projectRunState ---

test('applyEvent: run-start creates state', () => {
  const state = applyEvent(null, {
    kind: 'run-start',
    at: '2026-10-21T01:00:00Z',
    ref: 'PMR-1',
    mode: 'personal',
    skipResearch: false,
  })
  assert.equal(state.ref, 'PMR-1')
  assert.deepEqual(state.completedPhases, [])
  assert.equal(state.currentPhase, null)
})

test('applyEvent: phase lifecycle start then complete', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: '2026-10-21T01:00:00Z',
    ref: 'PMR-1',
    mode: 'work',
    skipResearch: false,
  })
  state = applyEvent(state, {
    kind: 'phase-start',
    at: '2026-10-21T01:01:00Z',
    ref: 'PMR-1',
    phase: 'research',
  })
  assert.equal(state.currentPhase, 'research')
  state = applyEvent(state, {
    kind: 'phase-complete',
    at: '2026-10-21T01:05:00Z',
    ref: 'PMR-1',
    phase: 'research',
    label: 'researched',
  })
  assert.deepEqual(state.completedPhases, ['research'])
  assert.equal(state.currentPhase, null)
})

test('applyEvent: phase-complete is idempotent', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
    skipResearch: false,
  })
  const complete: FlowRunEvent = {
    kind: 'phase-complete',
    at: 't1',
    ref: 'PMR-1',
    phase: 'plan',
    label: 'planned',
  }
  state = applyEvent(state, complete)
  const again = applyEvent(state, { ...complete, at: 't2' })
  assert.deepEqual(again.completedPhases, ['plan'])
})

test('applyEvent: skipResearch does not suppress phase-complete', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
    skipResearch: true,
  })
  state = applyEvent(state, {
    kind: 'phase-complete',
    at: 't1',
    ref: 'PMR-1',
    phase: 'implement',
    label: 'active',
  })
  assert.deepEqual(state.completedPhases, ['implement'])
})

test('applyEvent: events for another ref are ignored', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
    skipResearch: false,
  })
  state = applyEvent(state, {
    kind: 'phase-start',
    at: 't1',
    ref: 'PMR-2',
    phase: 'plan',
  })
  assert.equal(state.currentPhase, null)
})

test('applyEvent: phase-skip records the reason', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
    skipResearch: true,
  })
  state = applyEvent(state, {
    kind: 'phase-skip',
    at: 't1',
    ref: 'PMR-1',
    reason: 'skip confirmed by user',
  })
  assert.equal(state.researchSkipNote, 'skip confirmed by user')
})

test('projectRunState: full run replays to done', () => {
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: 't0',
      ref: 'PMR-9',
      mode: 'personal',
      skipResearch: false,
    },
    { kind: 'phase-start', at: 't1', ref: 'PMR-9', phase: 'research' },
    {
      kind: 'phase-complete',
      at: 't2',
      ref: 'PMR-9',
      phase: 'research',
      label: 'researched',
    },
    { kind: 'phase-start', at: 't3', ref: 'PMR-9', phase: 'plan' },
    {
      kind: 'phase-complete',
      at: 't4',
      ref: 'PMR-9',
      phase: 'plan',
      label: 'planned',
    },
    { kind: 'phase-start', at: 't5', ref: 'PMR-9', phase: 'implement' },
    {
      kind: 'phase-complete',
      at: 't6',
      ref: 'PMR-9',
      phase: 'implement',
      label: 'active',
    },
    { kind: 'phase-start', at: 't7', ref: 'PMR-9', phase: 'validate' },
    {
      kind: 'phase-complete',
      at: 't8',
      ref: 'PMR-9',
      phase: 'validate',
      label: 'review-passed',
    },
    { kind: 'phase-start', at: 't9', ref: 'PMR-9', phase: 'feedback' },
    {
      kind: 'phase-complete',
      at: 't10',
      ref: 'PMR-9',
      phase: 'feedback',
      label: 'done',
    },
  ]
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, 'PMR-9')
  assert.deepEqual(state.completedPhases, [
    'research',
    'plan',
    'implement',
    'validate',
    'feedback',
  ])
  assert.equal(state.currentPhase, null)
})

// --- isFlowRunState ---

test('isFlowRunState: accepts a projected state, rejects junk', () => {
  const state = projectRunState([
    {
      kind: 'run-start',
      at: 't0',
      ref: 'PMR-1',
      mode: 'work',
      skipResearch: false,
    },
  ])
  assert.ok(state)
  assert.equal(isFlowRunState(state), true)
  assert.equal(isFlowRunState({ schema: 'wrong' }), false)
  assert.equal(isFlowRunState(null), false)
  assert.equal(isFlowRunState('string'), false)
})

// --- recordRunEvent (with fake io) ---

type MemFiles = Map<string, string>

function fakeIo(files: MemFiles) {
  return {
    readFile: async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    appendFile: async (p: string, data: string) => {
      files.set(p, (files.get(p) ?? '') + data)
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data)
    },
    mkdir: async () => {},
  }
}

test('recordRunEvent: appends journal lines and rewrites projection', async () => {
  const files: MemFiles = new Map()
  const agentDir = '/agent'
  await recordRunEvent(
    agentDir,
    {
      kind: 'run-start',
      at: 't0',
      ref: 'PMR-1',
      mode: 'work',
      skipResearch: false,
    },
    fakeIo(files),
  )
  await recordRunEvent(
    agentDir,
    { kind: 'phase-start', at: 't1', ref: 'PMR-1', phase: 'research' },
    fakeIo(files),
  )
  const journal = files.get('/agent/pi-flow/runs/PMR-1.journal.jsonl')
  assert.ok(journal)
  assert.equal(journal.split('\n').filter(Boolean).length, 2)
  const projection = JSON.parse(
    files.get('/agent/pi-flow/runs/PMR-1.json') ?? '{}',
  )
  assert.equal(projection.currentPhase, 'research')
})

test('recordRunEvent: rebuilds projection from journal when projection missing', async () => {
  const files: MemFiles = new Map()
  files.set(
    '/agent/pi-flow/runs/PMR-1.journal.jsonl',
    [
      JSON.stringify({
        kind: 'run-start',
        at: 't0',
        ref: 'PMR-1',
        mode: 'work',
        skipResearch: false,
      }),
      JSON.stringify({
        kind: 'phase-complete',
        at: 't1',
        ref: 'PMR-1',
        phase: 'plan',
        label: 'planned',
      }),
    ]
      .join('\n')
      .concat('\n'),
  )
  await recordRunEvent(
    '/agent',
    { kind: 'phase-start', at: 't2', ref: 'PMR-1', phase: 'implement' },
    fakeIo(files),
  )
  const projection = JSON.parse(
    files.get('/agent/pi-flow/runs/PMR-1.json') ?? '{}',
  )
  assert.deepEqual(projection.completedPhases, ['plan'])
  assert.equal(projection.currentPhase, 'implement')
})

test('recordRunEvent: invalid ref is a no-op, not a crash', async () => {
  const files: MemFiles = new Map()
  await recordRunEvent(
    '/agent',
    { kind: 'note', at: 't0', ref: '../evil', text: 'x' },
    fakeIo(files),
  )
  assert.equal(files.size, 0)
})
