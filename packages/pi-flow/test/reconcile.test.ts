// AIDEV-NOTE (PMR-MSDJ 1.3): tests for flow/reconcile.ts — the node-only
// tombstone engine. Fixtures are REAL-shaped: `tombstoneBody` receives the
// body `fetchGroupBody` returns from a live `GET {base}/metrics` dump, i.e.
// alphabetical labels (pushgateway sorts them), `instance=""` already
// stripped, `#` comments already dropped. The same shape is in
// test/push.test.ts (copied from the live gateway 2026-11-24) — keep both in
// sync when the exposition changes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TicketProbe } from '../aven/status.ts'
import type { GroupBodyResult } from '../flow/push.ts'
import {
  computeStaleRefs,
  parseReconcileSettings,
  type ReconcileDeps,
  runReconcilePass,
  tombstoneBody,
} from '../flow/reconcile.ts'
import type { FlowRunEvent, LoopRunStatus } from '../run-state.ts'

const REF_WORK = 'PMR-MSDJ'
const TRACK_REF = 'DP-236'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Real filtered group-body lines (verified against the live gateway with
 *  `fetchGroupBody` on 2026-11-24, then re-labelled to a work group): cost +
 *  tokens + tool calls + durations + liveness + the gateway's own
 *  push_time_seconds. Note `pi_flow_tool_calls_total` carries its OWN
 *  `status="ok"` label — a decoy the surgery must never touch. */
const HALTED_LINES = [
  'pi_flow_blocker_retries{job="pi-flow",mode="work",ref="DP-236"} 0',
  'pi_flow_gate_wait_seconds{choice="reject",gate="spec-review",job="pi-flow",mode="work",n="1",ref="DP-236"} 1830',
  'pi_flow_human_wait_seconds{job="pi-flow",mode="work",ref="DP-236"} 1830',
  'pi_flow_run_cost_usd{agent="main",job="pi-flow",mode="work",phase="plan",ref="DP-236",session="main-01a202f3",subtask=""} 0.123456',
  'pi_flow_run_duration_seconds{job="pi-flow",mode="work",phase="plan",ref="DP-236"} 56.587',
  'pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="flow halted at plan: phase completed without landing the \\"planned\\" label",ref="DP-236"} 1',
  'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="halted"} 1',
  'pi_flow_tokens_total{agent="main",job="pi-flow",kind="input",mode="work",phase="plan",ref="DP-236",session="main-01a202f3"} 41943',
  'pi_flow_tool_calls_total{agent="main",job="pi-flow",mode="work",phase="plan",ref="DP-236",session="main-01a202f3",status="ok",tool="ask_user_question"} 2',
  'push_time_seconds{job="pi-flow",mode="work",ref="DP-236"} 1.7954159528031516e+09',
]
const HALTED_BODY = HALTED_LINES.join('\n')

function body(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

function runStart(mode: 'work' | 'personal', trackRef?: string): FlowRunEvent {
  const event: FlowRunEvent = {
    kind: 'run-start',
    at: '2026-11-24T06:00:00.000Z',
    ref: REF_WORK,
    mode,
  }
  if (trackRef === undefined) return event
  return { ...event, trackRef }
}

function loopState(status: LoopRunStatus): FlowRunEvent {
  return {
    kind: 'loop-state',
    at: '2026-11-24T07:00:00.000Z',
    ref: REF_WORK,
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: '2026-11-24T07:00:00.000Z',
      status,
    },
  }
}

function haltedEvents(): FlowRunEvent[] {
  return [runStart('work', TRACK_REF), loopState('halted')]
}

// ---------------------------------------------------------------------------
// computeStaleRefs
// ---------------------------------------------------------------------------

test('computeStaleRefs: halted run whose ticket is active stays live', () => {
  const stale = computeStaleRefs(
    new Map([[REF_WORK, 'halted']]),
    new Map([[REF_WORK, 'active']]),
  )
  assert.deepEqual(stale, [])
})

test('computeStaleRefs: halted + done and paused + backlog are stale', () => {
  const stale = computeStaleRefs(
    new Map([
      ['PMR-ONE', 'halted'],
      ['PMR-TWO', 'paused'],
    ]),
    new Map([
      ['PMR-ONE', 'done'],
      ['PMR-TWO', 'backlog'],
    ]),
  )
  assert.deepEqual(stale, ['PMR-ONE', 'PMR-TWO'])
})

test('computeStaleRefs: a ticket missing from the map is stale', () => {
  const stale = computeStaleRefs(
    new Map([['PMR-GONE', 'halted']]),
    new Map([['PMR-OTHER', 'active']]),
  )
  assert.deepEqual(stale, ['PMR-GONE'])
})

test('computeStaleRefs: null ticket map (aven failed) fails closed to no stale refs', () => {
  assert.deepEqual(computeStaleRefs(new Map([['PMR-ONE', 'halted']]), null), [])
  assert.deepEqual(computeStaleRefs(new Map([['PMR-ONE', 'paused']]), null), [])
})

test('computeStaleRefs: non-liveness journal statuses are ignored defensively', () => {
  const stale = computeStaleRefs(
    new Map([
      ['PMR-RUN', 'running'],
      ['PMR-DONE', 'done'],
      ['PMR-WEIRD', 'stale'],
    ]),
    new Map(),
  )
  assert.deepEqual(stale, [])
})

test('computeStaleRefs: output keeps the journal map iteration order', () => {
  const stale = computeStaleRefs(
    new Map([
      ['PMR-Z', 'paused'],
      ['PMR-A', 'halted'],
      ['PMR-M', 'running'],
      ['PMR-B', 'halted'],
    ]),
    new Map([
      // PMR-MSDJ amendment (2.3 smoke): 'todo' is LIVE now (gate-waiting runs
      // park there), so this ordering fixture uses 'backlog' for the stale
      // ref — intent unchanged: stale refs keep journal iteration order.
      ['PMR-Z', 'backlog'],
      ['PMR-A', 'active'],
      ['PMR-B', 'canceled'],
    ]),
  )
  assert.deepEqual(stale, ['PMR-Z', 'PMR-B'])
})

// ---------------------------------------------------------------------------
// tombstoneBody
// ---------------------------------------------------------------------------

test('tombstoneBody: rewrites halted to stale and drops halt_reason', () => {
  const got = tombstoneBody(`${HALTED_BODY}\n`)
  assert.notEqual(got, null)
  const expected = HALTED_LINES.filter(
    (line) => !line.startsWith('pi_flow_run_halt_reason{'),
  ).map((line) =>
    line.startsWith('pi_flow_run_status{')
      ? line.replace('status="halted"', 'status="stale"')
      : line,
  )
  assert.equal(got, `${expected.join('\n')}\n`)
})

test('tombstoneBody: every non-status line stays byte-identical', () => {
  const got = tombstoneBody(`${HALTED_BODY}\n`)
  assert.notEqual(got, null)
  const original = HALTED_LINES.filter(
    (line) =>
      !line.startsWith('pi_flow_run_status{') &&
      !line.startsWith('pi_flow_run_halt_reason{'),
  )
  const kept = String(got)
    .split('\n')
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !line.startsWith('pi_flow_run_status{') &&
        !line.startsWith('pi_flow_run_halt_reason{'),
    )
  assert.deepEqual(kept, original)
})

test('tombstoneBody: rewrites paused to stale', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="paused"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="stale"} 1',
    ),
  )
})

test('tombstoneBody: personal group label set (no mode) is handled', () => {
  const got = tombstoneBody(
    body('pi_flow_run_status{job="pi-flow",ref="PMR-C0WG",status="halted"} 1'),
  )
  assert.equal(
    got,
    body('pi_flow_run_status{job="pi-flow",ref="PMR-C0WG",status="stale"} 1'),
  )
})

test('tombstoneBody: halt_reason line is dropped, not rewritten', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="boom",ref="DP-1"} 1',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="halted"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="stale"} 1',
    ),
  )
})

test('tombstoneBody: no halted/paused status line means null (already clean)', () => {
  assert.equal(
    tombstoneBody(
      body(
        'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="done"} 1',
      ),
    ),
    null,
  )
  assert.equal(
    tombstoneBody(body('pi_flow_run_cost_usd{job="pi-flow",ref="DP-1"} 0.5')),
    null,
  )
  assert.equal(tombstoneBody(''), null)
})

test('tombstoneBody: a stray halt_reason with no liveness line still means null', () => {
  // Fail-safe direction: the engine then records "already clean" and never
  // re-posts a body that dropped lines without rewriting a status.
  assert.equal(
    tombstoneBody(
      body(
        'pi_flow_run_halt_reason{job="pi-flow",reason="boom",ref="DP-1"} 1',
        'pi_flow_run_status{job="pi-flow",ref="DP-1",status="done"} 1',
      ),
    ),
    null,
  )
})

test('tombstoneBody: rewrites multiple liveness lines (defensive)', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_run_status{job="pi-flow",ref="DP-1",status="halted"} 1',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="paused"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_run_status{job="pi-flow",ref="DP-1",status="stale"} 1',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="stale"} 1',
    ),
  )
})

test('tombstoneBody: only pi_flow_run_status lines get surgery', () => {
  // A cost line carrying a `phase="halted"`-shaped value must pass through
  // untouched — the rewrite is keyed on the metric name prefix.
  const line =
    'pi_flow_run_cost_usd{job="pi-flow",phase="halted",ref="DP-1"} 0.25'
  const got = tombstoneBody(
    body(
      line,
      'pi_flow_run_status{job="pi-flow",ref="DP-1",status="halted"} 1',
    ),
  )
  assert.equal(
    got,
    body(line, 'pi_flow_run_status{job="pi-flow",ref="DP-1",status="stale"} 1'),
  )
})

test('tombstoneBody: a decoy status label on another metric is untouched', () => {
  // pi_flow_tool_calls_total really does carry status="ok" on the live
  // gateway, so the rewrite must stay keyed on the metric name.
  const got = tombstoneBody(`${HALTED_BODY}\n`)
  assert.notEqual(got, null)
  assert.ok(
    String(got).includes(
      'pi_flow_tool_calls_total{agent="main",job="pi-flow",mode="work",phase="plan",ref="DP-236",session="main-01a202f3",status="ok",tool="ask_user_question"} 2',
    ),
  )
  assert.equal(String(got).match(/status="stale"/g)?.length, 1)
})

test('tombstoneBody: comment lines pass through untouched', () => {
  const got = tombstoneBody(
    body(
      '# HELP pi_flow_run_status Auto-detected based on sample values below.',
      '# TYPE pi_flow_run_status untyped',
      'pi_flow_run_status{job="pi-flow",ref="DP-1",status="paused"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      '# HELP pi_flow_run_status Auto-detected based on sample values below.',
      '# TYPE pi_flow_run_status untyped',
      'pi_flow_run_status{job="pi-flow",ref="DP-1",status="stale"} 1',
    ),
  )
})

test('tombstoneBody: status surgery does not touch a status-like label value', () => {
  // `reason="...status=\\"halted\\"..."` — escaped quotes inside a value must
  // not be treated as the status label of the run_status line.
  const got = tombstoneBody(
    body(
      'pi_flow_run_status{job="pi-flow",note="still status=\\"halted\\"",ref="DP-1",status="halted"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_run_status{job="pi-flow",note="still status=\\"halted\\"",ref="DP-1",status="stale"} 1',
    ),
  )
})

// ---------------------------------------------------------------------------
// parseReconcileSettings
// ---------------------------------------------------------------------------

test('parseReconcileSettings: null and empty input give the defaults, silently', () => {
  assert.deepEqual(parseReconcileSettings(null), {
    enabled: true,
    intervalMinutes: 360,
  })
  assert.deepEqual(parseReconcileSettings(''), {
    enabled: true,
    intervalMinutes: 360,
  })
})

test('parseReconcileSettings: reads the reconcile block', () => {
  assert.deepEqual(
    parseReconcileSettings(
      '{"reconcile":{"enabled":false,"intervalMinutes":60}}',
    ),
    { enabled: false, intervalMinutes: 60 },
  )
  assert.deepEqual(parseReconcileSettings('{"reconcile":{"enabled":true}}'), {
    enabled: true,
    intervalMinutes: 360,
  })
  assert.deepEqual(
    parseReconcileSettings('{"reconcile":{"intervalMinutes":30}}'),
    {
      enabled: true,
      intervalMinutes: 30,
    },
  )
})

test('parseReconcileSettings: config without a reconcile block is the defaults', () => {
  assert.deepEqual(parseReconcileSettings('{"runServer":{"enabled":false}}'), {
    enabled: true,
    intervalMinutes: 360,
  })
})

test('parseReconcileSettings: malformed JSON falls back to defaults with a warning', () => {
  const got = parseReconcileSettings('{"reconcile": {oops')
  assert.equal(got.enabled, true)
  assert.equal(got.intervalMinutes, 360)
  assert.equal(typeof got.warning, 'string')
  assert.notEqual(got.warning, '')
})

test('parseReconcileSettings: wrong shapes fall back with a warning', () => {
  for (const raw of [
    '[]',
    '"reconcile"',
    'null',
    '{"reconcile":5}',
    '{"reconcile":{"enabled":"yes"}}',
    '{"reconcile":{"intervalMinutes":"60"}}',
    '{"reconcile":{"intervalMinutes":null}}',
    '{"reconcile":{"intervalMinutes":0}}',
    '{"reconcile":{"intervalMinutes":-3}}',
    '{"reconcile":{"intervalMinutes":1e999}}',
  ]) {
    const got = parseReconcileSettings(raw)
    assert.deepEqual(
      { enabled: got.enabled, intervalMinutes: got.intervalMinutes },
      { enabled: true, intervalMinutes: 360 },
      raw,
    )
    assert.equal(typeof got.warning, 'string', raw)
  }
})

// ---------------------------------------------------------------------------
// runReconcilePass
// ---------------------------------------------------------------------------

interface DepsOptions {
  refs?: string[]
  events?: Map<string, FlowRunEvent[] | null>
  ticketStatus?: Map<string, string> | null
  bodies?: Map<string, GroupBodyResult>
  pushOk?: boolean
  /** P2-1 bounded confirmation answers, keyed by ref (missing key => the
   *  probe is not stubbed and the fake throws, so an unexpected call is loud
   *  rather than silently answered). */
  probes?: Map<string, TicketProbe | null>
}

interface Recording {
  deps: ReconcileDeps
  warns: string[]
  fetches: Array<{ trackRef: string; mode: string }>
  pushes: Array<{ trackRef: string; mode: string; body: string }>
  stats: { ticketCalls: number; probeRefs: string[] }
}

function fakeDeps(options: DepsOptions): Recording {
  const refs = options.refs ?? [REF_WORK]
  const events = options.events ?? new Map([[REF_WORK, haltedEvents()]])
  const bodies =
    options.bodies ??
    new Map([
      [TRACK_REF, { ok: true, body: `${HALTED_BODY}\n` } as GroupBodyResult],
    ])
  const warns: string[] = []
  const fetches: Array<{ trackRef: string; mode: string }> = []
  const pushes: Array<{ trackRef: string; mode: string; body: string }> = []
  const stats = { ticketCalls: 0, probeRefs: [] as string[] }
  return {
    warns,
    fetches,
    pushes,
    stats,
    deps: {
      async listJournalRefs() {
        return refs
      },
      async readRunEvents(ref: string) {
        return events.get(ref) ?? null
      },
      async listTicketStatuses() {
        stats.ticketCalls += 1
        return options.ticketStatus === undefined
          ? new Map([[REF_WORK, 'done']])
          : options.ticketStatus
      },
      async ticketStatusOf(ref: string) {
        stats.probeRefs.push(ref)
        if (!options.probes) {
          throw new Error(`unexpected ticketStatusOf(${ref})`)
        }
        return options.probes.get(ref) ?? null
      },
      async fetchGroupBody(trackRef: string, mode: 'work' | 'personal') {
        fetches.push({ trackRef, mode })
        return (
          bodies.get(`${trackRef}|${mode}`) ??
          bodies.get(trackRef) ?? { ok: true, body: '' }
        )
      },
      async pushTombstone(
        trackRef: string,
        mode: 'work' | 'personal',
        bodyText: string,
      ) {
        pushes.push({ trackRef, mode, body: bodyText })
        if (options.pushOk === false) {
          return { ok: false, error: 'pushgateway responded 400 Bad Request' }
        }
        return { ok: true }
      },
      warn(message: string) {
        warns.push(message)
      },
    },
  }
}

test('runReconcilePass: tombstones a stale halted work run and reports it', async () => {
  const rec = fakeDeps({})
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.scanned, 1)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.stale, [
    { ref: REF_WORK, journalStatus: 'halted', ticketStatus: 'done' },
  ])
  assert.deepEqual(report.tombstoned, [REF_WORK])
  assert.deepEqual(report.skipped, [])
  assert.equal(report.avenFailed, false)
  assert.equal(report.dryRun, false)
  // group identity comes from runTracking, so the work suffix ref is DP-236
  assert.deepEqual(rec.fetches, [{ trackRef: TRACK_REF, mode: 'work' }])
  assert.equal(rec.pushes.length, 1)
  assert.equal(rec.pushes[0].trackRef, TRACK_REF)
  assert.equal(rec.pushes[0].mode, 'work')
  assert.equal(rec.pushes[0].body, tombstoneBody(`${HALTED_BODY}\n`))
  assert.deepEqual(rec.warns, [])
})

test('runReconcilePass: live runs (ticket active) are neither fetched nor pushed', async () => {
  const rec = fakeDeps({ ticketStatus: new Map([[REF_WORK, 'active']]) })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(rec.fetches, [])
  assert.deepEqual(rec.pushes, [])
})

test('runReconcilePass: dry-run reports stale refs but never pushes', async () => {
  const rec = fakeDeps({})
  const report = await runReconcilePass(rec.deps, { dryRun: true })
  assert.equal(report.dryRun, true)
  assert.deepEqual(report.stale, [
    { ref: REF_WORK, journalStatus: 'halted', ticketStatus: 'done' },
  ])
  assert.deepEqual(report.tombstoned, [])
  assert.equal(rec.pushes.length, 0)
  assert.equal(rec.fetches.length, 1)
})

test('runReconcilePass: aven failure warns once, tombstones nothing and fetches nothing', async () => {
  const rec = fakeDeps({ ticketStatus: null })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.avenFailed, true)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(report.skipped, [])
  assert.deepEqual(rec.fetches, [])
  assert.deepEqual(rec.pushes, [])
  assert.equal(rec.warns.length, 1)
})

test('runReconcilePass: does not shell out to aven when there are no candidates', async () => {
  const rec = fakeDeps({
    events: new Map([
      [REF_WORK, [runStart('work', TRACK_REF), loopState('running')]],
    ]),
    ticketStatus: null,
  })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.scanned, 1)
  assert.equal(report.candidates, 0)
  assert.equal(report.avenFailed, false)
  assert.equal(rec.stats.ticketCalls, 0)
  assert.deepEqual(rec.warns, [])
})

test('runReconcilePass: missing or unprojectable journals are skipped silently', async () => {
  const rec = fakeDeps({
    refs: ['PMR-GONE', 'PMR-EMPTY', REF_WORK],
    events: new Map([
      ['PMR-GONE', null],
      ['PMR-EMPTY', []],
      [REF_WORK, haltedEvents()],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.scanned, 3)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.tombstoned, [REF_WORK])
  assert.equal(rec.stats.ticketCalls, 1)
})

test('runReconcilePass: personal-mode stale run uses the personal group', async () => {
  const rec = fakeDeps({
    events: new Map([[REF_WORK, [runStart('personal'), loopState('paused')]]]),
    bodies: new Map([
      [
        `${REF_WORK}|personal`,
        {
          ok: true,
          body: body(
            'pi_flow_run_status{job="pi-flow",ref="PMR-MSDJ",status="paused"} 1',
          ),
        } as GroupBodyResult,
      ],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(rec.fetches, [{ trackRef: REF_WORK, mode: 'personal' }])
  assert.deepEqual(report.tombstoned, [REF_WORK])
  assert.equal(
    rec.pushes[0].body,
    body('pi_flow_run_status{job="pi-flow",ref="PMR-MSDJ",status="stale"} 1'),
  )
})

test('runReconcilePass: GET failure records a skip and warns', async () => {
  const rec = fakeDeps({
    bodies: new Map([
      [
        TRACK_REF,
        {
          ok: false,
          error: 'pushgateway GET responded 502 Bad Gateway',
        } as GroupBodyResult,
      ],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(report.skipped, [
    { ref: REF_WORK, reason: 'pushgateway GET responded 502 Bad Gateway' },
  ])
  assert.deepEqual(rec.pushes, [])
  assert.equal(rec.warns.length, 1)
})

test('runReconcilePass: empty group body (gateway lost the group) is a clean skip', async () => {
  const rec = fakeDeps({
    bodies: new Map([[TRACK_REF, { ok: true, body: '' } as GroupBodyResult]]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.skipped, [{ ref: REF_WORK, reason: 'already clean' }])
  assert.deepEqual(report.tombstoned, [])
  assert.equal(rec.pushes.length, 0)
})

test('runReconcilePass: already-clean body is a silent skip', async () => {
  const clean = body(
    'pi_flow_run_cost_usd{job="pi-flow",mode="work",ref="DP-236"} 1.5',
    'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="stale"} 1',
  )
  const rec = fakeDeps({
    bodies: new Map([
      [TRACK_REF, { ok: true, body: clean } as GroupBodyResult],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.skipped, [{ ref: REF_WORK, reason: 'already clean' }])
  assert.deepEqual(report.tombstoned, [])
  assert.equal(rec.pushes.length, 0)
})

test('runReconcilePass: POST failure records a skip and warns', async () => {
  const rec = fakeDeps({ pushOk: false })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(report.skipped, [
    { ref: REF_WORK, reason: 'pushgateway responded 400 Bad Request' },
  ])
  assert.equal(rec.warns.length, 1)
  assert.equal(rec.pushes.length, 1)
})

test('runReconcilePass: warnings stay bounded by the stale count', async () => {
  const rec = fakeDeps({
    refs: ['PMR-A', 'PMR-B', 'PMR-C'],
    events: new Map([
      [
        'PMR-A',
        [
          runStartNamed('PMR-A', 'work', 'DP-A'),
          loopStateNamed('PMR-A', 'halted'),
        ],
      ],
      [
        'PMR-B',
        [
          runStartNamed('PMR-B', 'work', 'DP-B'),
          loopStateNamed('PMR-B', 'paused'),
        ],
      ],
      [
        'PMR-C',
        [
          runStartNamed('PMR-C', 'work', 'DP-C'),
          loopStateNamed('PMR-C', 'halted'),
        ],
      ],
    ]),
    ticketStatus: new Map([
      ['PMR-A', 'done'],
      ['PMR-B', 'backlog'],
      ['PMR-C', 'canceled'],
    ]),
    bodies: new Map([
      ['DP-A', { ok: false, error: 'GET exploded' } as GroupBodyResult],
      ['DP-B', { ok: false, error: 'GET exploded' } as GroupBodyResult],
      ['DP-C', { ok: true, body: '' } as GroupBodyResult],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.candidates, 3)
  assert.equal(report.stale.length, 3)
  assert.equal(report.skipped.length, 3)
  assert.equal(rec.warns.length, 2)
  assert.ok(rec.warns.length <= report.stale.length + 1)
})

test('runReconcilePass: tombstone body round-trips the full group (never rebuilt)', async () => {
  const rec = fakeDeps({})
  await runReconcilePass(rec.deps)
  const pushed = rec.pushes[0].body
  assert.ok(pushed.includes('pi_flow_tokens_total'))
  assert.ok(pushed.includes('pi_flow_run_cost_usd'))
  assert.ok(pushed.includes('push_time_seconds'))
  assert.ok(pushed.includes('pi_flow_human_wait_seconds'))
  assert.ok(!pushed.includes('pi_flow_run_halt_reason'))
  assert.ok(pushed.includes('status="stale"'))
})

function runStartNamed(
  ref: string,
  mode: 'work' | 'personal',
  trackRef: string,
): FlowRunEvent {
  return {
    kind: 'run-start',
    at: '2026-11-24T06:00:00.000Z',
    ref,
    mode,
    trackRef,
  }
}

function loopStateNamed(ref: string, status: LoopRunStatus): FlowRunEvent {
  return {
    kind: 'loop-state',
    at: '2026-11-24T07:00:00.000Z',
    ref,
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: '2026-11-24T07:00:00.000Z',
      status,
    },
  }
}

test('computeStaleRefs: halted run whose ticket is todo stays live (gate-waiting amendment)', () => {
  assert.deepEqual(
    computeStaleRefs(
      new Map([[REF_WORK, 'halted']]),
      new Map([[REF_WORK, 'todo']]),
    ),
    [],
  )
})

test('computeStaleRefs: paused run whose ticket is todo stays live', () => {
  assert.deepEqual(
    computeStaleRefs(
      new Map([[REF_WORK, 'paused']]),
      new Map([[REF_WORK, 'todo']]),
    ),
    [],
  )
})

test('computeStaleRefs: halted run whose ticket is inbox is stale', () => {
  assert.deepEqual(
    computeStaleRefs(
      new Map([[REF_WORK, 'halted']]),
      new Map([[REF_WORK, 'inbox']]),
    ),
    [REF_WORK],
  )
})

// ---------------------------------------------------------------------------
// P2-1 (PMR-MSDJ fix round): the bounded confirmation of a MISSING ref.
// "missing from the merged listing" is evidence of a closed ticket, not proof
// of an absent one: an `avenWorkspace` override to a third workspace yields a
// valid-but-incomplete Map, and tombstoning on that evidence alone is the one
// failure mode decision 2 forbids. So a candidate ref the listing does not
// know is asked DIRECTLY (`aven show <ref> --json`, ONE shell-out, bounded by
// the candidate count) before it is called stale:
//   • probe says active/todo            => live, skip 'ticket live on direct lookup'
//   • probe says missing (unknown-ref)  => genuinely gone, stale
//   • probe null (lookup anomaly)       => skip 'aven lookup inconclusive' + warn
// ---------------------------------------------------------------------------

test('runReconcilePass: a missing ref the probe says is ACTIVE stays live (no tombstone)', async () => {
  const rec = fakeDeps({
    ticketStatus: new Map([['PMR-OTHER', 'done']]),
    probes: new Map<string, TicketProbe | null>([
      [REF_WORK, { kind: 'ticket', status: 'active' }],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(report.skipped, [
    { ref: REF_WORK, reason: 'ticket live on direct lookup' },
  ])
  assert.deepEqual(rec.stats.probeRefs, [REF_WORK])
  assert.deepEqual(rec.fetches, [])
  assert.deepEqual(rec.pushes, [])
  assert.deepEqual(rec.warns, [])
})

test('runReconcilePass: a missing ref the probe says is TODO stays live too', async () => {
  const rec = fakeDeps({
    ticketStatus: new Map(),
    probes: new Map<string, TicketProbe | null>([
      [REF_WORK, { kind: 'ticket', status: 'todo' }],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.skipped, [
    { ref: REF_WORK, reason: 'ticket live on direct lookup' },
  ])
})

test('runReconcilePass: aven unknown-ref on the probe confirms the tombstone', async () => {
  const rec = fakeDeps({
    ticketStatus: new Map([['PMR-OTHER', 'done']]),
    probes: new Map<string, TicketProbe | null>([
      [REF_WORK, { kind: 'missing' }],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.stale, [
    { ref: REF_WORK, journalStatus: 'halted', ticketStatus: undefined },
  ])
  assert.deepEqual(report.tombstoned, [REF_WORK])
  assert.deepEqual(report.skipped, [])
  assert.deepEqual(rec.stats.probeRefs, [REF_WORK])
})

test('runReconcilePass: a probe that reads a stale status tombstones with that status', async () => {
  const rec = fakeDeps({
    ticketStatus: new Map(),
    probes: new Map<string, TicketProbe | null>([
      [REF_WORK, { kind: 'ticket', status: 'done' }],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.deepEqual(report.stale, [
    { ref: REF_WORK, journalStatus: 'halted', ticketStatus: 'done' },
  ])
  assert.deepEqual(report.tombstoned, [REF_WORK])
})

test('runReconcilePass: an inconclusive probe skips the ref fail-closed + warns', async () => {
  const rec = fakeDeps({
    ticketStatus: new Map(),
    probes: new Map<string, TicketProbe | null>([[REF_WORK, null]]),
  })
  const report = await runReconcilePass(rec.deps)
  assert.equal(report.avenFailed, false)
  assert.deepEqual(report.stale, [])
  assert.deepEqual(report.tombstoned, [])
  assert.deepEqual(report.skipped, [
    { ref: REF_WORK, reason: 'aven lookup inconclusive' },
  ])
  assert.equal(rec.warns.length, 1)
  assert.match(rec.warns[0], /PMR-MSDJ.*aven lookup inconclusive/)
  assert.deepEqual(rec.fetches, [])
})

test('runReconcilePass: the probe is bounded to the refs the listing does not know', async () => {
  const rec = fakeDeps({
    refs: ['PMR-A', 'PMR-B', 'PMR-C'],
    events: new Map([
      [
        'PMR-A',
        [
          runStartNamed('PMR-A', 'work', 'DP-A'),
          loopStateNamed('PMR-A', 'halted'),
        ],
      ],
      [
        'PMR-B',
        [
          runStartNamed('PMR-B', 'work', 'DP-B'),
          loopStateNamed('PMR-B', 'paused'),
        ],
      ],
      [
        'PMR-C',
        [
          runStartNamed('PMR-C', 'work', 'DP-C'),
          loopStateNamed('PMR-C', 'halted'),
        ],
      ],
    ]),
    ticketStatus: new Map([['PMR-A', 'done']]),
    probes: new Map<string, TicketProbe | null>([
      ['PMR-B', { kind: 'missing' }],
      ['PMR-C', null],
    ]),
    bodies: new Map<string, GroupBodyResult>([
      ['DP-A', { ok: true, body: `${HALTED_BODY}\n` }],
      ['DP-B', { ok: true, body: `${HALTED_BODY}\n` }],
    ]),
  })
  const report = await runReconcilePass(rec.deps)
  // PMR-A is known stale by the listing alone => never probed. The two unknown
  // refs get exactly one shell-out each.
  assert.deepEqual(rec.stats.probeRefs.sort(), ['PMR-B', 'PMR-C'])
  assert.deepEqual(report.tombstoned, ['PMR-A', 'PMR-B'])
  assert.deepEqual(report.skipped, [
    { ref: 'PMR-C', reason: 'aven lookup inconclusive' },
  ])
})
