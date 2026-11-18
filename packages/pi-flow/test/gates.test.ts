import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePlanReviewRefs } from '../aven/client.ts'
import {
  collectOpenGates,
  deriveRunGates,
  type GateDeps,
  type GateIo,
  readRunsFromDisk,
} from '../flow/gates.ts'
import type {
  CommandReceiptRecord,
  FlowRunState,
  GateTargetRecord,
  LoopStateRecord,
} from '../run-state.ts'

// Hand-built FlowRunState literals mirroring the projection shapes in
// run-state.ts (schema 'gtheys.pi-flow.run.v1').

function baseState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-1',
    mode: 'personal',
    startedAt: '2026-11-17T10:00:00Z',
    updatedAt: '2026-11-17T11:00:00Z',
    completedPhases: ['plan', 'implement'],
    currentPhase: null,
    notes: [],
    ...overrides,
  }
}

function loopState(status: LoopStateRecord['status']): LoopStateRecord {
  return {
    phase: 'validate',
    awaitingOutcome: false,
    blockerRetries: 0,
    validateStartedAt: '2026-11-17T10:30:00Z',
    status,
  }
}

function receipt(
  command: CommandReceiptRecord['command'],
  target: string,
): CommandReceiptRecord {
  return { command, target, status: 'ok', at: '2026-11-17T10:40:00Z' }
}

function gateTarget(
  targetId: string,
  gate: GateTargetRecord['gate'],
): GateTargetRecord {
  return {
    targetId,
    gate,
    baseSha: 'aaa111',
    headSha: 'bbb222',
    diffSha256: 'deadbeef',
    at: '2026-11-17T10:45:00Z',
  }
}

// --- paused runs ---

test('paused run yields a flow-paused gate', () => {
  const state = baseState({ loop: loopState('paused') })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].kind, 'flow-paused')
  assert.equal(gates[0].answerCommand, undefined)
  assert.match(gates[0].title, /^PMR-1/)
  assert.equal(gates[0].title.includes('\n'), false)
})

test('running/halted/done loop yields no paused gate', () => {
  const gates = deriveRunGates([
    baseState({ loop: loopState('running') }),
    baseState({ loop: loopState('halted') }),
    baseState({ loop: loopState('done') }),
  ])
  assert.deepEqual(
    gates.filter((g) => g.kind === 'flow-paused'),
    [],
  )
})

// --- code-review gate (validate phase + missing code_review receipt) ---

test('validate phase without code_review receipt yields a code-review gate', () => {
  const state = baseState({ currentPhase: 'validate' })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'code-review')
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].answerCommand, undefined)
})

test('validate phase WITH code_review receipt yields no gate', () => {
  const state = baseState({
    currentPhase: 'validate',
    receipts: [receipt('code_review', 'PMR-1')],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('non-validate phase yields no code-review gate', () => {
  const state = baseState({ currentPhase: 'implement' })
  assert.deepEqual(deriveRunGates([state]), [])
})

// --- answer gates (open vs answered, both record mechanisms) ---

test('open gate target (no decisions, no answers) yields an answer-gate with answerCommand', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [],
    gateAnswers: [],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'answer-gate')
  assert.equal(gates[0].ref, 'PMR-1')
  assert.equal(gates[0].answerCommand, '/flow answer PMR-1')
  assert.match(gates[0].title, /^PMR-1/)
  assert.equal(gates[0].title.includes('\n'), false)
})

test('gate target answered via gateDecisions targetId yields no gate', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'spec-review',
        status: 'pass',
        at: '2026-11-17T10:50:00Z',
      },
    ],
    gateAnswers: [],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('gate target answered via gateAnswers kind (fallback) yields no gate', () => {
  const state = baseState({
    gateTargets: [gateTarget('t1', 'code-review')],
    gateDecisions: [],
    gateAnswers: [
      {
        gate: 'code-review',
        choice: 'approve',
        at: '2026-11-17T10:50:00Z',
      },
    ],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('gate target open when decision is absent even though another target was decided', () => {
  // Fix round 2: real decisions carry gate 'deviation' (tools/deviation.ts is
  // the only decision writer); 'review' pins are excluded from derivation.
  const state = baseState({
    gateTargets: [gateTarget('t1', 'deviation'), gateTarget('t2', 'deviation')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'deviation',
        status: 'stale',
        at: '2026-11-17T10:50:00Z',
      },
    ],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'answer-gate')
})

test('answered gate does NOT reopen via either mechanism (conservative OR, D6)', () => {
  // decision exists for the target AND an answer exists for the gate kind —
  // either record alone closes the gate.
  const state = baseState({
    gateTargets: [gateTarget('t1', 'spec-review')],
    gateDecisions: [
      {
        targetId: 't1',
        gate: 'spec-review',
        status: 'pass',
        at: '2026-11-17T10:50:00Z',
      },
    ],
    gateAnswers: [
      {
        gate: 'spec-review',
        choice: 'approve',
        at: '2026-11-17T10:55:00Z',
      },
    ],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

// --- PMR-ZGPY fix round 2 — real-writer semantics for 'review' pins ---
// Real writers: gate-target 'review' pins are journalled by /review
// (review/review.ts); gate-decisions exist ONLY for 'deviation' targets
// (tools/deviation.ts); gate-answers only carry 'spec-review' | 'code-review'
// (flow/answer.ts GATE_JOURNAL). A 'review' pin therefore has NO closer and
// must never derive an answer-gate — it is covered by the phase-derived
// code-review gate rule instead.

test('review pin during validate derives exactly ONE code-review gate, no answer-gate', () => {
  const state = baseState({
    currentPhase: 'validate',
    gateTargets: [gateTarget('t1', 'review')],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'code-review')
  assert.equal(gates[0].ref, 'PMR-1')
})

test('review pin after validate completed derives NO gates', () => {
  const state = baseState({
    completedPhases: ['plan', 'implement', 'validate'],
    currentPhase: 'feedback',
    gateTargets: [gateTarget('t1', 'review')],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('review pin with a REAL code-review gate-answer stays closed', () => {
  const state = baseState({
    currentPhase: 'validate',
    gateTargets: [gateTarget('t1', 'review')],
    gateAnswers: [
      { gate: 'code-review', choice: 'pass', at: '2026-11-17T10:50:00Z' },
    ],
  })
  assert.deepEqual(deriveRunGates([state]), [])
})

test('a state emitting the code-review gate emits no answer-gates (suppression)', () => {
  const state = baseState({
    currentPhase: 'validate',
    gateTargets: [
      gateTarget('t1', 'spec-review'),
      gateTarget('t2', 'deviation'),
    ],
  })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'code-review')
})

// --- research-era / old projections without optional fields ---

test('projection without optional fields derives no gates and does not crash', () => {
  // bare run-start projection: no loop, receipts, gateTargets, gateAnswers
  const state = baseState()
  assert.deepEqual(deriveRunGates([state]), [])
})

test('paused loop alongside missing gate fields still derives only the paused gate', () => {
  const state = baseState({ loop: loopState('paused') })
  const gates = deriveRunGates([state])
  assert.equal(gates.length, 1)
  assert.equal(gates[0].kind, 'flow-paused')
})

// --- ordering across multiple states ---

test('multiple states produce gates in input order', () => {
  const states = [
    baseState({ ref: 'PMR-A', loop: loopState('paused') }),
    baseState({ ref: 'PMR-B', currentPhase: 'validate' }),
    baseState({
      ref: 'PMR-C',
      gateTargets: [gateTarget('t1', 'spec-review')],
    }),
  ]
  const gates = deriveRunGates(states)
  assert.deepEqual(
    gates.map((g) => g.ref),
    ['PMR-A', 'PMR-B', 'PMR-C'],
  )
  assert.deepEqual(
    gates.map((g) => g.kind),
    ['flow-paused', 'code-review', 'answer-gate'],
  )
})

test('empty input yields no gates', () => {
  assert.deepEqual(deriveRunGates([]), [])
})

// --- collectOpenGates (PMR-ZGPY 2.2) — fake deps, no fs/aven ---

function fakeDeps(
  runs: FlowRunState[] | Error,
  reviewRefs: string[] | Error,
  // PMR-384R: open-ref universe from aven. Default null = aven truth
  // unavailable = no suppression, so pre-PMR-384R tests keep their exact
  // old behavior.
  openRefs: string[] | Error | null = null,
): GateDeps {
  const readRuns = (): Promise<FlowRunState[]> =>
    runs instanceof Error ? Promise.reject(runs) : Promise.resolve(runs)
  const listPlansAtReview = (): Promise<string[]> =>
    reviewRefs instanceof Error
      ? Promise.reject(reviewRefs)
      : Promise.resolve(reviewRefs)
  const listOpenRefs = (): Promise<string[] | null> =>
    openRefs instanceof Error
      ? Promise.reject(openRefs)
      : Promise.resolve(openRefs)
  return { readRuns, listPlansAtReview, listOpenRefs }
}

test('collectOpenGates happy merge: paused run + different review ref -> both gates', async () => {
  const deps = fakeDeps(
    [baseState({ ref: 'PMR-1', loop: loopState('paused') })],
    ['PMR-2'],
  )
  const gates = await collectOpenGates(deps)
  assert.equal(gates.length, 2)
  assert.deepEqual(
    gates.map((g) => [g.ref, g.kind]),
    [
      ['PMR-1', 'flow-paused'],
      ['PMR-2', 'plan-review'],
    ],
  )
  const planReview = gates[1]
  assert.equal(planReview?.title, 'PMR-2 · plan awaiting approval')
  assert.equal(planReview?.answerCommand, '/flow answer PMR-2')
})

test('collectOpenGates dedupe: paused run with same ref in review list -> exactly one gate', async () => {
  const deps = fakeDeps(
    [baseState({ ref: 'PMR-1', loop: loopState('paused') })],
    ['PMR-1'],
  )
  const gates = await collectOpenGates(deps)
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.kind, 'flow-paused')
  assert.match(gates[0]?.title ?? '', /paused/)
})

test('collectOpenGates aven failure -> runs-only gates', async () => {
  const deps = fakeDeps(
    [baseState({ ref: 'PMR-1', loop: loopState('paused') })],
    new Error('aven down'),
  )
  const gates = await collectOpenGates(deps)
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.ref, 'PMR-1')
  assert.equal(gates[0]?.kind, 'flow-paused')
})

test('collectOpenGates runs failure -> plans-only gates', async () => {
  const deps = fakeDeps(new Error('disk boom'), ['PMR-2'])
  const gates = await collectOpenGates(deps)
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.kind, 'plan-review')
  assert.equal(gates[0]?.ref, 'PMR-2')
})

test('collectOpenGates both sources empty/failing -> []', async () => {
  const empty = await collectOpenGates(fakeDeps([], []))
  assert.deepEqual(empty, [])
  const failing = await collectOpenGates(
    fakeDeps(new Error('a'), new Error('b')),
  )
  assert.deepEqual(failing, [])
})

// --- PMR-384R — aven-status truth: suppress stale/false-open gates ---
// The 2026-11-18 live report: seven refs showed "validate phase awaiting
// code review" while six were done/canceled in aven and one had no aven
// record at all. Journals are immutable history — aven ticket status is the
// truth (user invariant), so collectOpenGates must suppress gates whose ref
// is terminal or ungrounded in aven. Fail-closed per ISC-13: aven
// unavailability suppresses nothing (a false-open gate is noise; a
// false-suppressed gate hides live work).

test('suppresses gates for refs whose aven status is terminal (done/canceled)', async () => {
  // Symptom refs: PMR-084C/5D1B/G68P/MR36/Z0M2 = done; TP-85GY = canceled
  // (other project). None appear in the --open universe.
  const deps = fakeDeps(
    [
      baseState({ ref: 'PMR-084C', currentPhase: 'validate' }),
      baseState({ ref: 'PMR-5D1B', currentPhase: 'validate' }),
      baseState({ ref: 'TP-85GY', loop: loopState('paused') }),
    ],
    [],
    [],
  )
  assert.deepEqual(await collectOpenGates(deps), [])
})

test('suppresses gates for refs with no aven record at all', async () => {
  // AA-QJZ3: ungrounded projection — an unanswerable gate must not render.
  // GONE-99 rides along to prove the plan-review source is filtered too.
  const deps = fakeDeps(
    [baseState({ ref: 'AA-QJZ3', currentPhase: 'validate' })],
    ['GONE-99'],
    ['PMR-384R'],
  )
  assert.deepEqual(await collectOpenGates(deps), [])
})

test('keeps gates for refs with a live (nonterminal) aven ticket', async () => {
  const deps = fakeDeps(
    [
      baseState({ ref: 'PMR-384R', currentPhase: 'validate' }),
      baseState({ ref: 'PMR-YQPW', loop: loopState('paused') }),
    ],
    ['PMR-N0W6'],
    ['PMR-384R', 'PMR-YQPW', 'PMR-N0W6'],
  )
  const gates = await collectOpenGates(deps)
  assert.deepEqual(
    gates.map((g) => [g.ref, g.kind]),
    [
      ['PMR-384R', 'code-review'],
      ['PMR-YQPW', 'flow-paused'],
      ['PMR-N0W6', 'plan-review'],
    ],
  )
})

test('aven truth unavailable (null) suppresses nothing (ISC-13 fail-closed)', async () => {
  const deps = fakeDeps(
    [baseState({ ref: 'PMR-084C', currentPhase: 'validate' })],
    [],
    new Error('aven down'),
  )
  const gates = await collectOpenGates(deps)
  assert.equal(gates.length, 1)
  assert.equal(gates[0]?.ref, 'PMR-084C')
  assert.equal(gates[0]?.kind, 'code-review')
})

test('empty universe (zero open tickets) suppresses every gate', async () => {
  // [] is a REAL aven answer ("nothing is open"), unlike null — it must
  // suppress. This pins the null-vs-[] distinction.
  const deps = fakeDeps(
    [baseState({ ref: 'PMR-084C', currentPhase: 'validate' })],
    [],
    [],
  )
  assert.deepEqual(await collectOpenGates(deps), [])
})

test('case-variant journal/review refs still match the universe (fix round)', async () => {
  // Fix-round blocker 2: aven resolves refs case-insensitively (a case
  // variant is the same ticket — ticketSnapshotFor/showFullGuarded) while
  // journal refs keep user-typed casing (parseRefKind journals the raw
  // input). '/flow pmr-084c' + universe 'PMR-084C' must KEEP the live
  // gate, not silently suppress it.
  const deps = fakeDeps(
    [baseState({ ref: 'pmr-084c', currentPhase: 'validate' })],
    ['PMR-N0W6'],
    ['PMR-084C', 'pmr-n0w6'],
  )
  const gates = await collectOpenGates(deps)
  assert.deepEqual(
    gates.map((g) => [g.ref, g.kind]),
    [
      ['pmr-084c', 'code-review'],
      ['PMR-N0W6', 'plan-review'],
    ],
  )
})

// --- readRunsFromDisk (fake io) ---

function fakeIo(
  entries: string[],
  files: Map<string, string>,
  readdirError?: Error,
): GateIo {
  return {
    readdir: async (_dir: string) => {
      if (readdirError) throw readdirError
      return entries
    },
    readFile: async (path: string) => {
      const body = files.get(path)
      if (body === undefined) throw new Error(`missing: ${path}`)
      return body
    },
  }
}

test('readRunsFromDisk keeps valid run files and skips corrupt/missing ones', async () => {
  const good = baseState({ ref: 'PMR-1' })
  // The dir prefix must match between readdir and readFile, so both sides are
  // built around the real runsDir layout instead of the string fakeIo helper.
  const runs = await readRunsFromDisk('<agent>', {
    readdir: async (dir) => {
      assert.equal(dir.includes('pi-flow'), true)
      return ['PMR-1.json', 'broken.json', 'not-a-run.json', 'notes.txt']
    },
    readFile: async (path) => {
      if (path.endsWith('PMR-1.json')) return JSON.stringify(good)
      if (path.endsWith('broken.json')) return '{not json'
      if (path.endsWith('not-a-run.json')) return JSON.stringify({ hello: 1 })
      throw new Error(`unexpected read: ${path}`)
    },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.ref, 'PMR-1')
})

test('readRunsFromDisk missing runs dir -> []', async () => {
  const runs = await readRunsFromDisk(
    '<agent>',
    fakeIo([], new Map(), new Error('ENOENT')),
  )
  assert.deepEqual(runs, [])
})

// --- parsePlanReviewRefs (pure, PMR-ZGPY 2.2) ---

test('parsePlanReviewRefs extracts string refs from aven list JSON', () => {
  const stdout = JSON.stringify([
    { ref: 'PMR-2', title: 'x' },
    { ref: 'dp-9' },
    { title: 'no ref' },
    'not-an-object',
  ])
  assert.deepEqual(parsePlanReviewRefs(stdout), ['PMR-2', 'dp-9'])
})

test('parsePlanReviewRefs fail-closed on bad JSON or non-array', () => {
  assert.deepEqual(parsePlanReviewRefs('oops'), [])
  assert.deepEqual(parsePlanReviewRefs(JSON.stringify({ a: 1 })), [])
})
