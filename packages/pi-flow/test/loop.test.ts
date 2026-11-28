import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import type { FlowRunEvent } from '../run-state.ts'

interface Harness {
  deps: FlowLoopDeps
  sent: string[]
  notes: { ref: string; text: string }[]
  events: FlowRunEvent[]
  notifications: { message: string; level: string }[]
  labels: string[] | null
  planState: string | null
  openChildren?: boolean
  inFlight?: boolean
  errorLabels: { ref: string; label: string }[]
  /** false = label write fails; 'throw' = the dep itself rejects. */
  errorLabelResult?: boolean | 'throw'
  // AIDEV-NOTE: PMR-B033 — removal-dep fake for the blocker route-back reset.
  // removedLabels records every (ref, label) the loop asked to remove; on
  // success the fake also strips the label from h.labels so the harness mirrors
  // real ticket state. removeLabelResult: false = removal fails, 'throw' = the
  // dep rejects, 'absent' = the test sets the dep key to undefined (fail-closed
  // matrix — an absent load-bearing dep must halt, never skip).
  removedLabels: { ref: string; label: string }[]
  removeLabelResult?: boolean | 'throw' | 'absent'
}

function makeHarness(labels: string[] | null = []): Harness {
  const h: Harness = {
    sent: [],
    notes: [],
    events: [],
    notifications: [],
    labels,
    planState: null,
    errorLabels: [],
    removedLabels: [],
    deps: undefined as unknown as FlowLoopDeps,
  }
  h.deps = {
    notify: (message, level) => {
      h.notifications.push({ message, level })
    },
    journal: (event) => {
      h.events.push(event)
    },
    readLabels: async () => h.labels,
    readPlanState: async () => h.planState,
    avenNote: async (ref, text) => {
      h.notes.push({ ref, text })
      return true
    },
    epicHasOpenChildren: async () => h.openChildren ?? false,
    hasInFlightSubagent: () => h.inFlight ?? false,
    avenLabel: async (ref, label) => {
      if (h.errorLabelResult === 'throw') {
        throw new Error('label write exploded')
      }
      const ok = h.errorLabelResult ?? true
      if (ok) h.errorLabels.push({ ref, label })
      return ok
    },
    // AIDEV-NOTE: PMR-B033 — mirrors real ticket state: a successful removal
    // strips the label from h.labels, so the next readLabels sees the reset.
    removeAvenLabel: async (ref, label) => {
      if (h.removeLabelResult === 'throw') {
        throw new Error('label removal exploded')
      }
      let ok = true
      if (h.removeLabelResult === false) {
        ok = false
      }
      if (ok) {
        h.removedLabels.push({ ref, label })
        h.labels = (h.labels ?? []).filter((l) => l !== label)
      }
      return ok
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
  workRoots: [],
}

function startInput() {
  return {
    ref: 'TP-1',
    phase: 'plan' as const,
    promptInput: { ...PROMPT_INPUT },
  }
}

function startYoloInput() {
  return {
    ref: 'TP-1',
    phase: 'plan' as const,
    promptInput: { ...PROMPT_INPUT, yolo: true },
  }
}

test('start: work-mode yolo is refused loudly and never starts', async () => {
  // PMR-ZRMQ — yolo is personal-only: the receipt-gate exemptions fire on
  // the journaled yolo bit regardless of mode, so a work-mode yolo run must
  // be refused at loop start (covers --yolo, config yolo, seed resumes).
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'plan',
    promptInput: { ...PROMPT_INPUT, mode: 'work', yolo: true },
    yolo: true,
  })
  assert.equal(loop.isActive(), false)
  assert.equal(h.sent.length, 0, 'no phase prompt sent')
  assert.equal(h.events.length, 0, 'nothing journaled')
  assert.equal(h.notifications.length, 1)
  assert.match(h.notifications[0].message, /personal-mode only/)
  assert.equal(h.notifications[0].level, 'warning')
})

test('start: personal-mode yolo still starts', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startYoloInput())
  assert.equal(loop.isActive(), true)
  assert.equal(h.sent.length, 1)
})

test('start: sends one phase prompt and awaits outcome', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /plan\.md|Plan phase/)
  assert.equal(loop.isActive(), true)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    // AIDEV-NOTE: PMR-T9ZQ 1.2 — every phase prompt journals a projected
    // owner-session refresh right after its phase-start.
    ['loop-state', 'phase-start', 'owner-session', 'loop-state'],
  )
})

test('start: journals a loop-state snapshot (running, awaitingOutcome=false)', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  const first = h.events[0]
  assert.equal(first.kind, 'loop-state')
  if (first.kind !== 'loop-state') return
  assert.deepEqual(first.loop, {
    phase: 'plan',
    awaitingOutcome: false,
    blockerRetries: 0,
    validateStartedAt: first.loop.validateStartedAt,
    status: 'running',
  })
})

test('settled with label landed: advances to the next phase prompt', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    [
      'loop-state',
      'phase-start',
      'owner-session',
      'loop-state',
      'phase-complete',
      'phase-start',
      'owner-session',
      'loop-state',
    ],
  )
})

test('settled without label: halt note, journal note, no advance', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.notes, [
    {
      ref: 'TP-1',
      text: 'flow halted at plan: phase completed without landing the "planned" label',
    },
  ])
  assert.equal(loop.isActive(), false)
  assert.equal(h.events.at(-1)?.kind, 'loop-state')
  const halted = h.events.at(-1)
  if (halted?.kind === 'loop-state') {
    assert.equal(halted.loop.status, 'halted')
    assert.equal(halted.loop.awaitingOutcome, false)
  }
  const noteEvent = h.events.at(-2)
  assert.equal(noteEvent?.kind, 'note')
})

test('settled after an aborted turn (label never landed): halts', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.match(h.notes[0].text, /without landing the "planned" label/)
})

test('settled without label but a subagent is in flight: stays armed, no halt, re-checks next settle', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.notes.length, 0)
  assert.equal(h.sent.length, 1)
  assert.equal(loop.isActive(), true)
  assert.equal(h.events.at(-1)?.kind, 'note')
  // child steers back, turn settles again with the label landed: advances
  h.inFlight = false
  h.labels = ['planned']
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
})

test('settled without label once the subagent is gone: halts', async () => {
  const h = makeHarness([])
  h.inFlight = true
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(loop.isActive(), true)
  h.inFlight = false
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /without landing the "planned" label/)
})

test('plan settles without "planned" while plan-state=review: awaiting-approval pause, no failure halt', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.equal(h.sent.length, 1) // no implement prompt
  assert.equal(loop.isActive(), false)
  assert.equal(h.notes.length, 1)
  assert.match(h.notes[0].text, /awaiting spec approval/)
  assert.match(h.notes[0].text, /\/flow answer .* approve/)
  assert.doesNotMatch(h.notes[0].text, /halted/)
  const last = h.notifications.at(-1)
  assert.equal(last?.level, 'info')
  assert.match(last?.message ?? '', /awaiting spec approval/)
  // PMR-R5VB: the pause notify directs the human to the human-only answer
  // command; the loop journals a 'note' event for it.
  assert.match(last?.message ?? '', /\/flow answer .* approve/)
  const noteEvent = h.events.find((e) => e.kind === 'note')
  assert.ok(noteEvent, 'plan pause must journal a note event')
  // PMR-XTQQ: the pause ALSO journals a paused loop-state snapshot (the last
  // event — resume seeding and the pending protocol read the latest
  // snapshot); the pending protocol parks ONLY on awaitingOutcome=true +
  // running, so the snapshot must carry awaitingOutcome=false.
  const paused = h.events.at(-1)
  assert.equal(paused?.kind, 'loop-state')
  if (paused?.kind === 'loop-state') {
    assert.equal(paused.loop.status, 'paused')
    assert.equal(paused.loop.awaitingOutcome, false)
  }
})

test('done: journals a terminal loop-state snapshot', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed', 'done'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ...startInput(),
    phase: 'feedback',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  await loop.onSettled()
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'done')
})

test('resume seed honored: budget and validateStartedAt restored exactly', async () => {
  const h = makeHarness(['planned', 'active'])
  const cutoff = '2026-11-14T10:00:00.000Z'
  let seenSince: string | null = null
  h.deps.hasFreshBlockers = async (_ref, sinceIso) => {
    seenSince = sinceIso
    return false
  }
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ...startInput(),
    phase: 'validate',
    resume: { blockerRetries: 2, validateStartedAt: cutoff },
  })
  await loop.onSettled()
  assert.equal(seenSince, cutoff)
})

test('retry increments survive a simulated restart via the journal', async () => {
  const h = makeHarness(['planned', 'active'])
  h.deps.hasFreshBlockers = async () => true
  const loop = createFlowLoop(h.deps)
  // restart with a seeded budget of 2 — one more blocker retry is allowed
  await loop.start({
    ...startInput(),
    phase: 'validate',
    resume: {
      blockerRetries: 2,
      validateStartedAt: new Date().toISOString(),
    },
  })
  await loop.onSettled() // retry 3rd attempt blocked -> budget exhausted halt
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'halted')
  assert.match(h.notes[0].text, /budget exhausted/)
})

test('retry snapshot journals the incremented budget', async () => {
  const h = makeHarness(['planned', 'active'])
  h.deps.hasFreshBlockers = async () => true
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled() // retry 1 -> implement re-sent
  const retrySnapshots = h.events.filter(
    (e) => e.kind === 'loop-state' && e.loop.blockerRetries === 1,
  )
  assert.equal(retrySnapshots.length >= 1, true)
  assert.equal(loop.isActive(), true)
})

test('plan settles without label and plan-state not in review: failure halt as before', async () => {
  const h = makeHarness([])
  h.planState = 'approved'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.match(
    h.notes[0].text,
    /flow halted at plan: phase completed without landing the "planned" label/,
  )
})

test('plan settles without label and plan-state read fails (null): failure halt, gate never triggers', async () => {
  const h = makeHarness([])
  h.planState = null
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.match(
    h.notes[0].text,
    /flow halted at plan: phase completed without landing the "planned" label/,
  )
})

test('resume after approval: /flow re-enters plan, refreshed prompt run lands the label and completes the phase', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'plan' })
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  // spec approved meanwhile (plan-state=approved); a later /flow re-enters plan
  h.planState = 'approved'
  await loop.start({ ...startInput(), phase: 'plan' })
  assert.match(h.sent.at(-1) ?? '', /plan\.md|Plan phase/)
  h.labels = ['planned'] // refreshed plan prompt run lands "planned"
  await loop.onSettled()
  assert.match(h.sent.at(-1) ?? '', /Implement phase/)
  assert.deepEqual(
    h.events.map((e) => e.kind),
    [
      'loop-state',
      'phase-start',
      'owner-session',
      'loop-state',
      'note',
      'loop-state',
      'loop-state',
      'phase-start',
      'owner-session',
      'loop-state',
      'phase-complete',
      'phase-start',
      'owner-session',
      'loop-state',
    ],
  )
})

test('settled with aven failure: halts fail-closed', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  h.labels = null
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.match(h.notes[0].text, /cannot read aven labels/)
})

test('settled when idle: ignored (side conversations never advance the flow)', async () => {
  const h = makeHarness(['planned'])
  const loop = createFlowLoop(h.deps)
  await loop.onSettled()
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  await loop.start(startInput())
  h.labels = ['planned']
  await loop.onSettled()
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
})

test('final phase complete: flow done, loop inactive', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed', 'done'])
  const loop = createFlowLoop(h.deps)
  await loop.start({
    ...startInput(),
    phase: 'feedback',
    promptInput: { ...PROMPT_INPUT, mode: 'work' },
  })
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.equal(loop.isActive(), false)
  assert.equal(
    h.notifications.some((n) => n.message.includes('all phases complete')),
    true,
  )
})

test('implement gate block at start: halt note, nothing sent', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'implement' })
  assert.equal(h.sent.length, 0)
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /flow halted at implement/)
})

test('implement injection with open epic children forces the plan route', async () => {
  const h = makeHarness(['planned'])
  h.openChildren = true
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'implement' })
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0], /implement-plan-aven/)
  assert.match(h.sent[0], /Route: plan/)
})

// PMR-VZEV: start resets the landing state so stale authorization (or a
// stale human code-review pass marker) cannot leak into a later flow.
test('start: resets the landing state (authorized + humanReviewPassed)', async () => {
  const h = makeHarness([])
  let resets = 0
  h.deps.resetLandingState = () => {
    resets += 1
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(resets, 1)
  await loop.start({ ...startInput(), ref: 'TP-2' })
  assert.equal(resets, 2)
})

test('start: works without an optional resetLandingState dep', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  assert.equal(loop.isActive(), true)
})

test('personal: review-passed after validate advances into the feedback wrap-up (PMR-81SX)', async () => {
  const h = makeHarness(['planned', 'active', 'review-passed'])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled()
  // Loop stays active and injects the personal feedback wrap-up prompt.
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Feedback phase/)
  assert.match(h.sent[1], /Mode: personal/)
  assert.equal(loop.isActive(), true)
  // Done only after the feedback phase label ("done") lands.
  h.labels = ['planned', 'active', 'review-passed', 'done']
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.equal(loop.isActive(), false)
})

const DONE_LABELS = ['planned', 'active', 'review-passed', 'done']

function startDone(mode: 'work' | 'personal' = 'work') {
  return {
    ...startInput(),
    phase: 'feedback' as const,
    promptInput: { ...PROMPT_INPUT, mode },
  }
}

// PMR-81SX: onFlowDone must fire exactly once in the done branch, AFTER the
// onRunEnd teardown callbacks. A shared log pins the call order.
test('done: onFlowDone called once with (ref, mode, worktree), after onRunEnd', async () => {
  const h = makeHarness(DONE_LABELS)
  const order: string[] = []
  h.deps.onRunEnd = (ref) => {
    order.push(`onRunEnd:${ref}`)
  }
  h.deps.onFlowDone = async (ref, mode, worktree) => {
    order.push(`onFlowDone:${ref}:${mode}:${worktree?.path}`)
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startDone())
  // Bind a worktree BEFORE settling so the done branch captures it pre-teardown.
  setActiveFlowRef('TP-1')
  setFlowWorktree('/tmp/wt-done', 'feat/x')
  await loop.onSettled()
  assert.deepEqual(order, [
    'onRunEnd:TP-1',
    'onFlowDone:TP-1:work:/tmp/wt-done',
  ])
  assert.equal(loop.isActive(), false)
  setActiveFlowRef(null)
})

// yolo 5.1: yolo halt applies the `error` label before the terminal snapshot
test('yolo halt: applies the error label before the terminal snapshot', async () => {
  const h = makeHarness([])
  const order: string[] = []
  h.deps.journal = (event) => {
    h.events.push(event)
    if (event.kind === 'loop-state') order.push(`snapshot:${event.loop.status}`)
  }
  h.deps.avenLabel = async (ref, label) => {
    order.push(`label:${label}:${ref}`)
    h.errorLabels.push({ ref, label })
    return true
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startYoloInput())
  await loop.onSettled() // no label -> halt
  assert.deepEqual(order.slice(-2), ['label:error:TP-1', 'snapshot:halted'])
  assert.deepEqual(h.errorLabels, [{ ref: 'TP-1', label: 'error' }])
  assert.equal(loop.isActive(), false)
})

test('non-yolo halt: never applies the error label', async () => {
  const h = makeHarness([])
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // no label -> halt
  assert.deepEqual(h.errorLabels, [])
  assert.equal(loop.isActive(), false)
})

test('yolo halt with failing label write: still halts cleanly', async () => {
  const h = makeHarness([])
  h.errorLabelResult = false
  const loop = createFlowLoop(h.deps)
  await loop.start(startYoloInput())
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  const last = h.events.at(-1)
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'halted')
})

test('yolo halt with throwing label dep: still halts cleanly', async () => {
  const h = makeHarness([])
  h.errorLabelResult = 'throw'
  const loop = createFlowLoop(h.deps)
  await loop.start(startYoloInput())
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  const last = h.events.at(-1)
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'halted')
})

test('halt: onRunEnd fires but onFlowDone is never called', async () => {
  const h = makeHarness([])
  const order: string[] = []
  h.deps.onRunEnd = (ref) => {
    order.push(`onRunEnd:${ref}`)
  }
  h.deps.onFlowDone = async () => {
    order.push('onFlowDone')
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // no label -> halt
  assert.deepEqual(order, ['onRunEnd:TP-1'])
  assert.equal(loop.isActive(), false)
})

test('plan-approval pause: onRunEnd fires, onFlowDone is never called', async () => {
  const h = makeHarness([])
  h.planState = 'review'
  const order: string[] = []
  h.deps.onRunEnd = (ref) => {
    order.push(`onRunEnd:${ref}`)
  }
  h.deps.onFlowDone = async () => {
    order.push('onFlowDone')
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled() // paused awaiting approval
  assert.deepEqual(order, ['onRunEnd:TP-1'])
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /awaiting spec approval/)
})

test('done without an onFlowDone dep: run still ends done, unaffected', async () => {
  const h = makeHarness(DONE_LABELS)
  const loop = createFlowLoop(h.deps)
  await loop.start(startDone())
  await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.equal(
    h.notifications.some((n) => n.message.includes('all phases complete')),
    true,
  )
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'done')
})

test('done with a throwing onFlowDone: run still ends done, error never surfaces', async () => {
  const h = makeHarness(DONE_LABELS)
  const order: string[] = []
  h.deps.onRunEnd = () => {
    order.push('onRunEnd')
  }
  h.deps.onFlowDone = async () => {
    order.push('onFlowDone')
    throw new Error('cleanup exploded')
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startDone())
  await loop.onSettled() // must not reject
  assert.deepEqual(order, ['onRunEnd', 'onFlowDone'])
  assert.equal(loop.isActive(), false)
  assert.equal(
    h.notifications.some((n) => n.message.includes('all phases complete')),
    true,
  )
  const kinds = h.events.map((e) => e.kind)
  assert.equal(kinds.includes('note'), true) // flow-complete note intact
  const last = h.events.at(-1)
  assert.equal(last?.kind, 'loop-state')
  if (last?.kind === 'loop-state') assert.equal(last.loop.status, 'done')
})

test('personal done: onFlowDone receives mode=personal and the captured worktree', async () => {
  const h = makeHarness(DONE_LABELS)
  let seen: { ref: string; mode: string; worktree: unknown } | null = null
  h.deps.onFlowDone = async (ref, mode, worktree) => {
    seen = { ref, mode, worktree }
  }
  const loop = createFlowLoop(h.deps)
  await loop.start(startDone('personal'))
  setActiveFlowRef('TP-1')
  setFlowWorktree('/tmp/wt-personal', 'feat/y')
  await loop.onSettled()
  assert.deepEqual(seen, {
    ref: 'TP-1',
    mode: 'personal',
    worktree: { ref: 'TP-1', path: '/tmp/wt-personal', branch: 'feat/y' },
  })
  assert.equal(loop.isActive(), false)
  setActiveFlowRef(null)
})

// PMR-69V8: extension-driven route-back on review blockers.
function blockersHarness(blockers: boolean[]) {
  const h = makeHarness(['planned', 'active'])
  const queue = [...blockers]
  h.deps.hasFreshBlockers = async () => queue.shift() ?? false
  return h
}

test('validate settled with fresh blockers: re-injects implement prompt', async () => {
  const h = blockersHarness([true])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled()
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
  assert.equal(loop.isActive(), true)
  assert.equal(h.notes.length, 0)
})

// AIDEV-NOTE: PMR-B033 — the blocker route-back must reset the implement
// completion gate: the stale 'active' label from the previous round may never
// auto-complete the fix round. Before the fix this test was red — the second
// settle found 'active' still present and advanced within the same tick.
test('blocker route-back resets the gate: fix round never auto-completes on the stale implement label', async () => {
  const h = blockersHarness([true])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled() // validate settles with blockers -> route back
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1], /Implement phase/)
  // ISC-1: the route-back removed the stale implement label first.
  assert.deepEqual(h.removedLabels, [{ ref: 'TP-1', label: 'active' }])
  assert.deepEqual(h.labels, ['planned'])
  // ISC-2: the fix round settles WITHOUT re-completion -> no premature
  // phase-complete(implement); the loop halts instead of advancing.
  await loop.onSettled()
  const premature = h.events.filter(
    (e) => e.kind === 'phase-complete' && e.phase === 'implement',
  )
  assert.equal(
    premature.length,
    0,
    'stale label must not complete the fix round',
  )
  assert.equal(loop.isActive(), false)
  // AIDEV-NOTE: PMR-85V1 — pin the halt to the label_miss path: isActive()
  // alone would also pass on any other halt reason (e.g. aven_read_failed).
  assert.match(
    h.notes[0].text,
    /flow halted at implement: phase completed without landing the "active" label/,
  )
})

test('validate blockers persist: halts after the retry budget', async () => {
  // AIDEV-NOTE: PMR-B033 — deliberately rewritten: the old sequence relied on
  // the bug (a fix-round settle auto-advancing on the stale label). The route-
  // back now resets the gate, so each fix round must simulate the agent
  // re-completing implement (re-landing 'active') before its settle.
  const h = blockersHarness([true, true, true])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled() // retry 1 -> gate reset, implement sent
  h.labels = ['planned', 'active'] // fix round re-completes implement
  await loop.onSettled() // implement settled -> validate sent
  await loop.onSettled() // retry 2 -> gate reset, implement sent
  h.labels = ['planned', 'active'] // fix round re-completes implement
  await loop.onSettled() // implement settled -> validate sent
  const before = h.sent.length
  await loop.onSettled() // budget exhausted -> halt
  assert.equal(h.sent.length, before)
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /budget exhausted/)
})

test('validate settled without blockers: plain halt, no retry', async () => {
  const h = blockersHarness([false])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled()
  assert.equal(h.sent.length, 1)
  assert.equal(loop.isActive(), false)
  assert.match(h.notes[0].text, /without landing/)
})

test('hasBlockersNoteSince: only fresh notes with reviewed-at count', async () => {
  const { hasBlockersNoteSince } = await import('../aven/client.ts')
  const out = [
    'note id=A created=2026-01-01T00:00:00Z',
    'body<<EOF',
    'blocker x\nreviewed-at: abc',
    'EOF',
    'note id=B created=2026-01-02T00:00:00Z',
    'body<<EOF',
    'plain note',
    'EOF',
  ].join('\n')
  assert.equal(hasBlockersNoteSince(out, '2025-12-31T00:00:00Z'), true)
  assert.equal(hasBlockersNoteSince(out, '2026-01-01T12:00:00Z'), false)
  assert.equal(hasBlockersNoteSince('', '2026-01-01T00:00:00Z'), false)
})

test('retry prompt points the agent at the reviewed-at blockers note', async () => {
  const h = blockersHarness([true])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled()
  assert.match(h.sent[1], /FIX ROUND/)
  assert.match(h.sent[1], /reviewed-at:/)
  assert.ok(h.notifications.some((n) => /re-running implement/.test(n.message)))
})

test('hasBlockersNoteSince: error text and pasted note ids in bodies do not break it', async () => {
  const { hasBlockersNoteSince } = await import('../aven/client.ts')
  const out = [
    'note id=A created=2026-01-01T00:00:00Z',
    'body<<EOF',
    'Error: test failed',
    'note id=Z created=2020-01-01T00:00:00Z',
    'reviewed-at: abc',
    'EOF',
  ].join('\n')
  assert.equal(hasBlockersNoteSince(out, '2025-12-31T00:00:00Z'), true)
})

// --- PMR-B033: gate-reset matrix. ISC-3 (genuine re-completion advances),
// ISC-4/ISC-5 (a failed reset halts fail-closed and consumes no retry),
// ISC-8 (the fix-round suffix tells the agent to re-call the gate tool). ---

test('PMR-B033 ISC-3: re-completed fix round lands phase-complete(implement) and re-enters validate', async () => {
  const h = blockersHarness([true, false])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled() // route-back: gate reset, implement prompt sent
  assert.deepEqual(h.labels, ['planned'])
  h.labels = ['planned', 'active'] // agent re-called flow_phase_complete
  await loop.onSettled() // implement settled -> phase-complete + validate
  const done = h.events.filter(
    (e) => e.kind === 'phase-complete' && e.phase === 'implement',
  )
  assert.equal(done.length, 1, 'exactly one genuine implement completion')
  assert.equal(h.sent.length, 3)
  assert.match(h.sent[2], /Validate phase/)
  assert.equal(loop.isActive(), true)
})

// Fail-closed matrix: dep returns false, dep throws, dep absent — each must
// halt with the stale-label note, send no implement prompt, and leave the
// blocker budget untouched (no retry note, no increment).
const RESET_FAILURES: (boolean | 'throw' | 'absent')[] = [
  false,
  'throw',
  'absent',
]
for (const mode of RESET_FAILURES) {
  test(`PMR-B033 ISC-4/ISC-5: failed gate reset (${String(mode)}) halts fail-closed and consumes no retry`, async () => {
    const h = blockersHarness([true])
    if (mode === 'absent') {
      h.deps.removeAvenLabel = undefined
    } else {
      h.removeLabelResult = mode
    }
    const loop = createFlowLoop(h.deps)
    await loop.start({ ...startInput(), phase: 'validate' })
    await loop.onSettled() // route-back attempt -> reset fails -> halt
    assert.equal(h.sent.length, 1, 'implement prompt must NOT be re-injected')
    assert.equal(loop.isActive(), false)
    assert.equal(h.removedLabels.length, 0)
    assert.match(h.notes[0].text, /stale "active" label/)
    assert.match(h.notes[0].text, /rerun \/flow TP-1/)
    const retryNotes = h.events.filter(
      (e) => e.kind === 'note' && /re-running implement/.test(e.text),
    )
    assert.equal(retryNotes.length, 0, 'a failed reset consumes no retry')
  })
}

test('PMR-B033 ISC-8: fix-round suffix tells the agent to re-call flow_phase_complete', async () => {
  const h = blockersHarness([true])
  const loop = createFlowLoop(h.deps)
  await loop.start({ ...startInput(), phase: 'validate' })
  await loop.onSettled()
  assert.match(h.sent[1], /RESETS the phase-completion gate/)
  assert.match(h.sent[1], /flow_phase_complete/)
})
