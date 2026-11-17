import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyEvent,
  createReceiptJournal,
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
  })
  state = applyEvent(state, {
    kind: 'phase-start',
    at: '2026-10-21T01:01:00Z',
    ref: 'PMR-1',
    phase: 'plan',
  })
  assert.equal(state.currentPhase, 'plan')
  state = applyEvent(state, {
    kind: 'phase-complete',
    at: '2026-10-21T01:05:00Z',
    ref: 'PMR-1',
    phase: 'plan',
    label: 'planned',
  })
  assert.deepEqual(state.completedPhases, ['plan'])
  assert.equal(state.currentPhase, null)
})

test('applyEvent: phase-complete is idempotent', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
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

test('applyEvent: events for another ref are ignored', () => {
  let state = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
  })
  state = applyEvent(state, {
    kind: 'phase-start',
    at: 't1',
    ref: 'PMR-2',
    phase: 'plan',
  })
  assert.equal(state.currentPhase, null)
})

test('projectRunState: full run replays to done', () => {
  const events: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: 't0',
      ref: 'PMR-9',
      mode: 'personal',
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
    },
    fakeIo(files),
  )
  await recordRunEvent(
    agentDir,
    { kind: 'phase-start', at: 't1', ref: 'PMR-1', phase: 'plan' },
    fakeIo(files),
  )
  const journal = files.get('/agent/pi-flow/runs/PMR-1.journal.jsonl')
  assert.ok(journal)
  assert.equal(journal.split('\n').filter(Boolean).length, 2)
  const projection = JSON.parse(
    files.get('/agent/pi-flow/runs/PMR-1.json') ?? '{}',
  )
  assert.equal(projection.currentPhase, 'plan')
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

// --- PMR-6EEW gate integrity journal events ---

test('applyEvent: gate-target pins accumulate idempotently by targetId', () => {
  const run = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
  })
  const pin = {
    kind: 'gate-target' as const,
    at: 't1',
    ref: 'PMR-1',
    gate: 'deviation' as const,
    targetId: 'abc123def456',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffSha256: 'c'.repeat(64),
  }
  let state = applyEvent(run, pin)
  state = applyEvent(state, { ...pin, at: 't2' })
  const targets = state.gateTargets
  assert.equal(targets?.length, 1)
  assert.equal(targets?.[0]?.targetId, 'abc123def456')

  const decision = applyEvent(state, {
    kind: 'gate-decision',
    at: 't3',
    ref: 'PMR-1',
    gate: 'deviation',
    targetId: 'abc123def456',
    status: 'target-mismatch',
  })
  assert.equal(decision.gateDecisions?.length, 1)
})

test('isFlowRunState: states without gate arrays stay valid (pre-M7 journals)', () => {
  const legacy = {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'work',
    startedAt: 't0',
    updatedAt: 't0',
    completedPhases: [],
    currentPhase: null,
    notes: [],
  }
  assert.ok(isFlowRunState(legacy))
  assert.ok(!isFlowRunState({ ...legacy, gateTargets: 'nope' }))
  assert.ok(
    !isFlowRunState({
      ...legacy,
      gateDecisions: [
        { targetId: 7, gate: 'deviation', status: 'pass', at: 't1' },
      ],
    }),
  )
})

// --- command-receipt event kind (PMR-4S6V) ---

const receiptRun = {
  kind: 'run-start',
  at: 't0',
  ref: 'PMR-1',
  mode: 'work',
} as const

function receiptEvent(at: string, target: string, headSha?: string) {
  const event: {
    kind: 'command-receipt'
    at: string
    ref: string
    command: 'flow_land'
    target: string
    status: 'ok'
    headSha?: string
  } = {
    kind: 'command-receipt',
    at,
    ref: 'PMR-1',
    command: 'flow_land',
    target,
    status: 'ok',
  }
  if (headSha !== undefined) event.headSha = headSha
  return event
}

test('applyEvent: command-receipt appends to receipts', () => {
  let state = applyEvent(null, receiptRun)
  assert.equal(state.receipts, undefined)
  state = applyEvent(state, receiptEvent('t1', 'pr', 'sha1'))
  assert.equal(state.receipts?.length, 1)
  assert.deepEqual(state.receipts?.[0], {
    command: 'flow_land',
    target: 'pr',
    headSha: 'sha1',
    status: 'ok',
    at: 't1',
  })
})

test('applyEvent: command-receipt is idempotent by (command, target)', () => {
  let state = applyEvent(null, receiptRun)
  state = applyEvent(state, receiptEvent('t1', 'pr'))
  const same = applyEvent(state, receiptEvent('t2', 'pr'))
  assert.equal(same, state)
  const differentTarget = applyEvent(state, receiptEvent('t3', 'merge-main'))
  assert.equal(differentTarget.receipts?.length, 2)
})

test('recordRunEvent: duplicate receipt appends no second journal line', async () => {
  const files: MemFiles = new Map()
  await recordRunEvent('/agent', receiptRun, fakeIo(files))
  await recordRunEvent('/agent', receiptEvent('t1', 'pr'), fakeIo(files))
  await recordRunEvent('/agent', receiptEvent('t2', 'pr'), fakeIo(files))
  const journal = files.get('/agent/pi-flow/runs/PMR-1.journal.jsonl')
  assert.ok(journal)
  assert.equal(journal.split('\n').filter(Boolean).length, 2)
})

test('projectRunState: replays command-receipt journal into receipts', () => {
  const state = projectRunState([receiptRun, receiptEvent('t1', 'pr')])
  assert.equal(state?.receipts?.length, 1)
})

test('isFlowRunState: absent receipts stays valid, malformed receipts rejected', () => {
  const legacy = {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'work',
    startedAt: 't0',
    updatedAt: 't0',
    completedPhases: [],
    currentPhase: null,
    notes: [],
  }
  assert.ok(isFlowRunState(legacy))
  const good = [{ command: 'flow_land', target: 'pr', status: 'ok', at: 't1' }]
  assert.ok(isFlowRunState({ ...legacy, receipts: good }))
  assert.ok(
    !isFlowRunState({
      ...legacy,
      receipts: [{ ...good[0], command: 'flow_nope' }],
    }),
  )
  assert.ok(
    !isFlowRunState({
      ...legacy,
      receipts: [{ ...good[0], status: 'fail' }],
    }),
  )
  assert.ok(
    !isFlowRunState({
      ...legacy,
      receipts: [{ ...good[0], headSha: 42 }],
    }),
  )
})

// --- ReceiptJournal access layer (PMR-4S6V) ---

test('createReceiptJournal: record appends journal line and mutates projection', async () => {
  const files: MemFiles = new Map()
  const receipts = createReceiptJournal('/agent', fakeIo(files))
  await recordRunEvent('/agent', receiptRun, fakeIo(files))
  await receipts.record({ ref: 'PMR-1', command: 'flow_land', target: 'pr' })
  const journal = files.get('/agent/pi-flow/runs/PMR-1.journal.jsonl')
  assert.ok(journal)
  assert.ok(journal.includes('command-receipt'))
  const projection = JSON.parse(
    files.get('/agent/pi-flow/runs/PMR-1.json') ?? '{}',
  )
  assert.equal(projection.receipts?.length, 1)
})

test('createReceiptJournal: find returns stored receipt, null on missing journal', async () => {
  const files: MemFiles = new Map()
  const receipts = createReceiptJournal('/agent', fakeIo(files))
  assert.equal(
    await receipts.find({ ref: 'PMR-1', command: 'flow_land', target: 'pr' }),
    null,
  )
  await recordRunEvent('/agent', receiptRun, fakeIo(files))
  await recordRunEvent(
    '/agent',
    receiptEvent('t1', 'pr', 'sha1'),
    fakeIo(files),
  )
  const found = await receipts.find({
    ref: 'PMR-1',
    command: 'flow_land',
    target: 'pr',
  })
  assert.equal(found?.headSha, 'sha1')
  assert.equal(
    await receipts.find({
      ref: 'PMR-1',
      command: 'flow_land',
      target: 'merge-main',
    }),
    null,
  )
})

test('createReceiptJournal: find with headSha requires exact match', async () => {
  const files: MemFiles = new Map()
  await recordRunEvent('/agent', receiptRun, fakeIo(files))
  await recordRunEvent(
    '/agent',
    receiptEvent('t1', 'pr', 'sha1'),
    fakeIo(files),
  )
  const receipts = createReceiptJournal('/agent', fakeIo(files))
  assert.ok(
    await receipts.find({
      ref: 'PMR-1',
      command: 'flow_land',
      target: 'pr',
      headSha: 'sha1',
    }),
  )
  assert.equal(
    await receipts.find({
      ref: 'PMR-1',
      command: 'flow_land',
      target: 'pr',
      headSha: 'other',
    }),
    null,
  )
})

test('createReceiptJournal: find returns null on corrupt journal', async () => {
  const files: MemFiles = new Map()
  files.set('/agent/pi-flow/runs/PMR-1.journal.jsonl', '{not json\n')
  const receipts = createReceiptJournal('/agent', fakeIo(files))
  assert.equal(
    await receipts.find({ ref: 'PMR-1', command: 'flow_land', target: 'pr' }),
    null,
  )
})

test('createReceiptJournal: record swallows io failure', async () => {
  const boomIo = {
    readFile: async () => {
      throw new Error('boom')
    },
    appendFile: async () => {
      throw new Error('boom')
    },
    writeFile: async () => {
      throw new Error('boom')
    },
    mkdir: async () => {},
  }
  const receipts = createReceiptJournal('/agent', boomIo)
  await receipts.record({ ref: 'PMR-1', command: 'flow_land', target: 'pr' })
})

test('createReceiptJournal: find returns null when readFile rejects', async () => {
  const boomIo = {
    readFile: async () => {
      throw new Error('boom')
    },
    appendFile: async () => {
      throw new Error('boom')
    },
    writeFile: async () => {
      throw new Error('boom')
    },
    mkdir: async () => {},
  }
  const receipts = createReceiptJournal('/agent', boomIo)
  assert.equal(
    await receipts.find({ ref: 'PMR-1', command: 'flow_land', target: 'pr' }),
    null,
  )
})

// --- run-input / loop-state (durable-run-server) ---

const inputRun = {
  kind: 'run-start' as const,
  at: '2026-11-15T00:00:00Z',
  ref: 'PMR-INPUT',
  mode: 'work' as const,
}

const loopRun = {
  kind: 'run-start' as const,
  at: '2026-11-15T00:00:00Z',
  ref: 'PMR-LOOP',
  mode: 'personal' as const,
}

test('run-input: applyEvent sets the input snapshot (last-wins per ref)', () => {
  let state = applyEvent(null, inputRun)
  state = applyEvent(state, {
    kind: 'run-input',
    at: 't1',
    ref: 'PMR-INPUT',
    input: { mode: 'work', gitRoot: '/repo', workRoots: ['/a'] },
  })
  assert.deepEqual(state.input, {
    mode: 'work',
    gitRoot: '/repo',
    workRoots: ['/a'],
  })
  state = applyEvent(state, {
    kind: 'run-input',
    at: 't2',
    ref: 'PMR-INPUT',
    input: { mode: 'work', gitRoot: '/repo2', workRoots: ['/b', '/c'] },
  })
  assert.deepEqual(state.input, {
    mode: 'work',
    gitRoot: '/repo2',
    workRoots: ['/b', '/c'],
  })
  assert.equal(state.updatedAt, 't2')
})

test('run-input: mismatched ref is ignored', () => {
  let state = applyEvent(null, inputRun)
  const before = state
  state = applyEvent(state, {
    kind: 'run-input',
    at: 't1',
    ref: 'OTHER',
    input: { mode: 'work', gitRoot: '/repo', workRoots: [] },
  })
  assert.equal(state, before)
  assert.equal(before.input, undefined)
})

test('loop-state: applyEvent sets and overwrites the loop snapshot', () => {
  let state = applyEvent(null, loopRun)
  state = applyEvent(state, {
    kind: 'loop-state',
    at: 't1',
    ref: 'PMR-LOOP',
    loop: {
      phase: 'validate',
      awaitingOutcome: true,
      blockerRetries: 0,
      validateStartedAt: 't1',
      status: 'running',
    },
  })
  assert.deepEqual(state.loop, {
    phase: 'validate',
    awaitingOutcome: true,
    blockerRetries: 0,
    validateStartedAt: 't1',
    status: 'running',
  })
  state = applyEvent(state, {
    kind: 'loop-state',
    at: 't2',
    ref: 'PMR-LOOP',
    loop: {
      phase: 'feedback',
      awaitingOutcome: false,
      blockerRetries: 2,
      validateStartedAt: 't2',
      status: 'halted',
    },
  })
  assert.equal(state.loop?.status, 'halted')
  assert.equal(state.loop?.blockerRetries, 2)
  assert.equal(state.updatedAt, 't2')
})

test('loop-state: mismatched ref is ignored', () => {
  let state = applyEvent(null, loopRun)
  const before = state
  state = applyEvent(state, {
    kind: 'loop-state',
    at: 't1',
    ref: 'OTHER',
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: 't1',
      status: 'paused',
    },
  })
  assert.equal(state, before)
  assert.equal(before.loop, undefined)
})

test('run-input / loop-state: old journals without them still project', () => {
  const state = projectRunState([inputRun])
  assert.ok(state)
  assert.equal(state.input, undefined)
  assert.equal(state.loop, undefined)
  assert.equal(isFlowRunState(state), true)
})

test('isFlowRunState: validates input/loop only when present', () => {
  const baseState: Record<string, unknown> = {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'work',
    startedAt: 't0',
    updatedAt: 't1',
    completedPhases: [],
    currentPhase: null,
    notes: [],
  }
  const validInput = {
    ...baseState,
    input: { mode: 'work', gitRoot: '/repo', workRoots: ['/a'] },
  }
  assert.equal(isFlowRunState(validInput), true)
  const badInput = {
    ...validInput,
    input: { mode: 'sometimes', gitRoot: 5, workRoots: 'nope' },
  }
  assert.equal(isFlowRunState(badInput), false)

  const validLoop = {
    ...validInput,
    loop: {
      phase: 'implement',
      awaitingOutcome: false,
      blockerRetries: 1,
      validateStartedAt: 't1',
      status: 'paused',
    },
  }
  assert.equal(isFlowRunState(validLoop), true)
  const badLoopPhase = {
    ...validInput,
    loop: {
      phase: 'research',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: 't1',
      status: 'done',
    },
  }
  assert.equal(isFlowRunState(badLoopPhase), false)
  const badLoopStatus = {
    ...validInput,
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: 't1',
      status: 'exploded',
    },
  }
  assert.equal(isFlowRunState(badLoopStatus), false)
  const badLoopRetries = {
    ...validInput,
    loop: {
      phase: 'plan',
      awaitingOutcome: 'yes',
      blockerRetries: 'none',
      validateStartedAt: 't1',
      status: 'running',
    },
  }
  assert.equal(isFlowRunState(badLoopRetries), false)
})

test('attempt-record: applyEvent snapshots the attempt count (last-wins per ref)', () => {
  let state = applyEvent(null, loopRun)
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't1',
    ref: 'PMR-LOOP',
    tool: 'flow_run_attempt',
    outcome: 'retry',
    attempts: 1,
  })
  assert.equal(state.attempts, 1)
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't2',
    ref: 'PMR-LOOP',
    tool: 'flow_run_attempt',
    outcome: 'retry',
    attempts: 2,
  })
  assert.equal(state.attempts, 2)
  assert.equal(state.updatedAt, 't2')
})

test('attempt-record: outcome passed resets attempts to 0', () => {
  let state = applyEvent(null, loopRun)
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't1',
    ref: 'PMR-LOOP',
    tool: 'flow_run_attempt',
    outcome: 'retry',
    attempts: 3,
  })
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't2',
    ref: 'PMR-LOOP',
    tool: 'flow_run_attempt',
    outcome: 'escalate',
    attempts: 4,
  })
  assert.equal(state.attempts, 4)
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't3',
    ref: 'PMR-LOOP',
    tool: 'flow_run_attempt',
    outcome: 'passed',
    attempts: 0,
  })
  assert.equal(state.attempts, 0)
  assert.equal(state.updatedAt, 't3')
})

test('attempt-record: mismatched ref is ignored', () => {
  let state = applyEvent(null, loopRun)
  const before = state
  state = applyEvent(state, {
    kind: 'attempt-record',
    at: 't1',
    ref: 'OTHER',
    tool: 'flow_run_attempt',
    outcome: 'retry',
    attempts: 1,
  })
  assert.equal(state, before)
  assert.equal(before.attempts, undefined)
})

test('attempt-record: old journals without it still project', () => {
  const state = projectRunState([loopRun])
  assert.ok(state)
  assert.equal(state.attempts, undefined)
  assert.equal(isFlowRunState(state), true)
})

test('isFlowRunState: validates attempts only when present', () => {
  const baseState: Record<string, unknown> = {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'work',
    startedAt: 't0',
    updatedAt: 't1',
    completedPhases: [],
    currentPhase: null,
    notes: [],
  }
  assert.equal(isFlowRunState({ ...baseState, attempts: 2 }), true)
  assert.equal(isFlowRunState({ ...baseState, attempts: 0 }), true)
  assert.equal(isFlowRunState({ ...baseState, attempts: 'two' }), false)
})

test('isFlowRunState: validates gateAnswers only when present', () => {
  const baseState: Record<string, unknown> = {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'work',
    startedAt: 't0',
    updatedAt: 't1',
    completedPhases: [],
    currentPhase: null,
    notes: [],
  }
  const good = [{ gate: 'review', choice: 'approve', at: 't2' }]
  // PMR-MGHQ — absent gateAnswers stays valid (old journals).
  assert.equal(isFlowRunState(baseState), true)
  assert.equal(isFlowRunState({ ...baseState, gateAnswers: good }), true)
  assert.equal(isFlowRunState({ ...baseState, gateAnswers: 'nope' }), false)
  assert.equal(isFlowRunState({ ...baseState, gateAnswers: ['nope'] }), false)
  assert.equal(
    isFlowRunState({ ...baseState, gateAnswers: [{ ...good[0], gate: 'x' }] }),
    false,
  )
  assert.equal(
    isFlowRunState({
      ...baseState,
      gateAnswers: [{ ...good[0], choice: 'nonsense' }],
    }),
    false,
  )
  assert.equal(
    isFlowRunState({ ...baseState, gateAnswers: [{ ...good[0], at: 42 }] }),
    false,
  )
})

test('attempt-record: projection round-trips through projectRunState', () => {
  const events: FlowRunEvent[] = [
    loopRun,
    {
      kind: 'attempt-record',
      at: 't1',
      ref: 'PMR-LOOP',
      tool: 'flow_run_attempt',
      outcome: 'retry',
      attempts: 1,
    },
  ]
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.attempts, 1)
  assert.equal(isFlowRunState(state), true)
})

test('run-input / loop-state: projection round-trips through projectRunState', () => {
  const events: FlowRunEvent[] = [
    inputRun,
    {
      kind: 'run-input',
      at: 't1',
      ref: 'PMR-INPUT',
      input: { mode: 'work', gitRoot: '/repo', workRoots: ['/a'] },
    },
    {
      kind: 'loop-state',
      at: 't2',
      ref: 'PMR-INPUT',
      loop: {
        phase: 'implement',
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 't2',
        status: 'running',
      },
    },
  ]
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.input?.gitRoot, '/repo')
  assert.equal(state.loop?.phase, 'implement')
  assert.equal(isFlowRunState(state), true)
})
// --- gate-answer event kind (PMR-R5VB) ---

test('gate-answer: projection records the latest choice per gate', () => {
  const run = applyEvent(null, {
    kind: 'run-start',
    at: 't0',
    ref: 'PMR-1',
    mode: 'work',
  })
  let state = applyEvent(run, {
    kind: 'gate-answer',
    at: 't1',
    ref: 'PMR-1',
    gate: 'spec-review',
    choice: 'approve',
  })
  state = applyEvent(state, {
    kind: 'gate-answer',
    at: 't2',
    ref: 'PMR-1',
    gate: 'code-review',
    choice: 'fail',
  })
  const answers = state.gateAnswers
  assert.equal(answers?.length, 2)
  assert.deepEqual(
    answers?.find((a) => a.gate === 'spec-review'),
    { gate: 'spec-review', choice: 'approve', at: 't1' },
  )

  // A later answer for the same gate replaces the earlier one.
  state = applyEvent(state, {
    kind: 'gate-answer',
    at: 't3',
    ref: 'PMR-1',
    gate: 'spec-review',
    choice: 'reject',
  })
  assert.equal(state.gateAnswers?.length, 2)
  assert.deepEqual(
    state.gateAnswers?.find((a) => a.gate === 'spec-review'),
    { gate: 'spec-review', choice: 'reject', at: 't3' },
  )

  // Events for another ref are ignored.
  const other = applyEvent(state, {
    kind: 'gate-answer',
    at: 't4',
    ref: 'PMR-2',
    gate: 'spec-review',
    choice: 'pass',
  })
  assert.equal(other.gateAnswers?.length, 2)
})

test('gate-answer: rebuild over a journal mixing known and unknown kinds stays safe', () => {
  const events = [
    { kind: 'run-start', at: 't0', ref: 'PMR-1', mode: 'work' },
    { kind: 'some-future-event', at: 't1', ref: 'PMR-1' },
    {
      kind: 'gate-answer',
      at: 't2',
      ref: 'PMR-1',
      gate: 'spec-review',
      choice: 'approve',
    },
    { kind: 'note', at: 't3', ref: 'PMR-1', text: 'hello' },
    { kind: 'another-unknown', at: 't4', ref: 'PMR-1' },
  ] as unknown as FlowRunEvent[]
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, 'PMR-1')
  assert.deepEqual(state.gateAnswers, [
    { gate: 'spec-review', choice: 'approve', at: 't2' },
  ])
  assert.deepEqual(state.notes, [{ at: 't3', text: 'hello' }])
})
