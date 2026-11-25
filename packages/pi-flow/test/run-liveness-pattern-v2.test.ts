// AIDEV-NOTE: PMR-ZV9Y 3.2 — the liveness half of ISC-1's render requirement.
// flow/liveness.ts gates on the V1 loop status (`projectsRunning`), then pushes
// `buildPushBody(...)`, which renders the v1 frozen block plus the appended v2
// blocks (flow/run-health.ts blocks 10+). So a running ref's liveness re-render
// must carry `pi_flow_state{…state="running"}` without this pass having any v2
// logic of its own — that is the whole point of routing both push producers
// through the identical render seam (the PMR-8MQH invariant).
//
// Deliberately a NEW file: test/run-liveness.test.ts stays untouched and green
// (ISC-A-4). It owns the v1 liveness gates; this file only proves the v2 lines
// ride the same body. Fixtures follow the run-liveness.test.ts wired pattern —
// a REAL journal in a mkTmpDir agent dir, the engine on `createLivenessDeps`
// output, and a capturing `fakeFetch` — so the path exercised is journal read →
// projection gate → rollup → render → POST, not a mocked render.
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  createLivenessDeps,
  type LivenessDeps,
  runLivenessPassOnce,
} from '../flow/liveness.ts'
import type { PushFetch } from '../flow/push.ts'
import type { FlowPhase, FlowRunEvent, LoopRunStatus } from '../run-state.ts'
import { recordRunEventJournalOnly } from '../run-state.ts'
import { mkTmpDir } from './tmpdir.ts'

const REF = 'PMR-ZV9Y'
const URL = 'https://g:4479'
const T0 = '2026-11-25T06:00:00.000Z'

function shift(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString()
}

function agentDir(): string {
  return mkTmpDir('pi-flow-liveness-v2-')
}

interface FetchCall {
  url: string
  body: string
}

function fakeFetch() {
  const calls: FetchCall[] = []
  const fetchImpl: PushFetch = async (url, init) => {
    calls.push({ url, body: init.body })
    return { status: 202, statusText: 'Accepted' }
  }
  return { calls, fetchImpl }
}

function depsFor(dir: string, fetchImpl: PushFetch): LivenessDeps | null {
  return createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl,
  })
}

function loopState(
  at: string,
  status: LoopRunStatus,
  phase: FlowPhase = 'plan',
): FlowRunEvent {
  return {
    kind: 'loop-state',
    at,
    ref: REF,
    loop: {
      phase,
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status,
    },
  }
}

/** A personal-mode running journal: fresh (no cost evidence), so the liveness
 *  push is health-only — exactly the shape whose body this test pins. */
function runningV2Journal(): FlowRunEvent[] {
  return [
    { kind: 'run-start', at: T0, ref: REF, mode: 'personal' },
    loopState(shift(1), 'running', 'plan'),
    {
      kind: 'state-change',
      at: shift(1),
      ref: REF,
      state: 'running',
      reason: '',
    },
  ]
}

async function writeJournal(
  dir: string,
  events: readonly FlowRunEvent[],
): Promise<void> {
  for (const event of events) {
    await recordRunEventJournalOnly(dir, event)
  }
}

test('the liveness re-render of a running ref carries pi_flow_state{state="running"} (ISC-1)', async () => {
  const dir = agentDir()
  await writeJournal(dir, runningV2Journal())
  const { calls, fetchImpl } = fakeFetch()
  const deps = depsFor(dir, fetchImpl)
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 1, pushed: 1, skipped: 0, failed: 0 })
  assert.equal(calls.length, 1)
  const body = calls[0]?.body ?? ''
  // the v1 frozen line is still there, unmodified
  assert.ok(
    body.includes(`pi_flow_run_status{ref="${REF}",status="running"} 1`),
    `missing the v1 status line:\n${body}`,
  )
  // the v2 line rides the same body, appended after it
  assert.ok(
    body.includes(`pi_flow_state{ref="${REF}",state="running",reason=""} 1`),
    `missing the v2 state line:\n${body}`,
  )
  assert.ok(
    body.includes(
      `pi_flow_state_start_seconds{ref="${REF}",state="running",reason=""} ${Math.floor(Date.parse(shift(1)) / 1000)}`,
    ),
    `missing the v2 state-start line:\n${body}`,
  )
  assert.ok(
    body.includes(`pi_flow_phase{ref="${REF}",phase="plan"} 1`),
    `missing the v2 phase line:\n${body}`,
  )
  // v2 strictly after the v1 block
  assert.ok(
    body.indexOf('pi_flow_run_status') < body.indexOf('pi_flow_state{'),
    body,
  )
  // the exposition stays a valid Pushgateway body: newline-terminated, no
  // comment lines (the type-line rule).
  assert.ok(body.endsWith('\n'))
  assert.ok(!body.endsWith('\n\n'))
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    assert.ok(
      !line.startsWith('#'),
      `comment line in the liveness body: ${line}`,
    )
  }
})

test('a liveness re-render of a legacy running journal still gains the v2 state (ISC-6 through the daemon)', async () => {
  // No 'state-change' events: the v2 block comes from the loop-status fallback,
  // so a run journaled before this feature also shows v2 state to the boards.
  const dir = agentDir()
  await writeJournal(dir, [
    { kind: 'run-start', at: T0, ref: REF, mode: 'personal' },
    loopState(shift(1), 'running', 'validate'),
  ])
  const { calls, fetchImpl } = fakeFetch()
  const deps = depsFor(dir, fetchImpl)
  if (deps === null) throw new Error('expected wired deps')
  await runLivenessPassOnce(deps)
  const body = calls[0]?.body ?? ''
  assert.ok(
    body.includes(`pi_flow_state{ref="${REF}",state="running",reason=""} 1`),
    `missing the derived v2 state line:\n${body}`,
  )
})

test('the liveness pass never tombstones and never rewrites a v2 line', async () => {
  // `stale` is reconcile's job only; the liveness push re-renders the journal,
  // so a running ref's body must not carry a stale state line.
  const dir = agentDir()
  await writeJournal(dir, runningV2Journal())
  const { calls, fetchImpl } = fakeFetch()
  const deps = depsFor(dir, fetchImpl)
  if (deps === null) throw new Error('expected wired deps')
  await runLivenessPassOnce(deps)
  const body = calls[0]?.body ?? ''
  assert.ok(!body.includes('state="stale"'), body)
  assert.ok(!body.includes('status="stale"'), body)
})

test('a non-running ref is still skipped by the v1 gate, v2 lines or not', async () => {
  // ISC-3 of PMR-8MQH unchanged by 3.2: liveness gates on the v1 loop status,
  // so adding v2 lines must not make the daemon push a halted run's body.
  const dir = agentDir()
  await writeJournal(dir, [
    { kind: 'run-start', at: T0, ref: REF, mode: 'personal' },
    loopState(shift(1), 'halted', 'plan'),
    {
      kind: 'state-change',
      at: shift(1),
      ref: REF,
      state: 'halted',
      reason: 'label_miss',
    },
  ])
  const { calls, fetchImpl } = fakeFetch()
  const deps = depsFor(dir, fetchImpl)
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 1, pushed: 0, skipped: 1, failed: 0 })
  assert.deepEqual(calls, [])
})

test('the runs dir is not written by the v2 render (daemon never appends)', async () => {
  const dir = agentDir()
  await writeJournal(dir, runningV2Journal())
  const wanted = path.join(dir, 'pi-flow', 'runs')
  const before = readdirSync(wanted).sort()
  const { calls, fetchImpl } = fakeFetch()
  const deps = depsFor(dir, fetchImpl)
  if (deps === null) throw new Error('expected wired deps')
  await runLivenessPassOnce(deps)
  assert.equal(calls.length, 1)
  const after = readdirSync(wanted).sort()
  assert.deepEqual(after, before)
})
