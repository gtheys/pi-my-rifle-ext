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
  }
  const receipts = createReceiptJournal('/agent', boomIo)
  assert.equal(
    await receipts.find({ ref: 'PMR-1', command: 'flow_land', target: 'pr' }),
    null,
  )
})
