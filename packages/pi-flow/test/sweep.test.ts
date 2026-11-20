import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type FlowRunEvent,
  projectRunState,
  readRunEvents,
  recordRunEvent,
  runStatePath,
} from '../run-state.ts'
import {
  isTerminalSweepOutcome,
  lastSweepOutcome,
  refsFromRunsDir,
  sweepCandidateInput,
} from '../worktree/sweep.ts'

function sweepEvent(overrides: {
  at: string
  ref?: string
  source?: 'flow-done' | 'sweep'
  outcome: 'removed' | 'noop' | 'kept-all' | 'deferred'
  detail?: string
}): FlowRunEvent {
  return {
    kind: 'worktree-sweep',
    at: overrides.at,
    ref: overrides.ref ?? 'PMR-1',
    source: overrides.source ?? 'sweep',
    outcome: overrides.outcome,
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
  }
}

function runStart(at: string, ref = 'PMR-1'): FlowRunEvent {
  return { kind: 'run-start', at, ref, mode: 'work' }
}

// --- isTerminalSweepOutcome ---

test('isTerminalSweepOutcome: removed and noop are terminal', () => {
  assert.equal(isTerminalSweepOutcome('removed'), true)
  assert.equal(isTerminalSweepOutcome('noop'), true)
})

test('isTerminalSweepOutcome: kept-all and deferred are not terminal', () => {
  assert.equal(isTerminalSweepOutcome('kept-all'), false)
  assert.equal(isTerminalSweepOutcome('deferred'), false)
})

// --- lastSweepOutcome ---

test('lastSweepOutcome: returns the latest worktree-sweep event', () => {
  const events = [
    runStart('t0'),
    sweepEvent({ at: 't1', outcome: 'deferred' }),
    sweepEvent({ at: 't2', source: 'flow-done', outcome: 'noop' }),
  ]
  assert.deepEqual(lastSweepOutcome(events), {
    outcome: 'noop',
    source: 'flow-done',
  })
})

test('lastSweepOutcome: null when there are no sweep events', () => {
  assert.equal(lastSweepOutcome([runStart('t0')]), null)
  assert.equal(lastSweepOutcome([]), null)
})

// --- refsFromRunsDir ---

test('refsFromRunsDir: strips suffixes, filters invalid, sorts, dedupes', () => {
  const names = [
    'PMR-ABC123.journal.jsonl',
    'PMR-ABC123.json',
    'DP-71.journal.jsonl',
    'evil/ref.journal.jsonl',
    '../traversal.journal.jsonl',
    'has space.journal.jsonl',
    '-leading-dash.journal.jsonl',
    'PMR-ABC123.journal.jsonl',
    '.hidden.journal.jsonl',
  ]
  assert.deepEqual(refsFromRunsDir(names), ['DP-71', 'PMR-ABC123'])
})

test('refsFromRunsDir: empty input yields empty list', () => {
  assert.deepEqual(refsFromRunsDir([]), [])
})

// --- sweepCandidateInput ---

test('sweepCandidateInput: returns the latest run-input mode and gitRoot', () => {
  const events: FlowRunEvent[] = [
    runStart('t0'),
    {
      kind: 'run-input',
      at: 't1',
      ref: 'PMR-1',
      input: {
        mode: 'work',
        gitRoot: '/repo',
        workRoots: ['/repo'],
      },
    },
    {
      kind: 'run-input',
      at: 't2',
      ref: 'PMR-1',
      input: {
        mode: 'personal',
        gitRoot: '/repo2',
        workRoots: [],
      },
    },
  ]
  assert.deepEqual(sweepCandidateInput(events), {
    mode: 'personal',
    gitRoot: '/repo2',
  })
})

test('sweepCandidateInput: null for journals without a run-input', () => {
  assert.equal(sweepCandidateInput([runStart('t0')]), null)
  assert.equal(sweepCandidateInput([]), null)
  assert.equal(sweepCandidateInput(null), null)
})

// --- journal round-trip: worktree-sweep survives append -> read -> projection ---

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

test('worktree-sweep journal round-trip survives append, read, projection', async () => {
  const files: MemFiles = new Map()
  const agentDir = '/agent'
  await recordRunEvent(agentDir, runStart('t0'), fakeIo(files))
  await recordRunEvent(
    agentDir,
    sweepEvent({
      at: 't1',
      source: 'flow-done',
      outcome: 'removed',
      detail: 'PMR-ABC123',
    }),
    fakeIo(files),
  )
  const events = await readRunEvents('/agent', 'PMR-1', fakeIo(files))
  assert.ok(events)
  const sweep = events.find((e) => e.kind === 'worktree-sweep')
  assert.ok(sweep)
  assert.equal(sweep.source, 'flow-done')
  assert.equal(sweep.outcome, 'removed')
  assert.equal(sweep.detail, 'PMR-ABC123')
  // Projection tolerates the sweep event without crashing.
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, 'PMR-1')
  assert.equal(state.updatedAt, 't1')
})

test('worktree-sweep round-trip: readRunEvents and projection keep it', async () => {
  const files: MemFiles = new Map()
  const ref = 'PMR-1'
  const statePath = runStatePath('/agent', ref)
  assert.ok(statePath)
  const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
  files.set(
    journalPath,
    [
      JSON.stringify(runStart('t0')),
      JSON.stringify(
        sweepEvent({ at: 't1', outcome: 'deferred', detail: 'labels' }),
      ),
      JSON.stringify(
        sweepEvent({ at: 't2', source: 'flow-done', outcome: 'noop' }),
      ),
    ]
      .join('\n')
      .concat('\n'),
  )
  const events = await readRunEvents('/agent', ref, fakeIo(files))
  assert.ok(events)
  const sweeps = events.filter((e) => e.kind === 'worktree-sweep')
  assert.equal(sweeps.length, 2)
  assert.deepEqual(lastSweepOutcome(events), {
    outcome: 'noop',
    source: 'flow-done',
  })
  // Projection tolerates the sweep events without crashing (PMR-Z2K7).
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, ref)
  assert.equal(state.updatedAt, 't2')
})
