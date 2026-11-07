import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCostAutoPush } from '../flow/cost-autopush.ts'
import type { FlowCostDeps } from '../flow/cost-command.ts'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import type { FlowRunEvent } from '../run-state.ts'

const REF = 'TP-9'
const FILE = '/s/2026-11-07T07-00-00-000Z_aaaaaaaa-bbbb.jsonl'

function ev(at: string, rest: object): FlowRunEvent {
  return { at, ref: REF, ...rest } as FlowRunEvent
}

const EVENTS: FlowRunEvent[] = [
  ev('2026-11-07T07:00:00.000Z', { kind: 'run-start', mode: 'personal' }),
  ev('2026-11-07T07:00:00.100Z', { kind: 'phase-start', phase: 'plan' }),
  ev('2026-11-07T07:00:00.200Z', { kind: 'main-session', sessionFile: FILE }),
  ev('2026-11-07T07:01:00.000Z', {
    kind: 'phase-complete',
    phase: 'plan',
    label: 'planned',
  }),
]

const SESSION = `${JSON.stringify({
  type: 'message',
  timestamp: '2026-11-07T07:00:30.000Z',
  message: {
    role: 'assistant',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
  },
})}\n`

function setup(over: {
  enabled?: boolean
  events?: FlowRunEvent[] | null
  pushOk?: boolean
  pushThrows?: boolean
}) {
  const pushed: Array<{ ref: string; body: string }> = []
  const notes: Array<{ message: string; level: string }> = []
  let journalReads = 0
  const base: FlowCostDeps = {
    readRunEvents: async () => {
      journalReads += 1
      if (over.events === undefined) return EVENTS
      return over.events
    },
    listAssignmentRecords: () => [],
    readSessionFile: (f) => {
      if (f === FILE) return SESSION
      return null
    },
    push: async (ref, body) => {
      if (over.pushThrows) throw new Error('boom')
      pushed.push({ ref, body })
      if (over.pushOk === false) return { ok: false, error: 'HTTP 503' }
      return { ok: true }
    },
  }
  const run = createCostAutoPush({
    ...base,
    enabled: () => over.enabled !== false,
    notify: (message, level) => notes.push({ message, level }),
    settle: async () => {},
  })
  return { run, pushed, notes, reads: () => journalReads }
}

test('auto push: rolls up the main session and pushes cost per phase', async () => {
  const t = setup({})
  await t.run(REF)
  assert.equal(t.pushed.length, 1)
  assert.equal(t.pushed[0].ref, REF)
  assert.match(t.pushed[0].body, /pi_flow_run_cost_usd\{[^}]*agent="main"/)
  assert.match(t.pushed[0].body, /phase="plan"/)
  assert.equal(t.notes.length, 1)
  assert.equal(t.notes[0].level, 'info')
})

test('auto push: disabled (no gateway URL) does nothing, not even a journal read', async () => {
  const t = setup({ enabled: false })
  await t.run(REF)
  assert.equal(t.pushed.length, 0)
  assert.equal(t.notes.length, 0)
  assert.equal(t.reads(), 0)
})

test('auto push: no journal / nothing to roll up stays silent', async () => {
  const none = setup({ events: null })
  await none.run(REF)
  assert.equal(none.pushed.length + none.notes.length, 0)
  const old = setup({
    events: EVENTS.filter((e) => e.kind !== 'main-session'),
  })
  await old.run(REF)
  assert.equal(old.pushed.length + old.notes.length, 0)
})

test('auto push: gateway failure warns with the retry command, never throws', async () => {
  const failed = setup({ pushOk: false })
  await failed.run(REF)
  assert.equal(failed.notes.length, 1)
  assert.equal(failed.notes[0].level, 'warning')
  assert.match(failed.notes[0].message, /HTTP 503/)
  assert.match(failed.notes[0].message, /\/flow-cost TP-9 --push/)

  const thrown = setup({ pushThrows: true })
  await thrown.run(REF)
  assert.equal(thrown.notes[0].level, 'warning')
  assert.match(thrown.notes[0].message, /boom/)
})

// ---- the loop signals every terminal transition
function loopHarness(labels: string[] | null) {
  const ended: string[] = []
  const env: Record<string, string | undefined> = {}
  const deps: FlowLoopDeps = {
    notify: () => {},
    journal: () => {},
    readLabels: async () => labels,
    readPlanState: async () => null,
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: () => {},
    env,
    onRunEnd: (ref) => {
      ended.push(ref)
    },
  }
  return { ended, deps, env }
}

const START = {
  ref: REF,
  phase: 'plan' as const,
  promptInput: {
    mode: 'personal' as const,
    ref: REF,
    gitRoot: '/home/x/repo',
    workRoots: [],
  },
}

test('loop: onRunEnd fires on halt, after the flow env is cleared', async () => {
  const h = loopHarness(null) // aven failure -> fail-closed halt
  const loop = createFlowLoop(h.deps)
  await loop.start(START)
  await loop.onSettled()
  // fires once even though both start and settle can observe the halt
  assert.deepEqual(h.ended, [REF])
  assert.equal(h.env.PI_FLOW_REF, undefined)
})

test('loop: onRunEnd fires on run completion, exactly once', async () => {
  const h = loopHarness(['planned', 'active', 'review-passed'])
  const loop = createFlowLoop(h.deps)
  await loop.start(START)
  for (let i = 0; i < 6 && loop.isActive(); i++) await loop.onSettled()
  assert.equal(loop.isActive(), false)
  assert.deepEqual(h.ended, [REF])
})
