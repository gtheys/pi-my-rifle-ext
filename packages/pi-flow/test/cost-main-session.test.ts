import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  buildMainRows,
  buildPushBody,
  collectMainSessionFiles,
  phaseWindows,
} from '../flow/cost.ts'
import { registerFlowCostCommand } from '../flow/cost-command.ts'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import type { FlowRunEvent } from '../run-state.ts'

const REF = 'TP-1'
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
  ev('2026-11-07T07:01:05.000Z', { kind: 'phase-start', phase: 'implement' }),
  ev('2026-11-07T07:01:05.100Z', { kind: 'main-session', sessionFile: FILE }),
  ev('2026-11-07T07:02:00.000Z', {
    kind: 'phase-complete',
    phase: 'implement',
    label: 'active',
  }),
  ev('2026-11-07T07:02:02.000Z', { kind: 'phase-start', phase: 'validate' }),
  ev('2026-11-07T07:03:00.000Z', {
    kind: 'phase-complete',
    phase: 'validate',
    label: 'review-passed',
  }),
]

function assistant(at: string, cost: number): unknown {
  return {
    type: 'message',
    timestamp: at,
    message: {
      role: 'assistant',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  }
}

const ENTRIES: unknown[] = [
  assistant('2026-11-07T06:59:00.000Z', 9), // before the flow: ignored
  assistant('2026-11-07T07:00:30.000Z', 0.1), // plan
  assistant('2026-11-07T07:01:02.000Z', 0.05), // after plan-complete, before implement: still plan
  assistant('2026-11-07T07:01:30.000Z', 0.2), // implement
  assistant('2026-11-07T07:02:30.000Z', 0.4), // validate
  assistant('2026-11-07T07:05:00.000Z', 9), // after the flow: ignored
  { type: 'message', message: { role: 'assistant' } }, // no timestamp: skipped
]

test('collectMainSessionFiles dedupes repeated journal entries', () => {
  assert.deepEqual(collectMainSessionFiles(EVENTS), [FILE])
})

test('phaseWindows: next phase-start closes a window; last ends at its phase-complete', () => {
  const w = phaseWindows(EVENTS)
  assert.deepEqual(
    w.map((x) => x.phase),
    ['plan', 'implement', 'validate'],
  )
  assert.equal(w[0].endMs, Date.parse('2026-11-07T07:01:05.000Z'))
  assert.equal(w[2].endMs, Date.parse('2026-11-07T07:03:00.000Z'))
  assert.deepEqual(phaseWindows([]), [])
})

test('buildMainRows splits main-session cost across phases by timestamp', () => {
  const rows = buildMainRows(EVENTS, new Map([[FILE, ENTRIES]]))
  const byPhase = new Map(rows.map((r) => [r.phase, r.summary.totals.cost]))
  assert.equal(rows.length, 3)
  assert.ok(Math.abs((byPhase.get('plan') ?? 0) - 0.15) < 1e-9)
  assert.ok(Math.abs((byPhase.get('implement') ?? 0) - 0.2) < 1e-9)
  assert.ok(Math.abs((byPhase.get('validate') ?? 0) - 0.4) < 1e-9)
  assert.ok(rows.every((r) => r.name === 'main' && r.subtask === null))
  assert.ok(rows.every((r) => r.sessionAvailable))
})

test('buildMainRows: unreadable session = one coverage-gap row, never a zero', () => {
  const rows = buildMainRows(EVENTS, new Map())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionAvailable, false)
  assert.equal(rows[0].phase, null)
})

test('buildMainRows: no main-session journal events = no rows (old runs unchanged)', () => {
  const old = EVENTS.filter((e) => e.kind !== 'main-session')
  assert.deepEqual(buildMainRows(old, new Map([[FILE, ENTRIES]])), [])
})

test('push body carries main rows as agent="main" per phase', () => {
  const rows = buildMainRows(EVENTS, new Map([[FILE, ENTRIES]]))
  const body = buildPushBody(REF, rows, [])
  const costLines = body
    .split('\n')
    .filter((l) => l.startsWith('pi_flow_run_cost_usd{'))
  assert.equal(costLines.length, 3)
  assert.ok(costLines.every((l) => l.includes('agent="main"')))
  assert.ok(costLines.some((l) => l.includes('phase="plan"')))
  assert.ok(costLines.some((l) => l.includes('phase="implement"')))
})

// ---- loop journals the main session file at every phase start
function harness() {
  const journal: Array<{ kind: string; sessionFile?: string }> = []
  const env: Record<string, string | undefined> = {}
  const deps: FlowLoopDeps = {
    notify: () => {},
    journal: (event) => {
      journal.push(event as never)
    },
    readLabels: async () => [],
    readPlanState: async () => null,
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: () => {},
    env,
  }
  return { journal, deps }
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

test('loop journals main-session at phase start when a session file is known', async () => {
  const h = harness()
  h.deps.getSessionFile = () => FILE
  await createFlowLoop(h.deps).start(START)
  const kinds = h.journal.map((e) => e.kind)
  assert.ok(kinds.indexOf('phase-start') < kinds.indexOf('main-session'))
  const ms = h.journal.find((e) => e.kind === 'main-session')
  assert.equal(ms?.sessionFile, FILE)
})

test('loop journals no main-session when the session file is unknown', async () => {
  const h = harness()
  h.deps.getSessionFile = () => null
  await createFlowLoop(h.deps).start(START)
  assert.equal(
    h.journal.some((e) => e.kind === 'main-session'),
    false,
  )
})

test('/flow-cost --push rolls up the main session even with zero worker spawns', async () => {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const pi = {
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, def)
    },
  } as unknown as ExtensionAPI
  const pushed: string[] = []
  registerFlowCostCommand(pi, {
    readRunEvents: async () => EVENTS,
    listAssignmentRecords: () => [],
    readSessionFile: (file) => {
      if (file !== FILE) return null
      return `${ENTRIES.map((e) => JSON.stringify(e)).join('\n')}\n`
    },
    push: async (_ref, body) => {
      pushed.push(body)
      return { ok: true }
    },
  })
  const notes: Array<{ message: string; level: string }> = []
  const ctx = {
    ui: {
      notify: (message: string, level: string) =>
        notes.push({ message, level }),
    },
  }
  const def = commands.get('flow-cost')
  assert.ok(def !== undefined)
  await def.handler(`${REF} --push`, ctx)
  assert.match(notes[0].message, /main/)
  assert.equal(
    notes.some((n) => /nothing to roll up/.test(n.message)),
    false,
  )
  assert.equal(pushed.length, 1)
  assert.equal(
    pushed[0].split('\n').filter((l) => l.startsWith('pi_flow_run_cost_usd{'))
      .length,
    3,
  )
})
