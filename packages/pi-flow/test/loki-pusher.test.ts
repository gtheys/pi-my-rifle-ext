// AIDEV-NOTE: PMR-ZV9Y 4.2 — Loki pusher tests. Deliberately a NEW file (the
// additive-test rule): the pusher posture mirrors telemetry/exporter.ts but is
// exercised in isolation here, so telemetry.test.ts keeps guarding the OTLP
// change. Mocks fetch via the injected LokiFetch seam (no live endpoint — D2:
// the user exposes Loki themselves, NOT reachable yet), so every assertion is
// pure unit: URL, body, label hygiene, ns-timestamp derivation and the
// fail-silent / at-most-one-note-per-process contract.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildLokiPushBody,
  buildLokiStream,
  LOKI_JOB,
  LOKI_PUSH_PATH,
  type LokiFetch,
  type LokiLabels,
  type LokiPushDeps,
  lokiTimestampNs,
  pushLoki,
  pushLokiEvent,
} from '../telemetry/loki.ts'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function capturingFetch(out: { calls: Captured[] }, status = 204): LokiFetch {
  return async (url, init) => {
    out.calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
    return { status }
  }
}

const ISO = '2026-11-25T08:50:45.123Z'
// Nanoseconds are built by appending the ms epoch to six zeros — `ms * 1e6`
// would overflow Number.MAX_SAFE_INTEGER (~1.7e18) and silently lose low-order
// digits, corrupting the Loki entry timestamp. The pusher does the same.
const ISO_NS = `${Date.parse(ISO)}000000`
const NOW_MS = 1_700_000_000_000
const NOW_NS = '1700000000000000000'
const EVENT_LINE = JSON.stringify({
  kind: 'state-change',
  ref: 'PMR-A',
  at: ISO,
})

test('buildLokiStream: job fixed, only the closed enum set rides', () => {
  const labels: LokiLabels = {
    flow_ref: 'PMR-ZV9Y',
    mode: 'personal',
    phase: 'plan',
    state: 'waiting_human',
    reason: 'spec_approval_pending',
    wait_kind: 'human',
    kind: 'state-change',
  }
  assert.deepEqual(buildLokiStream(labels), {
    job: LOKI_JOB,
    flow_ref: 'PMR-ZV9Y',
    mode: 'personal',
    phase: 'plan',
    state: 'waiting_human',
    reason: 'spec_approval_pending',
    wait_kind: 'human',
    kind: 'state-change',
  })
})

test('buildLokiStream: empty/absent/out-of-set values never become labels (ISC-A-1)', () => {
  // reason is materialised '' by the journal for reasonless states — the
  // builder drops it; `note` is free text and is ignored even if a caller
  // (wrongly) passes it. The closed set is the only thing that survives.
  const labels = {
    flow_ref: 'DP-71',
    mode: 'work',
    state: 'running',
    reason: '',
    note: 'halt prose must NEVER be a label',
  } as unknown as LokiLabels
  assert.deepEqual(buildLokiStream(labels), {
    job: LOKI_JOB,
    flow_ref: 'DP-71',
    mode: 'work',
    state: 'running',
  })
})

test('buildLokiPushBody: single stream, one [[ns, line]] value tuple', () => {
  const body = buildLokiPushBody(
    { flow_ref: 'PMR-A', state: 'done', kind: 'state-change' },
    EVENT_LINE,
    ISO_NS,
  )
  const parsed = JSON.parse(body) as {
    streams: Array<{ stream: Record<string, string>; values: string[][] }>
  }
  assert.equal(parsed.streams.length, 1)
  assert.equal(parsed.streams[0].stream.job, LOKI_JOB)
  assert.equal(parsed.streams[0].stream.state, 'done')
  assert.deepEqual(parsed.streams[0].values, [[ISO_NS, EVENT_LINE]])
})

test('lokiTimestampNs: ISO at → exact epoch-nanos; absent/bad → now fallback', () => {
  assert.equal(lokiTimestampNs(ISO, NOW_MS), ISO_NS)
  assert.equal(lokiTimestampNs(undefined, NOW_MS), NOW_NS)
  assert.equal(lokiTimestampNs('not-a-date', NOW_MS), NOW_NS)
})

test('pushLoki: POSTs to <endpoint>/loki/api/v1/push with content-type + headers', async () => {
  const out = { calls: [] as Captured[] }
  const outcome = await pushLoki(
    'http://100.108.226.64:3100/',
    { authorization: 'Bearer x' },
    {
      flow_ref: 'PMR-A',
      state: 'halted',
      reason: 'escalation',
      kind: 'state-change',
    },
    EVENT_LINE,
    ISO_NS,
    capturingFetch(out, 204),
  )
  assert.equal(outcome.ok, true)
  assert.equal(out.calls.length, 1)
  // trailing slash on the endpoint is stripped, push path appended once.
  assert.equal(out.calls[0].url, `http://100.108.226.64:3100${LOKI_PUSH_PATH}`)
  assert.equal(out.calls[0].method, 'POST')
  assert.equal(out.calls[0].headers['content-type'], 'application/json')
  assert.equal(out.calls[0].headers.authorization, 'Bearer x')
  const parsed = JSON.parse(out.calls[0].body) as {
    streams: Array<{ stream: Record<string, string> }>
  }
  assert.equal(parsed.streams[0].stream.reason, 'escalation')
})

test('pushLoki: non-2xx maps to {ok:false} (never throws)', async () => {
  const out = { calls: [] as Captured[] }
  const outcome = await pushLoki(
    'http://100.108.226.64:3100',
    {},
    { state: 'running' },
    '{}',
    ISO_NS,
    capturingFetch(out, 500),
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /500/)
})

test('pushLoki: a throwing fetch maps to {ok:false} (never throws)', async () => {
  const throwing: LokiFetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  const outcome = await pushLoki(
    'http://100.108.226.64:3100',
    {},
    { state: 'running' },
    '{}',
    ISO_NS,
    throwing,
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.error ?? '', /ECONNREFUSED/)
})

test('pushLoki: a hanging fetch is aborted by the timeout and maps to {ok:false}', async () => {
  const aborting: LokiFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(init.signal.reason ?? new Error('aborted'))
      })
    })
  const outcome = await pushLoki(
    'http://100.108.226.64:3100',
    {},
    { state: 'running' },
    '{}',
    ISO_NS,
    aborting,
    5,
  )
  assert.equal(outcome.ok, false)
})

test('pushLokiEvent: disabled settings (null) → zero fetch calls', () => {
  const out = { calls: [] as Captured[] }
  const notes: string[] = []
  const deps: LokiPushDeps = {
    fetchImpl: capturingFetch(out),
    now: () => NOW_MS,
    state: { noted: false },
    onNote: (error) => notes.push(error),
  }
  pushLokiEvent(null, { state: 'running' }, EVENT_LINE, deps)
  assert.equal(out.calls.length, 0)
  assert.equal(notes.length, 0)
})

test('pushLokiEvent: endpoint-less settings → zero fetch calls', () => {
  const out = { calls: [] as Captured[] }
  const notes: string[] = []
  const deps: LokiPushDeps = {
    fetchImpl: capturingFetch(out),
    now: () => NOW_MS,
    state: { noted: false },
    onNote: (error) => notes.push(error),
  }
  pushLokiEvent({ endpoint: '' }, { state: 'running' }, EVENT_LINE, deps)
  assert.equal(out.calls.length, 0)
  assert.equal(notes.length, 0)
})

test('pushLokiEvent: success pushes once, notes nothing', async () => {
  const out = { calls: [] as Captured[] }
  const notes: string[] = []
  const deps: LokiPushDeps = {
    fetchImpl: capturingFetch(out, 204),
    now: () => NOW_MS,
    state: { noted: false },
    onNote: (error) => notes.push(error),
  }
  pushLokiEvent(
    { endpoint: 'http://h:3100' },
    { state: 'running' },
    EVENT_LINE,
    deps,
  )
  assert.equal(out.calls.length, 1)
  assert.equal(out.calls[0].url, `http://h:3100${LOKI_PUSH_PATH}`)
  // The pushed body used the event's own `at` (ISO), not the wall clock.
  assert.match(out.calls[0].body, new RegExp(ISO_NS))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notes.length, 0)
})

test('pushLokiEvent: fire-and-forget failures note at most once per process', async () => {
  const out = { calls: [] as Captured[] }
  const notes: string[] = []
  const deps: LokiPushDeps = {
    fetchImpl: capturingFetch(out, 500),
    now: () => NOW_MS,
    state: { noted: false },
    onNote: (error) => notes.push(error),
  }
  // Three failing pushes on one shared process state → exactly one note.
  pushLokiEvent(
    { endpoint: 'http://h:3100' },
    { state: 'running' },
    EVENT_LINE,
    deps,
  )
  pushLokiEvent(
    { endpoint: 'http://h:3100' },
    { state: 'done' },
    EVENT_LINE,
    deps,
  )
  pushLokiEvent(
    { endpoint: 'http://h:3100' },
    { state: 'halted' },
    EVENT_LINE,
    deps,
  )
  assert.equal(out.calls.length, 3)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notes.length, 1)
})

test('pushLokiEvent: a throwing fetch never propagates and notes at most once', async () => {
  const notes: string[] = []
  const deps: LokiPushDeps = {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    now: () => NOW_MS,
    state: { noted: false },
    onNote: (error) => notes.push(error),
  }
  assert.doesNotThrow(() =>
    pushLokiEvent(
      { endpoint: 'http://h:3100' },
      { state: 'running' },
      EVENT_LINE,
      deps,
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notes.length, 1)
})
