// AIDEV-NOTE: PMR-ZV9Y 1.1 — v2 journal kinds in run-state.ts. Three new
// event kinds: 'state-change' (PROJECTED, last-wins into the optional
// FlowRunState.currentState) and 'step-start'/'step-stop' (journal-only
// evidence, like 'step-output'). This file is deliberately separate from
// run-state.test.ts so the v1 suites stay green unmodified (ISC-A-2) while
// the v2 contract is pinned here.
//
// The load-bearing invariant is the lenient-parse posture (see the applyEvent
// AIDEV-NOTE in run-state.ts): an out-of-vocabulary enum value is IGNORED by
// the projection but NEVER dropped from the journal — the journal is the
// evidence record and the phase-3 v2 window scans read it, not the projection.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { FlowReason, FlowState } from '../flow/vocabulary.ts'
import {
  applyEvent,
  type FlowRunEvent,
  type FlowRunState,
  isFlowRunState,
  isJournalOnlyEvent,
  projectRunState,
  recordRunEvent,
  runStatePath,
} from '../run-state.ts'

const AT = '2026-11-25T09:00:00.000Z'
const REF = 'PMR-V2'

function startEvent(): FlowRunEvent {
  return { kind: 'run-start', at: AT, ref: REF, mode: 'personal' }
}

function stateChange(
  state: FlowState,
  reason: FlowReason | '',
  at: string = AT,
): FlowRunEvent {
  return { kind: 'state-change', at, ref: REF, state, reason }
}

function stepEvent(kind: 'step-start' | 'step-stop', at = AT): FlowRunEvent {
  return { kind, at, ref: REF, phase: 'plan', step: 'plan.spec-approval' }
}

/** A fresh projection with a valid currentState for the guard tests. */
function v2State(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref: REF,
    mode: 'personal',
    startedAt: AT,
    updatedAt: AT,
    completedPhases: [],
    currentPhase: null,
    notes: [],
    currentState: {
      state: 'waiting_human',
      reason: 'spec_approval_pending',
      at: AT,
    },
    ...overrides,
  }
}

// --- projection ---

test("state-change projects into the optional 'currentState' field", () => {
  const state = applyEvent(
    applyEvent(null, startEvent()),
    stateChange('waiting_human', 'spec_approval_pending'),
  )
  assert.deepEqual(state.currentState, {
    state: 'waiting_human',
    reason: 'spec_approval_pending',
    at: AT,
  })
  assert.equal(state.updatedAt, AT)
  assert.ok(isFlowRunState(state))
})

test('state-change folds last-wins', () => {
  const state = projectRunState([
    startEvent(),
    stateChange('running', ''),
    stateChange(
      'waiting_human',
      'code_review_pending',
      '2026-11-25T09:01:00.000Z',
    ),
    stateChange('running', '', '2026-11-25T09:02:00.000Z'),
    stateChange('halted', 'label_miss', '2026-11-25T09:03:00.000Z'),
  ]) as FlowRunState
  assert.deepEqual(state.currentState, {
    state: 'halted',
    reason: 'label_miss',
    at: '2026-11-25T09:03:00.000Z',
  })
})

test("state-change with no reason projects reason ''", () => {
  const state = applyEvent(applyEvent(null, startEvent()), {
    kind: 'state-change',
    at: AT,
    ref: REF,
    state: 'done',
    reason: '',
  })
  assert.deepEqual(state.currentState, { state: 'done', reason: '', at: AT })
})

test('state-change with an OMITTED reason normalizes to empty', () => {
  // The plan spells the field `reason?`; the projection always materialises
  // '' so phase 3's label math never sees undefined.
  const state = applyEvent(applyEvent(null, startEvent()), {
    kind: 'state-change',
    at: AT,
    ref: REF,
    state: 'running',
  })
  assert.deepEqual(state.currentState, { state: 'running', reason: '', at: AT })
})

test('state-change needs a matching run (null state and other refs are no-ops)', () => {
  assert.equal(projectRunState([stateChange('running', '')]), null)
  const foreign: FlowRunEvent = {
    kind: 'state-change',
    at: AT,
    ref: 'PMR-OTHER',
    state: 'running',
    reason: '',
  }
  const state = applyEvent(applyEvent(null, startEvent()), foreign)
  assert.equal(state.currentState, undefined)
  assert.equal(state, applyEvent(state, foreign))
})

// --- the leniency invariant: ignored by projection, kept in the journal ---

test('out-of-vocabulary state values are ignored by the projection', () => {
  const before = applyEvent(
    applyEvent(null, startEvent()),
    stateChange('waiting_human', 'spec_approval_pending'),
  )
  const drift = applyEvent(before, {
    kind: 'state-change',
    at: '2026-11-25T10:00:00.000Z',
    ref: REF,
    state: 'paused' as string as FlowState,
    reason: '',
  })
  assert.equal(drift, before)
  assert.deepEqual(drift.currentState, {
    state: 'waiting_human',
    reason: 'spec_approval_pending',
    at: AT,
  })
})

test('out-of-vocabulary reasons are ignored by the projection', () => {
  const before = applyEvent(null, startEvent())
  const drift = applyEvent(before, {
    kind: 'state-change',
    at: AT,
    ref: REF,
    state: 'waiting_human',
    reason: 'answer_pending' as string as FlowReason,
  })
  assert.equal(drift, before)
  assert.equal(drift.currentState, undefined)
})

test('a malformed state-change (non-string at / reason) is ignored', () => {
  const before = applyEvent(null, startEvent())
  const badAt = applyEvent(before, {
    kind: 'state-change',
    at: 1234 as unknown as string,
    ref: REF,
    state: 'running',
    reason: '',
  })
  assert.equal(badAt, before)
  const badReason = applyEvent(before, {
    kind: 'state-change',
    at: AT,
    ref: REF,
    state: 'running',
    reason: null as unknown as '',
  })
  assert.equal(badReason, before)
})

// --- journal-only step boundary kinds ---

test('step-start/step-stop are journal-only; state-change is projected', () => {
  assert.equal(isJournalOnlyEvent(stepEvent('step-start')), true)
  assert.equal(isJournalOnlyEvent(stepEvent('step-stop')), true)
  assert.equal(isJournalOnlyEvent(stateChange('running', '')), false)
})

test('step events never touch the projection', () => {
  const before = applyEvent(null, startEvent())
  assert.equal(applyEvent(before, stepEvent('step-start')), before)
  assert.equal(applyEvent(before, stepEvent('step-stop')), before)
})

// --- the REAL writer: the journal never loses a v2 line ---

/** Read the journal lines of a run written through recordRunEvent. */
function journal(dir: string): Array<Record<string, unknown>> {
  const statePath = runStatePath(dir, REF)
  assert.ok(statePath !== null)
  const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
  return readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function projection(dir: string): string {
  const statePath = runStatePath(dir, REF)
  assert.ok(statePath !== null)
  return readFileSync(statePath, 'utf8')
}

test('recordRunEvent: a valid state-change reaches both journal and projection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-v2-'))
  try {
    await recordRunEvent(dir, startEvent())
    await recordRunEvent(
      dir,
      stateChange('waiting_human', 'spec_approval_pending'),
    )
    assert.deepEqual(
      journal(dir).map((e) => e.kind),
      ['run-start', 'state-change'],
    )
    const parsed: unknown = JSON.parse(projection(dir))
    assert.ok(isFlowRunState(parsed))
    assert.deepEqual(parsed.currentState, {
      state: 'waiting_human',
      reason: 'spec_approval_pending',
      at: AT,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordRunEvent: step-start/step-stop append without rewriting the projection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-v2-'))
  try {
    await recordRunEvent(dir, startEvent())
    await recordRunEvent(
      dir,
      stateChange('waiting_human', 'spec_approval_pending'),
    )
    const before = projection(dir)
    await recordRunEvent(dir, stepEvent('step-start'))
    await recordRunEvent(dir, stepEvent('step-stop'))
    assert.equal(projection(dir), before)
    assert.deepEqual(
      journal(dir).map((e) => e.kind),
      ['run-start', 'state-change', 'step-start', 'step-stop'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordRunEvent: an out-of-vocabulary state-change is journaled but does not change the projection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-v2-'))
  try {
    await recordRunEvent(dir, startEvent())
    await recordRunEvent(dir, stateChange('halted', 'label_miss'))
    const before = projection(dir)
    // A writer from a future vocabulary (or a hand-edited journal) must not
    // lose its evidence line, but must not poison the projection either.
    await recordRunEvent(dir, {
      kind: 'state-change',
      at: '2026-11-25T11:00:00.000Z',
      ref: REF,
      state: 'blocked' as string as FlowState,
      reason: '',
    })
    assert.equal(projection(dir), before)
    const events = journal(dir)
    assert.deepEqual(
      events.map((e) => e.kind),
      ['run-start', 'state-change', 'state-change'],
    )
    assert.equal(events[2].state, 'blocked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- guard: v2 states are valid, drifted ones are refused, old journals pass ---

test('isFlowRunState accepts a currentState and rejects drifted ones', () => {
  assert.ok(isFlowRunState(v2State()))
  assert.ok(
    !isFlowRunState(
      v2State({ currentState: { state: 'paused', reason: '', at: AT } }),
    ),
  )
  assert.ok(
    !isFlowRunState(
      v2State({
        currentState: { state: 'running', reason: 'answer_pending', at: AT },
      }),
    ),
  )
  assert.ok(
    !isFlowRunState(
      v2State({ currentState: { state: 'running', reason: null, at: AT } }),
    ),
  )
  assert.ok(
    !isFlowRunState(
      v2State({ currentState: { state: 'running', reason: '', at: 7 } }),
    ),
  )
  assert.ok(!isFlowRunState(v2State({ currentState: 'running' })))
  assert.ok(!isFlowRunState(v2State({ currentState: null })))
})

test('old journals (no v2 events, no currentState) are unchanged and still guard-valid', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-v2-'))
  try {
    await recordRunEvent(dir, startEvent())
    await recordRunEvent(dir, {
      kind: 'phase-start',
      at: AT,
      ref: REF,
      phase: 'plan',
    })
    await recordRunEvent(dir, {
      kind: 'note',
      at: AT,
      ref: REF,
      text: 'legacy run',
    })
    const parsed: unknown = JSON.parse(projection(dir))
    assert.ok(isFlowRunState(parsed))
    assert.equal('currentState' in parsed, false)
    assert.deepEqual(Object.keys(parsed).sort(), [
      'completedPhases',
      'currentPhase',
      'mode',
      'notes',
      'ref',
      'schema',
      'startedAt',
      'updatedAt',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replaying a v2 journal through projectRunState is idempotent', () => {
  const events = [
    startEvent(),
    stateChange('running', ''),
    stepEvent('step-start'),
    stateChange(
      'waiting_human',
      'spec_approval_pending',
      '2026-11-25T09:05:00.000Z',
    ),
    stepEvent('step-stop', '2026-11-25T09:06:00.000Z'),
  ]
  const once = projectRunState(events) as FlowRunState
  const twice = projectRunState([...events, ...events]) as FlowRunState
  assert.deepEqual(once.currentState, twice.currentState)
  assert.ok(isFlowRunState(once))
  assert.ok(isFlowRunState(twice))
})
