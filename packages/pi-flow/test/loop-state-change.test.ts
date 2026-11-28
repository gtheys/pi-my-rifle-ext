// AIDEV-NOTE: PMR-ZV9Y 2.1 — loop v2 state-machine emission tests. The loop
// emits `state-change`/`step-start`/`step-stop` through the OPTIONAL
// `deps.journalV2` seam (wired in index.ts to the SAME journal() writer as
// `deps.journal`). These tests follow the loop.test.ts deps-mock pattern but
// capture v2 events in their own `v2` array, so the existing loop.test.ts
// `h.events` kind-sequence assertions stay byte-identical (ISC-A-2: the
// v1 loop-state/journal stream is untouched).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFlowLoop,
  type FlowLoop,
  type FlowLoopDeps,
  resumeV2StateFromEvents,
} from '../flow/loop.ts'
import { deriveV2State, renderStateMetricLines } from '../flow/state-metrics.ts'
import { type FlowRunEvent, projectRunState } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import {
  createEventFanoutWriter,
  type FanoutHandlers,
} from '../telemetry/dispatch.ts'

interface Harness {
  deps: FlowLoopDeps
  sent: string[]
  notes: { ref: string; text: string }[]
  /** v1 journal stream — must stay exactly as loop.test.ts expects. */
  events: FlowRunEvent[]
  /** v2 emission stream (state-change / step-start / step-stop). */
  v2: FlowRunEvent[]
  notifications: { message: string; level: string }[]
  labels: string[] | null
  planState: string | null
  inFlight?: boolean
  /**
   * The `hasPendingSubagentAsk` dep (worker-ask-wait fix): true = an in-flight
   * child of this parent is blocked on an ask_owner question. Default false, so
   * every pre-existing in-flight test keeps asserting the machine wait; the
   * ABSENT-dep case is covered by deleting the key in its own test.
   */
  pendingAsk?: boolean
  /** when true, the journalV2 seam throws on every call. */
  v2Throws?: boolean
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    notes: [],
    events: [],
    v2: [],
    notifications: [],
    labels,
    planState: null,
    deps: undefined as unknown as FlowLoopDeps,
  }
  h.deps = {
    notify: (message, level) => {
      h.notifications.push({ message, level })
    },
    journal: (event) => {
      h.events.push(event)
    },
    journalV2: (event) => {
      if (h.v2Throws) throw new Error('v2 journal exploded')
      h.v2.push(event)
    },
    readLabels: async () => h.labels,
    readPlanState: async () => h.planState,
    avenNote: async (ref, text) => {
      h.notes.push({ ref, text })
      return true
    },
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => h.inFlight ?? false,
    hasPendingSubagentAsk: () => h.pendingAsk ?? false,
    // AIDEV-NOTE: PMR-B033 — default-successful gate-reset dep so the
    // existing blocker tests keep their happy-path v2 sequence; the
    // failed-reset pin below overrides it.
    removeAvenLabel: async (_ref, label) => {
      h.labels = (h.labels ?? []).filter((l) => l !== label)
      return true
    },
    sendPrompt: (prompt) => {
      h.sent.push(prompt)
    },
  }
  return h
}

const PROMPT_INPUT = {
  mode: 'personal' as const,
  ref: 'TP-1',
  gitRoot: '/home/x/repo',
  workRoots: [] as string[],
}

function startInput() {
  return {
    ref: 'TP-1',
    phase: 'plan' as const,
    promptInput: { ...PROMPT_INPUT },
  }
}

// AIDEV-NOTE: compact view of the v2 stream for readable assertions. State
// changes carry {state, reason}; step events carry {step, phase}.
function v2View(h: Harness) {
  return h.v2.map((e) => {
    if (e.kind === 'state-change')
      return { kind: e.kind, state: e.state, reason: e.reason }
    if (e.kind === 'step-start' || e.kind === 'step-stop') {
      return { kind: e.kind, phase: e.phase, step: e.step }
    }
    return { kind: e.kind }
  })
}

test('start: emits state-change{running} once (prompt-send running is guarded)', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  // The v1 loop-state stream is UNCHANGED — loop.test.ts green (ISC-A-2).
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ['loop-state', 'phase-start', 'owner-session', 'loop-state'],
  )
})

test('aven-read halt: emits state-change{halted, aven_read_failed}', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = null
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'aven_read_failed' },
  ])
})

test('label-miss halt: emits state-change{halted, label_miss}', async () => {
  const h = makeHarness([]) // plan, no label, not review -> label_miss halt
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('blocker-budget halt: emits state-change{halted, blocker_budget_exhausted}', async () => {
  const h = makeHarness(['planned', 'active']) // validate label "review-passed" missing
  h.deps.hasFreshBlockers = async () => true
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'validate',
    promptInput: { ...PROMPT_INPUT },
    resume: { blockerRetries: 2, validateStartedAt: new Date().toISOString() },
  })
  await loop.onSettled() // budget (2 >= MAX-1) exhausted -> halt
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'halted',
      reason: 'blocker_budget_exhausted',
    },
  ])
})

test('label-reset halt: emits state-change{halted, label_reset_failed}', async () => {
  // PMR-B033: the blocker route-back could not reset the stale implement
  // completion label — fail-closed halt with its own v2 reason.
  const h = makeHarness(['planned', 'active'])
  h.deps.hasFreshBlockers = async () => true
  h.deps.removeAvenLabel = async () => false
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'validate',
    promptInput: { ...PROMPT_INPUT },
  })
  await loop.onSettled() // blockers -> route-back -> reset fails -> halt
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'label_reset_failed' },
  ])
})

test('prompt-send halt: emits state-change{halted, prompt_send_failed}', async () => {
  // work mode + empty workRoots -> validate prompt blocks in sendPhasePrompt.
  const h = makeHarness(['planned', 'active'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'validate',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'prompt_send_failed' },
  ])
})

test('spec-approval pause: emits state-change{waiting_human, spec_approval_pending} + step-start{plan.spec-approval}', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_human',
      reason: 'spec_approval_pending',
    },
    { kind: 'step-start', phase: 'plan', step: 'plan.spec-approval' },
  ])
})

test('subagent-in-flight: emits waiting_machine{subagent_in_flight}; next settle emits running (ISC-7)', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
  // child steers back, label lands -> advance emits running.
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

// ===========================================================================
// worker-ask-wait fix: an in-flight subagent that is BLOCKED ON THE HUMAN
// (ask_owner) is a human wait, not a machine wait. Before this fix the loop
// labelled every in-flight settle `waiting_machine{subagent_in_flight}`, so the
// Grafana "Waiting on me — act now" panel (state="waiting_human") never showed
// the run even though the human was the bottleneck.
// ===========================================================================

test('subagent-in-flight WITH a pending ask: emits waiting_human{subagent_ask_pending}', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_human',
      reason: 'subagent_ask_pending',
    },
  ])
  // Armed exactly as before: the wait ends when the child is answered and
  // steers back, and the next settle emits the running return (ISC-7 — still
  // NO loop-state snapshot in this branch).
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'loop-state').length,
    2,
    'the in-flight branch must not journal a loop-state snapshot',
  )
  h.pendingAsk = false
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(
    v2View(h).slice(2),
    [{ kind: 'state-change', state: 'running', reason: undefined }],
    'the answer + label landing returns the run to running',
  )
})

test('subagent-in-flight journal note says the child waits on the HUMAN when an ask is pending', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  const note = h.events.find((e) => e.kind === 'note')
  assert.ok(note && note.kind === 'note', 'the branch journals a note')
  if (note && note.kind === 'note') {
    assert.match(note.text, /waiting on the human/)
    // Still armed: the "flow stays armed" wording is what the operator reads
    // when they reopen the journal.
    assert.match(note.text, /flow stays armed/)
  }
})

test('subagent-in-flight WITHOUT a pending ask: unchanged waiting_machine{subagent_in_flight} and unchanged note', async () => {
  const h = makeHarness([])
  h.inFlight = true
  h.pendingAsk = false
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
  const note = h.events.find((e) => e.kind === 'note')
  assert.ok(note && note.kind === 'note')
  if (note && note.kind === 'note') {
    assert.match(note.text, /a subagent is in flight/)
    assert.ok(!note.text.includes('waiting on the human'), note.text)
  }
})

test('hasPendingSubagentAsk dep ABSENT: fail closed to the old machine wait', async () => {
  // Optional dep (no fixture churn for older consumers): absent => false.
  const h = makeHarness([])
  h.inFlight = true
  delete h.deps.hasPendingSubagentAsk
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    {
      kind: 'state-change',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
  ])
})

test('pending ask WITHOUT an in-flight subagent: no human wait is claimed', async () => {
  // The ask probe only reclassifies the in-flight branch. A settle with no live
  // child but a leftover ask record (crashed child, record not yet cleaned) is
  // the ordinary label-miss halt — never a phantom "waiting on you" row.
  const h = makeHarness([])
  h.inFlight = false
  h.pendingAsk = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('done: emits state-change{done}', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed', 'done'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'feedback',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'done', reason: undefined },
  ])
})

test('resume seeds running and does NOT re-emit it (ISC-A-2 guarded)', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'running' })
  // start snapshot + prompt-send snapshot both guarded -> no v2 running.
  assert.deepEqual(v2View(h), [])
  // but a real transition still emits
  await loop.onSettled() // planned -> implement
  assert.deepEqual(v2View(h), [])
  // validate the seed derivation feeds the guard: a halt after seeded running
  // still emits halted.
})

test('resume seeds running then halts: only the halt emits (no duplicate running)', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'running' })
  await loop.onSettled() // no label -> label_miss halt
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'halted', reason: 'label_miss' },
  ])
})

test('resume after waiting_human: seeded waiting_human -> running emitted', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), resumeState: 'waiting_human' })
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('spec-approval resolution: step-stop{plan.spec-approval} journaled when plan advances after the pause', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  // human approves; re-run re-enters plan with the seeded prior state
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({ ...startInput(), resumeState: 'waiting_human' })
  await loop.onSettled() // planned lands -> advanceAfter('plan') -> step-stop
  const kinds = h.v2.map((e) => e.kind)
  assert.ok(kinds.includes('step-start'), 'pause must journal a step-start')
  assert.ok(kinds.includes('step-stop'), 'resolution must journal a step-stop')
  const stop = h.v2.find((e) => e.kind === 'step-stop')
  assert.ok(stop && stop.kind === 'step-stop')
  if (stop && stop.kind === 'step-stop') {
    assert.equal(stop.phase, 'plan')
    assert.equal(stop.step, 'plan.spec-approval')
  }
})

// ===========================================================================
// PMR-ZV9Y fix-round-3 (deviation #1): the plan.spec-approval step-stop timing.
// Spec Behaviour 3 (plan.md:68) — "the answer/spec-approve path journals
// step-stop{plan.spec-approval}; the loop's NEXT snapshot journals
// state-change{running}" — so on the restart that /flow answer triggers the
// journal ORDER must be step-stop THEN running. Before this fix the loop
// emitted running on the restart and deferred the stop to the plan phase-
// complete (advanceAfter), inverting the order, extending pi_flow_step_seconds
// / the Tempo span past the approval, and emitting NO stop at all if the run
// halted before plan completed. The fix closes the step at the earliest
// faithful site: start(), when the seeded specApprovalStepOpen flag says the
// approval step is still open. A reject restarts the loop the same way, so the
// wait ENDED (approve OR reject) and step-stop is correct for both.
// ===========================================================================

test('fix-round-3 #1: restart-after-approve journals step-stop BEFORE running (Behaviour 3 order)', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> waiting_human + step-start (flag open)
  const beforeRestart = h.v2.length
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  })
  assert.deepEqual(v2View(h).slice(beforeRestart), [
    { kind: 'step-stop', phase: 'plan', step: 'plan.spec-approval' },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('fix-round-3 #1: restart-after-reject journals step-stop BEFORE running (the wait ended)', async () => {
  // /flow answer reject routes back to plan work (spec to draft); the loop only
  // sees a restart with the approval step still open, exactly like approve. The
  // wait ENDED either way, so step-stop is correct for the reject path too.
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> waiting_human + step-start (flag open)
  const beforeRestart = h.v2.length
  h.planState = 'draft' // reject: spec went back to draft, no label landed yet
  h.labels = []
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  })
  assert.deepEqual(v2View(h).slice(beforeRestart), [
    { kind: 'step-stop', phase: 'plan', step: 'plan.spec-approval' },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('fix-round-3 #1: halt before plan completes still journals the step-stop, BEFORE the halt', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  }) // restart -> step-stop + running (the fix)
  // now halt before plan can complete (no label, not review -> label_miss).
  h.planState = 'draft'
  h.labels = []
  await loop.onSettled()
  const stopIdx = h.v2.findIndex((e) => e.kind === 'step-stop')
  const haltIdx = h.v2.findIndex(
    (e) => e.kind === 'state-change' && e.state === 'halted',
  )
  assert.ok(
    stopIdx >= 0,
    'a halt after an approval restart must still see a stop',
  )
  assert.ok(
    haltIdx > stopIdx,
    `stop must precede the halt: ${String(stopIdx)} vs ${String(haltIdx)}`,
  )
})

// AIDEV-NOTE: PMR-F79K — the invariant behind removing advanceAfter's
// "idempotent fallback" stop. That branch could never fire: the spec-approval
// pause sets specApprovalStepOpen AND nulls this.state in the same block,
// onSettled bails on a null state, and start() always clears the flag before
// it can reach advanceAfter. So the restart path in start() is the ONLY close,
// which means a run that pauses for approval and is never re-entered keeps its
// plan.spec-approval step open (the journal says the human still owes an
// answer — true). These two pins hold both halves of that statement.
test('PMR-F79K: the restart in start() is the ONLY plan.spec-approval close', async () => {
  // Half 1: pause, then settle again with the plan label landed and NO restart
  // -> no step-stop anywhere. advanceAfter never runs on a nulled instance, so
  // the deleted fallback branch had nothing to close.
  const open = makeHarness([])
  open.planState = 'review'
  const openLoop = createFlowLoop(open.deps)
  await openLoop.start(startInput())
  await openLoop.onSettled() // pause -> step-start, state nulled
  open.planState = 'approved'
  open.labels = ['planned']
  await openLoop.onSettled() // bails: this.state === null
  assert.equal(
    open.v2.filter((e) => e.kind === 'step-stop').length,
    0,
    'a never-re-entered pause must not emit a step-stop',
  )
  assert.deepEqual(
    v2View(open).filter((e) => e.kind === 'step-start'),
    [{ kind: 'step-start', phase: 'plan', step: 'plan.spec-approval' }],
    'the approval step stays open until a restart closes it',
  )

  // Half 2: the restart closes it exactly once, ordered before the running
  // snapshot, and advancing the plan phase afterwards adds nothing.
  const closed = makeHarness([])
  closed.planState = 'review'
  const closedLoop = createFlowLoop(closed.deps)
  await closedLoop.start(startInput())
  await closedLoop.onSettled() // pause -> step-start
  closed.planState = 'approved'
  closed.labels = ['planned']
  const beforeRestart = closed.v2.length
  await closedLoop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  }) // restart -> the only step-stop
  // Behaviour 3 order, measured on the restart's OWN events (the initial start
  // already journaled a running snapshot further back).
  assert.deepEqual(v2View(closed).slice(beforeRestart, beforeRestart + 2), [
    { kind: 'step-stop', phase: 'plan', step: 'plan.spec-approval' },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  await closedLoop.onSettled() // planned lands -> advanceAfter('plan')
  assert.equal(
    closed.v2.filter((e) => e.kind === 'step-stop').length,
    1,
    'advancing the plan phase must not emit a second stop',
  )
})

test('fix-round-3 #1: no double step-stop when advanceAfter later closes the plan phase', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // pause -> step-start
  h.planState = 'approved'
  h.labels = ['planned']
  await loop.start({
    ...startInput(),
    resumeState: 'waiting_human',
    resumePlanApprovalOpen: true,
  }) // restart -> step-stop (flag now cleared)
  await loop.onSettled() // planned lands -> advanceAfter('plan') -> must NOT re-stop
  const stops = h.v2.filter((e) => e.kind === 'step-stop')
  assert.equal(
    stops.length,
    1,
    `at-most-once stop, got ${String(stops.length)}: ${JSON.stringify(v2View(h))}`,
  )
})

test('fix-round-3 #1: a fresh run with no prior pause emits no step events', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(
    h.v2.filter((e) => e.kind === 'step-start' || e.kind === 'step-stop')
      .length,
    0,
    JSON.stringify(v2View(h)),
  )
})

test('journalV2 throwing never propagates and the loop still proceeds (ISC-A-5)', async () => {
  const h = makeHarness([])
  h.v2Throws = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // must not reject
  assert.equal(loop.isActive(), true)
  // v1 stream still intact and the halt still tears down despite v2 throws
  await loop.onSettled() // label miss -> halt
  assert.equal(loop.isActive(), false)
  assert.equal(h.v2.length, 0) // nothing captured (all threw)
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'halted')
})

test('journalV2 absent: loop proceeds with no v2 events and no throw', async () => {
  const h = makeHarness([])
  delete h.deps.journalV2
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.v2.length, 0)
  assert.equal(loop.isActive(), false)
})

test('resumeV2StateFromEvents: last state-change wins (phase-1 fold)', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: 't0', ref: 'R', mode: 'personal' },
    { kind: 'state-change', at: 't1', ref: 'R', state: 'running' },
    {
      kind: 'state-change',
      at: 't2',
      ref: 'R',
      state: 'waiting_machine',
      reason: 'subagent_in_flight',
    },
    {
      kind: 'loop-state',
      at: 't3',
      ref: 'R',
      loop: {
        phase: 'implement',
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'x',
        status: 'running',
      },
    },
  ]
  assert.equal(resumeV2StateFromEvents(events), 'waiting_machine')
})

test('resumeV2StateFromEvents: no v2 events -> derived from projected loop status', () => {
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: 't0', ref: 'R', mode: 'personal' },
    {
      kind: 'loop-state',
      at: 't1',
      ref: 'R',
      loop: {
        phase: 'plan',
        awaitingOutcome: false,
        blockerRetries: 0,
        validateStartedAt: 'x',
        status: 'paused',
      },
    },
  ]
  assert.equal(resumeV2StateFromEvents(events), 'waiting_human')
})

test('resumeV2StateFromEvents: null/empty journal seeds nothing', () => {
  assert.equal(resumeV2StateFromEvents(null), undefined)
  assert.equal(resumeV2StateFromEvents([]), undefined)
})

// ===========================================================================
// PMR-ZV9Y fix round (P1 blocker) + fix-round-2 (P2a): the guarded v2 emission
// must be invalidated by a TOOL-journaled state-change, not only by the loop's
// own emissions.
//
// Mechanism under test: `noteExternalV2State(ref, state, at)` is the seam index.ts
// calls from the fan-out dispatcher's `onV2StateChangeObserved` observer — NOT
// the `onStateChange` telemetry sink. PRODUCTION DESIGN (index.ts:519 +
// telemetry/dispatch.ts route()): every journaled v2 state-change — loop AND
// tool, per the telemetry/dispatch.ts seam map — reaches the single choke point
// `route`, which fires the observer FIRST and in its OWN try/catch, fully
// independent of the `onStateChange` Loki/notify sinks. So (a) a throwing
// telemetry sink never costs the loop bookkeeping, (b) the loop learns the wait
// even when telemetry is off (`onStateChange === undefined`), and (c) the
// observer is monotonic on `event.at` (fix-round-2 P2a) because tool v2 writes
// bypass `journalSerial` and can route a stale loop echo AFTER a newer tool
// wait. run-attempt escalate (waiting_human) and deviation rerun
// (waiting_machine) journal a wait but never the running return, so without the
// observer the loop's `lastEmittedV2` stays pinned at `running` and the next
// snapshot('running') is guard-suppressed (pi_flow_state stuck at the wait).
// ===========================================================================

// A fixed ISO timestamp for the hand-built JOURNAL events (the fold/render
// assertions only care about array order + vocabulary, not wall-clock).
const AT = '2026-11-25T09:00:00.000Z'

// The loop's own emitStateChange stamps `at = now()` (real wall-clock) and, since
// fix-round-2, that timestamp advances the recency watermark. An external
// observation is therefore only applied when its `at` is STRICTLY newer, so the
// hand-driven tests date it relative to real now (offsetSec > 0). The ISO format
// is fixed-width UTC, so the test helper's string compare is a valid
// chronological compare — the same property loop.ts relies on.
function atOffset(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString()
}

test('P1: a tool-journaled wait un-pins the loop — the next running snapshot emits', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted once; lastEmittedV2 = 'running'
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
  // The observer mirrors a tool-side wait (run-attempt escalate / deviation
  // rerun) WITHOUT the tool journaling the running return. The wait is NEWER
  // than the loop's own running stamp, so the P2a monotonic guard accepts it.
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(60))
  // The loop re-arms and advances (plan lands -> implement prompt) — its
  // snapshot('running') MUST now emit, because lastEmittedV2 is waiting_human.
  h.labels = ['planned']
  await loop.onSettled()
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 guard: an external wait for a DIFFERENT ref never touches the active guard', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // active ref TP-1, lastEmittedV2 = 'running'
  // A foreign run's wait must not un-pin THIS run's guard (ref-guard runs
  // BEFORE the recency guard, so a future-dated foreign wait is still ignored).
  loop.noteExternalV2State('OTHER-1', 'waiting_human', atOffset(60))
  h.labels = ['planned']
  await loop.onSettled() // advance -> snapshot('running') still suppressed (own running)
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 no-duplicate: a plain running->running re-snapshot stays suppressed (no external wait)', async () => {
  // Proves the fix is NOT "always emit": with no external wait in between, the
  // loop's own running->running duplicate is still suppressed (the guard intact).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = ['planned']
  await loop.onSettled() // advance -> sendPhasePrompt -> snapshot('running') suppressed
  assert.deepEqual(v2View(h), [
    { kind: 'state-change', state: 'running', reason: undefined },
  ])
})

test('P1 observer (real fan-out): a tool state-change recorded through onV2StateChangeObserved un-pins the loop', async () => {
  // Repointed to the PRODUCTION wiring (fix-round-2 P1 blocker). index.ts:519
  // assigns the loop to the fan-out dispatcher's `onV2StateChangeObserved`
  // observer (NOT `onStateChange`, which is the Loki/notify telemetry sink);
  // dispatch.ts route() fires the observer first, in its own try/catch, on EVERY
  // journaled state-change. This test wires that observer exactly like index.ts
  // does, so deleting or reordering the ~7-line observer block in route() turns
  // it red (see the mutation note in the fix-round task).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running emitted (stamps real now())
  const written: FlowRunEvent[] = []
  const baseWriter: EventWriter = {
    record: async (event) => {
      written.push(event)
      return true
    },
    recordJournalOnly: async (event) => {
      written.push(event)
    },
  }
  // onStateChange is UNDEFINED here on purpose: the telemetry-off posture is
  // exactly what the separate observer slot exists to cover.
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
  }
  const fanout = createEventFanoutWriter(baseWriter, handlers)
  // The tool journals ONLY the wait through the dispatcher's observer. The
  // `at` is strictly newer than the loop's own running stamp so the P2a
  // monotonic guard accepts it.
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.equal(written.length, 1, 'the wait reached the writer')
  // The loop re-arms and advances -> running snapshot now emits.
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    `expected the running return after the wait: ${String(
      h.v2
        .filter((e) => e.kind === 'state-change')
        .map((e) => {
          if (e.kind !== 'state-change') return e.kind
          return `${e.kind}:${e.state}`
        }),
    )}`,
  )
})

// Fix-round-2 (P1 blocker) — the observer slot itself, not just the loop seam.
// index.ts wires the loop to onV2StateChangeObserved; onStateChange is the
// Loki/notify TELEMETRY sink. These cases pin the isolation properties the
// separate slot exists for (ISC-A-5) and that the observer is the ONLY thing
// that updates the loop guard (the mutation the blocker warned about).

function baseWriterProbe() {
  const written: FlowRunEvent[] = []
  const writer: EventWriter = {
    record: async (event) => {
      written.push(event)
      return true
    },
    recordJournalOnly: async (event) => {
      written.push(event)
    },
  }
  return { writer, written }
}

test('P1 observer (a): a throwing onV2StateChangeObserved never costs onStateChange routing and never throws out of record', async () => {
  // ISC-A-5: the observer runs in its OWN try/catch, so a loop-bookkeeping bug
  // can never also cost the telemetry sink.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer, written } = baseWriterProbe()
  const sinks: FlowRunEvent[] = []
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: () => {
      throw new Error('observer exploded')
    },
    onStateChange: (event) => {
      sinks.push(event)
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.equal(written.length, 1, 'writer reached')
  assert.equal(
    sinks.length,
    1,
    'the telemetry sink STILL routed despite a throwing observer',
  )
  void loop // the throwing observer is bookkeeping-irrelevant here; the assertion is the routing
})

test('P1 observer (b): a throwing onStateChange never costs the observer — observer fires FIRST', async () => {
  // Order property: dispatch.ts route() invokes the observer BEFORE onStateChange
  // and in a separate try/catch, so a throwing notify/Loki sink can never cost
  // the loop its wait (the loop must still un-pin).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer } = baseWriterProbe()
  const order: string[] = []
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      order.push('observer')
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
    onStateChange: () => {
      order.push('sink')
      throw new Error('notify exploded')
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  assert.deepEqual(
    order,
    ['observer', 'sink'],
    'observer fires before the sink',
  )
  // The loop un-pinned even though the telemetry sink threw -> the next
  // differing snapshot emits.
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 2, 'loop un-pinned despite the throwing sink')
})

test('P1 observer (c): onV2StateChangeObserved alone (onStateChange undefined) still updates the loop guard', async () => {
  // The telemetry-fully-disabled posture (no Loki, no notify): the ONLY handler
  // present is the observer, and the loop must still learn the wait. This is
  // the exact reason a separate slot exists (option (a) over reusing
  // onStateChange). It overlaps the real-fan-out test but pins it at the
  // routing level (no onStateChange key at all).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer, written } = baseWriterProbe()
  const handlers: FanoutHandlers = {
    onV2StateChangeObserved: (event) => {
      loop.noteExternalV2State(event.ref, event.state, event.at)
    },
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_machine',
    reason: 'deviation_gate_rerun',
  })
  assert.equal(written.length, 1)
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 2, 'observer-only wiring un-pins the loop')
})

test('P1 observer (d, counterfactual): WITHOUT the observer the loop guard stays stale and the running snapshot is suppressed', async () => {
  // The failure mode the P1 blocker described: the loop is wired ONLY through
  // the dispatcher's observer block, so if that ~7-line block were deleted or
  // reordered out of route(), the wait never reaches the loop. Model that here
  // by wiring ONLY the telemetry sink (as production does — it never touches
  // the loop) and NO observer, then assert the next running snapshot stays
  // suppressed. The real-fan-out test (above) goes red under the same mutation
  // (runnings 1 not 2); this test pins the counterfactual explicitly.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const { writer } = baseWriterProbe()
  const handlers: FanoutHandlers = {
    // A pure telemetry sink: Loki/notify, NOT the loop. This is what
    // onStateChange is in production.
    onStateChange: () => {},
  }
  const fanout = createEventFanoutWriter(writer, handlers)
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    1,
    'no observer -> guard stays pinned at running -> the re-snapshot is suppressed (the original P1 symptom)',
  )
})

test('P1 fold: escalate-wait then a running snapshot renders pi_flow_state{running} through the real projection', async () => {
  // The reviewer's reproduced journal sequence, driven through the REAL
  // projectRunState + renderStateMetricLines fold (not just emission mocks).
  const h = makeHarness([])
  const journal: FlowRunEvent[] = [
    { kind: 'run-start', at: AT, ref: 'TP-1', mode: 'personal' },
  ]
  h.deps.journalV2 = (event) => {
    h.v2.push(event)
    journal.push(event)
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running journaled into the journal
  // The tool journals the wait into the SAME journal, then the observer
  // re-seeds. The observer `at` is strictly newer than the loop's own running
  // stamp so the P2a monotonic guard accepts it (the journal entry keeps its
  // fixed AT for the array-order fold — the projection reads the journal, not
  // the guard, so the two timestamps need not match).
  journal.push({
    kind: 'state-change',
    at: new Date(Date.parse(AT) + 1000).toISOString(),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(60))
  // The loop advances -> running snapshot (the fix makes it emit).
  h.labels = ['planned']
  await loop.onSettled()

  assert.equal(deriveV2State(journal)?.state, 'running', String(journal))
  const lines = renderStateMetricLines('TP-1', journal)
  const stateLine = lines.find((line) => line.startsWith('pi_flow_state{'))
  assert.ok(
    stateLine !== undefined,
    `no pi_flow_state line rendered: ${lines.join('\n')}`,
  )
  assert.ok(
    stateLine?.includes('state="running"'),
    `pi_flow_state pinned at the wait: ${String(stateLine)}\n${lines.join('\n')}`,
  )
  // The wait still contributes its window (it was a real wait) — the running
  // line is the CURRENT state, exactly one, never waiting_human.
  assert.equal(
    lines.filter((line) => line.startsWith('pi_flow_state{')).length,
    1,
    lines.join('\n'),
  )
  assert.ok(!stateLine?.includes('state="waiting_human"'), lines.join('\n'))
  // projectRunState agrees with deriveV2State (last-wins). This is the guard
  // that would fail if the running return were suppressed (journal stuck at
  // waiting_human).
  const projected = projectRunState(journal)
  assert.equal(projected?.currentState?.state, 'running')
})

// ===========================================================================
// PMR-ZV9Y fix-round-2 (P2a): the external observer is MONOTONIC on the event
// timestamp. Tool v2 writes bypass `journalSerial`, so an already-enqueued loop
// `running` event can route AFTER a tool's later `waiting_human`. Without a
// recency guard, route(waiting_human) sets the guard, then the late
// route(running echo) reverts it to `running` and the next differing snapshot
// is suppressed again — the original P1 symptom in a narrow window. The fix:
// ignore external observations whose `at` is older-or-equal than the last
// applied one. ISO-8601 fixed-width UTC makes a lexicographic string compare a
// correct chronological compare.
// ===========================================================================

test('P2a: an older external wait is ignored — the guard stays pinned (recency, not just state)', async () => {
  // The external wait is a VALID un-pin by state (waiting_human != running),
  // but its `at` predates the loop's own start stamp -> it is recency-skipped,
  // so the loop's next running snapshot stays suppressed (only 1 running).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running at real now(), lastV2At = now()
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(-60)) // older -> ignored
  h.labels = ['planned']
  await loop.onSettled() // snapshot('running') still suppressed (guard = running)
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(runnings.length, 1, 'older external observation recency-skipped')
})

test('P2a: a late loop echo cannot revert a newer tool wait (the narrow-window symptom)', async () => {
  // The exact regression. Sequence the guard must survive:
  //   1. loop emits running (lastV2At = now).
  //   2. tool's waiting_human routes FIRST  at +120s -> applied (newer).
  //   3. the loop's queued running echo routes LATER at +60s -> OLDER than the
  //      wait -> recency-skipped (the guard stays waiting_human).
  //   4. loop advances -> snapshot('running') DIFFERS from the guard -> emits.
  // Without the monotonic guard step 3 would revert the guard to `running`,
  // suppress step 4, and only 1 running would be journaled (the P1 symptom).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput()) // running, lastV2At = now()
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(120)) // tool wait (newer)
  loop.noteExternalV2State('TP-1', 'running', atOffset(60)) // late loop echo (older)
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    'the stale running echo did not re-pin the guard -> running return emitted',
  )
})

test('P2a: the loop is never locked out by a future-dated external stamp', async () => {
  // The loop's own emitStateChange is NOT recency-gated (only the external
  // observer is) — so a stale/foreign FUTURE `at` on an external observation
  // can never suppress the loop's own next differing emission. Sequence:
  //   1. loop emits running (lastV2At = now).
  //   2. external waiting_machine at +3600s (far future) -> applied, lastV2At = +3600.
  //   3. loop advances -> snapshot('running') at real now (< +3600) -> STILL
  //      emits, because the loop's own emission only checks state equality, not
  //      recency. Two runnings proves the loop was not locked out.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  loop.noteExternalV2State('TP-1', 'waiting_machine', atOffset(3600))
  h.labels = ['planned']
  await loop.onSettled()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    'loop emit advances the guard regardless of a future-dated lastV2At',
  )
})

// ===========================================================================
// PMR-0NRH 3.1 — the LIVE-WAIT GUARD (ISC-4). A tool-journaled `waiting_human`
// (an open mid-turn ask_user_question, subtask 2.2) is the truth the board must
// show until the ask closes. But `emitStateChange` only same-state-suppresses
// and advances `lastV2At` unconditionally, so a settle taking the
// `waiting_machine{subagent_in_flight}` branch (onSettled, in-flight + no child
// ask) OVERWRITES the live human wait: the board flips back to "machine working"
// while the human is still the bottleneck. `noteExternalV2State` protected only
// the reverse direction (a loop wait vs an external observation). The fix is a
// live-wait flag maintained by the external observer and honoured by
// emitStateChange.
//
// AIDEV-NOTE: PMR-0NRH fix round 2 (review blocker 3) → PMR-422Q — the WIDTH of
// this hold has changed twice. Fix round 2 made it NARROW (only a settle's
// `waiting_machine` / `waiting_human`, NEVER `running`) because the earlier wide
// non-terminal hold bf1d592 introduced had no release: every skip path whose
// close never landed (a fail-closed ask read, an unclear code_review answer)
// stranded the journal at waiting_human for the rest of the process. PMR-422Q
// restored the WIDE hold — non-terminal states INCLUDING `running`, so an
// advancing settle can no longer mask a blocked run as working — behind a
// RENEWING LEASE (flow/live-wait.ts): arming stamps the deadline, the owning
// seam heartbeats it via `loop.renewLiveWaitLease`, and a wait that stops
// beating releases itself within `LIVE_WAIT_LEASE_SECONDS`, so the loop's next
// non-terminal emission self-heals the journal. Terminal `halted` / `done` /
// `stale` are NEVER held, lease or not. Arming stays REASON-AWARE
// (PMR-422Q): ONLY a `waiting_human` whose reason is in SELF_CLOSING_HUMAN_WAITS
// (flow/vocabulary.ts: `human_ask_pending`, `code_review_pending` — seams that
// journal their own close) arms it; `escalation` (a `waiting_human` with no
// running return), `deviation_gate_rerun` (a `waiting_machine` the gate writes
// STRAIGHT to the fan-out writer, so it never reaches this hold at all — the
// PMR-ZV9Y P1 invalidation case, not a WIDTH case) and an absent reason never
// arm, they only clear. PLUS one
// deliberate, documented exception to "the flag is written only in
// noteExternalV2State": a `running` emission that actually PROCEEDS in
// emitStateChange clears flag + lease (the loop's own emission is unambiguous,
// unlike its recency-skipped echo). That clear-on-running is what makes the
// post-expiry self-heal literal — without it an armed flag over a `running`
// journal would suppress every later genuine wait for the rest of the process.
// The full rule lives at the skip predicate's note in flow/loop.ts — read it
// before narrowing or widening this predicate.
//
// These tests ride the PRODUCTION path: the loop's `journalV2` seam is wired to
// a real createEventFanoutWriter (index.ts: journalV2 -> journalSerial -> the
// one wrapped writer), and a tool write goes through the same dispatcher, so
// `onV2StateChangeObserved` -> `noteExternalV2State` runs exactly as in the
// extension. Assertions are on EMITTED/JOURNALED EVENTS, never the private flag.
// ===========================================================================

/** Wire a loop's v2 seam to a real fan-out over a capturing writer (index.ts
 * posture: the loop's events route through the SAME observer a tool write does,
 * asynchronously — a queued echo). Returns the dispatcher (for tool-side
 * writes) and the durable journal mirror (for tail assertions). */
function wireRealFanout(h: Harness, loop: FlowLoop) {
  const written: FlowRunEvent[] = []
  const baseWriter: EventWriter = {
    record: async (event) => {
      written.push(event)
      return true
    },
    recordJournalOnly: async (event) => {
      written.push(event)
    },
  }
  const fanout = createEventFanoutWriter(baseWriter, {
    onV2StateChangeObserved: (event) => {
      // Production parity with index.ts: the observer threads event.reason so
      // the loop can tell a self-closing wait from one that never journals its
      // own running close (PMR-422Q).
      loop.noteExternalV2State(event.ref, event.state, event.at, event.reason)
    },
  })
  h.deps.journalV2 = (event) => {
    h.v2.push(event)
    void fanout.record(event)
  }
  return { fanout, written }
}

/** Let queued fire-and-forget fan-out writes route, so a loop's OWN echo
 * reaches the observer before the test asserts (the P2a narrow window). */
async function flushFanout(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The v2 state-change states in emission order (readable failure output). */
function stateSequence(events: readonly FlowRunEvent[]): string[] {
  return events
    .filter((e) => e.kind === 'state-change')
    .map((e) => {
      if (e.kind !== 'state-change') return e.kind
      if (e.reason === undefined) return e.state
      return `${e.state}/${e.reason}`
    })
}

test('PMR-0NRH hazard: a settle with a subagent in flight must NOT clobber a live tool-journaled waiting_human', async () => {
  // The interview's required ordering: waiting_human -> settle -> still
  // waiting_human. A steer/interrupt can end the open turn while the ask
  // blocks, so onSettled fires with the human wait LIVE.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput()) // state-change{running}, lastV2At = now()
  // The mid-turn ask journals its wait through the TOOL seam (ask-emitter),
  // strictly NEWER than the loop's own stamp -> the P2a recency guard accepts
  // it, so the loop knows a human wait is open.
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // The hazard: label missing + in-flight subagent + NO child ask -> the
  // waiting_machine{subagent_in_flight} settle branch.
  h.labels = []
  await loop.onSettled()
  // Flush so the loop's queued echoes route too: a guard placed BEFORE the
  // recency check would let the loop clear its own hold here and turn this
  // test green for the wrong reason.
  await flushFanout()
  assert.deepEqual(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
    [],
    `settle clobbered the live human wait: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // ISC-4: the durable journal tail (what the board / Grafana fold reads) still
  // reads waiting_human.
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail is not the live human wait: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-0NRH close-and-resume: the ask close (external running) releases the hold and the machine wait emits', async () => {
  // The other half of the guard: it must be LIVE-only. The ask-emitter journals
  // state-change{running} on tool_result, which routes as an external
  // observation, clears the flag, and the very next settle is free to journal
  // the machine wait again (the run really is waiting on the child now).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')).length,
    0,
    `pre-close hold missing: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // The human answers -> the emitter journals the close through the SAME seam.
  await fanout.record({
    kind: 'state-change',
    at: atOffset(120),
    ref: 'TP-1',
    state: 'running',
  })
  // The next settle (still armed, still in flight, no child ask) now emits the
  // machine wait: the guard was `running` after the close, so it DIFFERS.
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `hold not released by the close: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_machine',
    `journal tail not released: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-0NRH start reset: a stale waiting_human journal tail never pins a restarted run (ISC-10)', async () => {
  // A process that died mid-ask leaves waiting_human as the journal tail. The
  // live-wait flag is in-process, so start() must drop it: the seeded guard
  // plus snapshot('running') unstick the journal EXACTLY as today, and a
  // settle's machine branch emits normally.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // Restart with the stale tail seeded as the guard (index.ts resume path).
  await loop.start({ ...startInput(), resumeState: 'waiting_human' })
  await flushFanout()
  // The stale tail is unstuck by the running snapshot (today's behaviour).
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `restart did not unstick the stale tail: ${stateSequence(written).join(' -> ')}`,
  )
  // And the flag went with it: the machine branch is free to emit.
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `start() left the live-wait flag set: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

test('PMR-0NRH subagent ask: the loop-owned waiting_human{subagent_ask_pending} branch is unchanged and never self-holds (ISC-A-7)', async () => {
  // No external wait is open, so the child-ask settle must still emit its human
  // wait exactly as before. It also PROVES the loop-owned-echo claim the plan
  // asserts: this emission's own echo through the observer must NOT set the
  // live-wait flag, or the loop would hold its own next machine wait and the fix
  // would be a no-op in the reverse direction.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  wireRealFanout(h, loop)
  h.inFlight = true
  h.pendingAsk = true
  await loop.start(startInput())
  h.labels = []
  await loop.onSettled()
  assert.ok(
    stateSequence(h.v2).includes('waiting_human/subagent_ask_pending'),
    `child-ask branch changed: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // Let the loop's OWN waiting_human echo route, then flip the probe: the next
  // settle takes the machine branch. If the echo had set the flag (a guard
  // ordered before the recency check, or an emit path that wrote the flag), the
  // machine wait would be held here and this assertion would go red.
  await flushFanout()
  h.pendingAsk = false
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `the loop's own echo self-held the guard: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

test('PMR-0NRH latch: an external waiting_human{escalation} never arms the hold — later loop waits still emit', async () => {
  // The reviewer's reproduced latch (PMR-422Q). run_attempt escalate journals
  // waiting_human{escalation} through the shared fan-out writer and NEVER the
  // running return, so the flag can only be cleared by an external observation
  // that does not exist. The loop's own snapshot('running') — the PMR-ZV9Y P1
  // unstick — is recency-skipped inside noteExternalV2State (at <= lastV2At
  // returns before the flag line), so it cannot release the hold either. The
  // flag therefore latched for the rest of the process's run and every later
  // loop-emitted waiting_machine / waiting_human was silently dropped.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'escalation',
  })
  // 1. PMR-ZV9Y P1 stays intact: the advance's snapshot('running') emits and
  //    unsticks the journal (escalate journals no running return of its own).
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  const runnings = h.v2.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(
    runnings.length,
    2,
    `P1 unstick broken after the escalate: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // 2. THE LATCH: the next settle, child in flight, must still journal the
  //    machine wait.
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `escalate latched the hold — machine wait dropped: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // 3. And the loop-owned child-ask human wait must still journal too.
  h.pendingAsk = true
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_human/subagent_ask_pending'),
    `escalate latched the hold — child-ask wait dropped: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail not the live human wait: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-0NRH terminal override: a halt still journals while the live wait is open', async () => {
  // A real halt ends the run, so the open ask is moot: `halted` (and `done` /
  // `stale`) must still emit even with the flag set, or a blocked run would
  // never leave waiting_human on the board.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // Label miss with no in-flight subagent and plan-state != review -> the
  // generic label_miss halt.
  h.inFlight = false
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('halted/label_miss'),
    `terminal emission was held: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'halted',
    `journal tail not terminal: ${stateSequence(written).join(' -> ')}`,
  )
})

// --- PMR-422Q: reason-aware arming (the rest of the guard's contract) ---

test('PMR-422Q absent reason: a three-argument external waiting_human never arms the hold (PMR-ZV9Y semantics)', async () => {
  // The arming rule is "waiting_human AND a self-closing reason". With no
  // reason at all the observation still re-seeds the emission guard (the
  // PMR-ZV9Y P1 un-pinning) but must NOT hold anything — otherwise every
  // caller that does not know the reason (and the escalate path that has no
  // close) would latch the loop. This is what keeps the five protected
  // PMR-ZV9Y tests green unmodified: their observer wiring passes three args.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  h.inFlight = true
  await loop.start(startInput())
  loop.noteExternalV2State('TP-1', 'waiting_human', atOffset(60))
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `an absent reason armed the hold: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

test('PMR-422Q code_review_pending: the other self-closing reason arms the hold', async () => {
  // The code-review gate journals waiting_human{code_review_pending} before it
  // blocks and closeReviewGate journals the running close, so holding the loop
  // against it is safe and is what keeps the gate visible on the board.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'code_review_pending',
  })
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.deepEqual(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
    [],
    `code_review_pending did not arm the hold: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail not the live gate wait: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-422Q live-ask hold: an advancing settle during a LIVE (renewing) wait is HELD — the journal tail stays waiting_human', async () => {
  // PMR-422Q INVERTS the old "residual gap (accepted)" pin. Under the narrow
  // two-wait predicate an advancing settle journaled `running` OVER a live ask
  // — the board reported a blocked run as working until the ask closed. The
  // renewing lease makes the wide hold safe: while the owning seam heartbeats
  // the wait is genuinely live, so EVERY non-terminal emission, running
  // included, is held and the tail stays waiting_human. The renewal leg pins
  // that the hold survives past the ORIGINAL deadline on a heartbeat beat.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  // Arm from the ask seam: flag + initial lease = atOffset(60) + 180s = +240s
  // (ISC-3 — the hold is live from arming, before the first heartbeat).
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // plan lands -> advanceAfter -> snapshot('running'): HELD while the lease is
  // alive (the real clock sits at ~+0s, far inside the +240s window).
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    1,
    `advancing settle was NOT held against a live wait: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.deepEqual(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
    [],
    `competing wait leaked while the lease is alive: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail not the live human wait: ${stateSequence(written).join(' -> ')}`,
  )
  // RENEWAL BEAT past the original deadline: move the lease clock to +300s
  // (the armed window closed at +240s), beat, then settle. The beat pushed the
  // deadline to +480s, so the machine wait stays held (ISC-1/ISC-4).
  h.deps.now = () => atOffset(300)
  loop.renewLiveWaitLease('TP-1')
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.deepEqual(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
    [],
    `renewed lease did not keep holding: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail moved off the live wait after a beat: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-0NRH anti-strand: a lease-expired running emission clears an armed hold so a LATER machine wait still emits', async () => {
  // The code_review unclear-answer scenario (tools/code-review.ts returns on an
  // unclear/aborted answer WITHOUT closeReviewGate, telling the agent to re-ask
  // with no guarantee the re-call lands): a self-closing wait ARMS the hold and
  // NO external running close ever routes. PMR-422Q makes the release LEASE-
  // BOUNDED: while the lease is alive the wide hold suppresses everything non-
  // terminal INCLUDING the advance's running; once the lease expires (no beats
  // arrived) the next running emission journals AND clears flag + lease, so the
  // later waiting_machine{subagent_in_flight} emits. No unbounded strand, no
  // unbounded wrongness either.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  h.inFlight = true
  await loop.start(startInput())
  // An external self-closing wait arms the hold (newer than the loop's stamp);
  // lease deadline = atOffset(60) + 180s = atOffset(240).
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'code_review_pending',
  })
  // The hazard still holds: a settle taking the machine branch while the gate
  // wait is live must NOT clobber it — this leg is UNCHANGED in spirit (the
  // lease-alive hold covers waiting_machine exactly as the narrow one did).
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.deepEqual(
    stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
    [],
    `lease-alive hold did not protect the live gate wait: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // PMR-422Q WIDTH LEG: the run ADVANCES while the lease is still alive (real
  // clock ~+0s, deadline +240s) -> snapshot('running') is HELD, the tail stays
  // waiting_human. This is the behaviour the old narrow predicate pinned as the
  // accepted gap; the lease is what makes holding it safe.
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    1,
    `advance leaked running inside the lease window: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail moved off the live wait inside the lease window: ${stateSequence(written).join(' -> ')}`,
  )
  // EXPIRY: nothing heartbeated, so move the lease clock PAST the deadline and
  // let the run advance again (implement -> validate). The running emission
  // self-heals the journal AND clears flag + lease (clear-on-running).
  h.deps.now = () => atOffset(600)
  h.labels = ['planned', 'active']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `post-expiry running self-heal missing: ${stateSequence(written).join(' -> ')}`,
  )
  // ANTI-STRAND: a fresh self-closing wait would re-arm, but here nothing armed
  // again, so the next machine settle is free. Without the post-expiry release
  // the flag would still be armed from the code_review_pending wait and this
  // would drop.
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `armed hold stranded later waits after a running self-heal: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

test('PMR-0NRH strand regression: an armed human_ask_pending wait never externally closed is released once its lease expires, so every later wait emits', async () => {
  // The pure strand regression the blocker named: arm via human_ask_pending,
  // NEVER deliver the external close (a fail-closed read). Under PMR-422Q the
  // hold is wide but LEASE-BOUND: while the lease lives the advance's running is
  // held (the live-ask guarantee); once it expires with no beats, the next
  // running emission journals and clears flag + lease (clear-on-running), so a
  // LATER machine wait and a LATER child-ask human wait both emit. Bounded
  // wrongness, never a permanent strand.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // WIDTH LEG (lease alive, real clock ~+0s vs the +240s deadline): the
  // advance's running is HELD — a live ask is not masked as working.
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    1,
    `advance leaked running inside the lease window: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail moved off the live wait inside the lease window: ${stateSequence(written).join(' -> ')}`,
  )
  // EXPIRY LEG: no beats arrived, push the lease clock past the deadline; the
  // next advance journals running — the self-heal that keeps the strand bounded.
  h.deps.now = () => atOffset(600)
  h.labels = ['planned', 'active']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `post-expiry running self-heal missing (strand): ${stateSequence(written).join(' -> ')}`,
  )
  // LEG 1: a later machine wait emits (the flag + lease were cleared by the
  // loop's own post-expiry running emission, not by an external close).
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `later machine wait dropped after the strand: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // LEG 2: a later loop-owned child-ask human wait emits too.
  h.pendingAsk = true
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_human/subagent_ask_pending'),
    `later child-ask wait dropped after the strand: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

// --- PMR-422Q: the renewing lease (ISC-1..ISC-4, ISC-6) -------------------
//
// AIDEV-NOTE: two clocks exist in these tests and they MUST stay separate.
// External observations are dated with `atOffset(n)` against the REAL clock (the
// recency watermark compares against the loop's real `now()` stamps), while the
// LEASE is checked against `deps.now` — the loop's lease-arithmetic clock, which
// these tests inject (`h.deps.now = () => atOffset(600)`) to expire or renew a
// lease without sleeping. An armed hold therefore starts with deadline
// `atOffset(60) + 180s = atOffset(240)`; with no injected clock the real clock
// (~+0s) keeps the lease alive for the whole millisecond-scale test run, which is
// exactly what the hold-leg assertions of the pre-existing PMR-0NRH tests rely on.
// Do not switch event stamps to `deps.now` — it would silently re-base every
// recency test in this file.

test('PMR-422Q lease expiry: a broken wait stops holding once the lease expires — the next running emission self-heals and clears the flag', async () => {
  // ISC-2 in its purest shape: arm a self-closing wait, the owning seam dies
  // WITHOUT a close and WITHOUT a single heartbeat. The hold must lapse within
  // the lease window (lazy check — no loop-side timer), the next non-terminal
  // emission must journal, and the clear-on-running release must make every
  // LATER wait free. This is the anti-bf1d592 pin for the widened predicate.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // Lease deadline = atOffset(240). Nothing renewed, so push the lease clock
  // past it and let the run advance: running journals (the self-heal) and the
  // flag + lease go with it.
  h.deps.now = () => atOffset(300)
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    2,
    `post-expiry running did not self-heal: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `journal tail not unstuck after expiry: ${stateSequence(written).join(' -> ')}`,
  )
  // The release was COMPLETE (flag AND lease): a later machine wait emits with
  // no external close ever arriving.
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `expired hold still suppressed later waits: ${stateSequence(h.v2).join(' -> ')}`,
  )
})

test('PMR-422Q lease renewal: a heartbeat extends the lease past the original deadline — the advancing settle stays held', async () => {
  // ISC-4 (monotonic renewal) + ISC-1 together. Arm at atOffset(60) -> deadline
  // atOffset(240). Move the lease clock to atOffset(300), PAST the armed window,
  // then beat: the deadline moves to atOffset(300+180)=atOffset(480), so the
  // advance stays held. A beat can never SHORTEN a lease (max), and without the
  // renewal the very same settle would self-heal (previous test).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  h.deps.now = () => atOffset(300)
  loop.renewLiveWaitLease('TP-1')
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    1,
    `renewal did not keep the advance held: ${stateSequence(h.v2).join(' -> ')}`,
  )
  assert.equal(
    resumeV2StateFromEvents(written),
    'waiting_human',
    `journal tail moved off the renewed live wait: ${stateSequence(written).join(' -> ')}`,
  )
  // And the RENEWED window bounds the hold too: push past atOffset(480) with no
  // further beat and the next advance self-heals.
  h.deps.now = () => atOffset(600)
  h.labels = ['planned', 'active']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `renewed lease never expired: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-422Q overnight: repeated renewal keeps the hold alive across many lease windows', async () => {
  // The product promise: a live ask stays waiting_human NO MATTER how long the
  // human takes. Model an overnight wait as alternating beat/clock-steps over
  // several full windows (each +60s, 12 cycles = 12 minutes past the initial
  // deadline), asserting the advance stays held at every step, then a final
  // no-beat expiry self-heals.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout, written } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  for (let cycle = 0; cycle < 12; cycle += 1) {
    // Beat at now = 300 + cycle*60: deadline -> now + 180, strictly later each
    // cycle (monotonic max). The machine-branch settle must stay held.
    h.deps.now = () => atOffset(300 + cycle * 60)
    loop.renewLiveWaitLease('TP-1')
    h.inFlight = true
    h.labels = []
    await loop.onSettled()
    await flushFanout()
    assert.deepEqual(
      stateSequence(h.v2).filter((s) => s.startsWith('waiting_machine')),
      [],
      `overnight cycle ${cycle} leaked a competing wait: ${stateSequence(h.v2).join(' -> ')}`,
    )
    assert.equal(
      resumeV2StateFromEvents(written),
      'waiting_human',
      `overnight cycle ${cycle} moved the journal tail: ${stateSequence(written).join(' -> ')}`,
    )
  }
  // Beats stop -> the last deadline (+960s) lapses -> the next advance heals.
  h.deps.now = () => atOffset(1200)
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    resumeV2StateFromEvents(written),
    'running',
    `overnight hold never released after the beats stopped: ${stateSequence(written).join(' -> ')}`,
  )
})

test('PMR-422Q renewal guards: a foreign ref, an unarmed hold, and an idle loop are all no-ops (ISC-4)', async () => {
  // renewLiveWaitLease must not be able to arm, re-arm, or cross-contaminate:
  //   * FOREIGN REF: the beat is dropped, so the original +240s deadline still
  //     governs and the post-expiry advance self-heals.
  //   * UNARMED: a beat after the hold was released (here by the post-expiry
  //     running self-heal) must NOT resurrect it.
  //   * IDLE: a beat after a terminal transition (state null) must not throw.
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  const { fanout } = wireRealFanout(h, loop)
  await loop.start(startInput())
  await fanout.record({
    kind: 'state-change',
    at: atOffset(60),
    ref: 'TP-1',
    state: 'waiting_human',
    reason: 'human_ask_pending',
  })
  // Foreign ref (a sibling flow's ask beating the wrong loop) is a no-op: the
  // deadline stays at +240s, so the advance at now=+300s self-heals — proof the
  // beat never extended this run's lease.
  h.deps.now = () => atOffset(300)
  loop.renewLiveWaitLease('OTHER-1')
  h.labels = ['planned']
  await loop.onSettled()
  await flushFanout()
  assert.equal(
    stateSequence(h.v2).filter((s) => s === 'running').length,
    2,
    `a foreign-ref renewal extended this run's lease: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // UNARMED: the post-expiry running release above cleared flag + lease; a late
  // beat must not re-arm (the armed-guard). Prove it: the next machine wait
  // emits.
  h.inFlight = true
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_machine/subagent_in_flight'),
    `a late beat re-armed a released hold: ${stateSequence(h.v2).join(' -> ')}`,
  )
  loop.renewLiveWaitLease('TP-1')
  // If a beat could resurrect a released hold, this next DIFFERING wait would
  // be held and the assertion would go red.
  h.pendingAsk = true
  await loop.onSettled()
  await flushFanout()
  assert.ok(
    stateSequence(h.v2).includes('waiting_human/subagent_ask_pending'),
    `a late beat re-armed the hold: ${stateSequence(h.v2).join(' -> ')}`,
  )
  // IDLE: after a terminal halt the loop has no run state — the beat is inert.
  h.inFlight = false
  h.labels = []
  await loop.onSettled()
  await flushFanout()
  loop.renewLiveWaitLease('TP-1')
  const idle = createFlowLoop(h.deps)
  idle.renewLiveWaitLease('TP-1')
})
