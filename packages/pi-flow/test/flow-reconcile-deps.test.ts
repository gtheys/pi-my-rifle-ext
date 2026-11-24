// AIDEV-NOTE: PMR-MSDJ 2.2 — tests for flow/reconcile-deps.ts, the node-only
// io wiring that turns the daemon's world (agent dir + process env) into the
// engine's injected `ReconcileDeps`. No test here shells out to aven or touches
// the network: `listTicketStatuses` and the fetch adapter are always injected,
// and journals/config files live in a mkdtemp agent dir (tmpdir.ts pattern).
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { ReconcileDeps, ReconcileReport } from '../flow/reconcile.ts'
import {
  createReconcileDeps,
  globalConfigPath,
  journalRefsFromEntries,
  listJournalRefs,
  pushgatewayEnv,
  type ReconcileFetch,
  readReconcileSettings,
  reconcileSummaryLine,
  runReconcilePassOnce,
} from '../flow/reconcile-deps.ts'
import { type FlowRunEvent, recordRunEventJournalOnly } from '../run-state.ts'
import { mkTmpDir } from './tmpdir.ts'

const REF = 'PMR-HQ1M'
const TRACK_REF = 'DP-236'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function agentDir(): string {
  return mkTmpDir('pi-flow-reconcile-deps-')
}

function haltedWorkJournal(dir: string, ref = REF): Promise<void> {
  const at = '2026-11-24T06:00:00.000Z'
  const start: FlowRunEvent = {
    kind: 'run-start',
    at,
    ref,
    mode: 'work',
    trackRef: TRACK_REF,
  }
  const loop: FlowRunEvent = {
    kind: 'loop-state',
    at,
    ref,
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status: 'halted',
    },
  }
  return recordRunEventJournalOnly(dir, start).then(() =>
    recordRunEventJournalOnly(dir, loop),
  )
}

/** A real-shaped `fetchGroupBody` result (the dump GET would filter to this
 *  group): alphabetical labels, `instance=""` already stripped by the fetcher. */
const DUMP_LINES = [
  'pi_flow_run_cost_usd{agent="main",job="pi-flow",mode="work",phase="plan",ref="DP-236",session="main-01a202f3",subtask=""} 0.123456',
  'pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="flow halted at plan",ref="DP-236"} 1',
  'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="halted"} 1',
]
const DUMP = `${[
  '# HELP pi_flow_run_status exported',
  '# TYPE pi_flow_run_status gauge',
  `pi_flow_run_cost_usd{agent="main",instance="",job="pi-flow",mode="work",phase="plan",ref="DP-236",session="main-01a202f3",subtask=""} 0.123456`,
  `pi_flow_run_halt_reason{instance="",job="pi-flow",mode="work",reason="flow halted at plan",ref="DP-236"} 1`,
  `pi_flow_run_status{instance="",job="pi-flow",mode="work",ref="DP-236",status="halted"} 1`,
  'pi_flow_run_status{instance="",job="pi-flow",mode="work",ref="DP-OTHER",status="halted"} 1',
].join('\n')}\n`

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function fakeFetch(dump: string) {
  const calls: FetchCall[] = []
  const fetchImpl: ReconcileFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
    if (init.method === 'GET') {
      return {
        status: 200,
        statusText: 'OK',
        text: async () => dump,
      }
    }
    return { status: 202, statusText: 'Accepted', text: async () => '' }
  }
  return { calls, fetchImpl }
}

function settledTicketMap(): Promise<Map<string, string>> {
  return Promise.resolve(new Map([[REF, 'done']]))
}

// ---------------------------------------------------------------------------
// journal enumeration — the daemon's own scanRuns rule, single-sourced
// ---------------------------------------------------------------------------

test('journalRefsFromEntries: mirrors scanRuns (.journal.jsonl only, suffix stripped)', () => {
  assert.deepEqual(
    journalRefsFromEntries([
      'PMR-A.journal.jsonl',
      'PMR-B.json',
      'notes.txt',
      'PMR-C.journal.jsonl',
    ]),
    ['PMR-A', 'PMR-C'],
  )
})

test('listJournalRefs: reads runs/*.journal.jsonl from the agent dir', async () => {
  const dir = agentDir()
  const runs = path.join(dir, 'pi-flow', 'runs')
  await fs.mkdir(runs, { recursive: true })
  await fs.writeFile(path.join(runs, 'PMR-A.journal.jsonl'), '', 'utf8')
  await fs.writeFile(path.join(runs, 'PMR-B.journal.jsonl'), '', 'utf8')
  // A projection without a journal is NOT a candidate source (the engine
  // reads journals, so a projection-only ref would only ever skip).
  await fs.writeFile(path.join(runs, 'PMR-C.json'), '{}\n', 'utf8')
  assert.deepEqual((await listJournalRefs(dir)).sort(), ['PMR-A', 'PMR-B'])
})

test('listJournalRefs: missing runs dir is an empty list, not an error', async () => {
  assert.deepEqual(await listJournalRefs(agentDir()), [])
})

// ---------------------------------------------------------------------------
// pushgateway env gate + bearer token
// ---------------------------------------------------------------------------

test('pushgatewayEnv: unset or empty URL closes the gate', () => {
  assert.equal(pushgatewayEnv({}), null)
  assert.equal(pushgatewayEnv({ PI_FLOW_PUSHGATEWAY_URL: '' }), null)
})

test('pushgatewayEnv: URL opens the gate, token optional', () => {
  assert.deepEqual(
    pushgatewayEnv({ PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' }),
    {
      url: 'https://g:4479',
      token: undefined,
    },
  )
  assert.deepEqual(
    pushgatewayEnv({
      PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479',
      PI_FLOW_PUSHGATEWAY_TOKEN: 'tk',
    }),
    { url: 'https://g:4479', token: 'tk' },
  )
})

test('createReconcileDeps: null when the env gate is closed', () => {
  const warns: string[] = []
  const deps = createReconcileDeps({
    agentDir: agentDir(),
    warn: (message) => {
      warns.push(message)
    },
    env: {},
  })
  assert.equal(deps, null)
})

// ---------------------------------------------------------------------------
// the wired deps actually reach the daemon's files and the gateway
// ---------------------------------------------------------------------------

test('createReconcileDeps: journal enumeration + read seam point at the agent dir', async () => {
  const dir = agentDir()
  await haltedWorkJournal(dir)
  const deps = createReconcileDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' },
    listTicketStatuses: settledTicketMap,
  })
  if (deps === null) throw new Error('expected wired deps')
  assert.deepEqual(await deps.listJournalRefs(), [REF])
  const events = await deps.readRunEvents(REF)
  assert.ok(events !== null)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['run-start', 'loop-state'],
  )
  assert.equal(await deps.readRunEvents('PMR-MISSING'), null)
})

test('createReconcileDeps: group read is the dump GET, tombstone POST keeps the work suffix', async () => {
  const dir = agentDir()
  const { calls, fetchImpl } = fakeFetch(DUMP)
  const deps = createReconcileDeps({
    agentDir: dir,
    warn: () => {},
    env: {
      PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479/',
      PI_FLOW_PUSHGATEWAY_TOKEN: 'tk',
    },
    fetchImpl,
    listTicketStatuses: settledTicketMap,
  })
  if (deps === null) throw new Error('expected wired deps')

  const fetched = await deps.fetchGroupBody(TRACK_REF, 'work')
  assert.equal(fetched.ok, true)
  assert.equal(calls[0]?.url, 'https://g:4479/metrics')
  assert.equal(calls[0]?.headers.authorization, 'Bearer tk')
  // instance="" stripped, foreign ref dropped, # comments dropped
  assert.equal(
    fetched.ok === true ? fetched.body : '',
    `${DUMP_LINES.join('\n')}\n`,
  )

  const pushed = await deps.pushTombstone(TRACK_REF, 'work', 'x\n')
  assert.deepEqual(pushed, { ok: true })
  assert.equal(
    calls[1]?.url,
    'https://g:4479/metrics/job/pi-flow/ref/DP-236/mode/work',
  )
  assert.equal(calls[1]?.body, 'x\n')
})

test('createReconcileDeps: personal group URL has no mode segment and no auth header without a token', async () => {
  const dir = agentDir()
  const { calls, fetchImpl } = fakeFetch('')
  const deps = createReconcileDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' },
    fetchImpl,
    listTicketStatuses: settledTicketMap,
  })
  if (deps === null) throw new Error('expected wired deps')
  await deps.pushTombstone('PMR-P', 'personal', 'y\n')
  assert.equal(calls[0]?.url, 'https://g:4479/metrics/job/pi-flow/ref/PMR-P')
  assert.equal(calls[0]?.headers.authorization, undefined)
})

// ---------------------------------------------------------------------------
// settings: the global config file, re-read on every call
// ---------------------------------------------------------------------------

test('globalConfigPath is the daemon-visible global layer', () => {
  assert.equal(
    globalConfigPath('/agent'),
    path.join('/agent', 'pi-flow', 'config.json'),
  )
})

test('readReconcileSettings: missing file is the engine default (enabled, 360)', async () => {
  const settings = await readReconcileSettings(agentDir())
  assert.deepEqual(settings, { enabled: true, intervalMinutes: 360 })
})

test('readReconcileSettings: re-reads the file on every call (interval + enabled changes)', async () => {
  const dir = agentDir()
  const file = globalConfigPath(dir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{"reconcile":{"intervalMinutes":120}}\n', 'utf8')
  assert.deepEqual(await readReconcileSettings(dir), {
    enabled: true,
    intervalMinutes: 120,
  })

  await fs.writeFile(file, '{"reconcile":{"enabled":false}}\n', 'utf8')
  const second = await readReconcileSettings(dir)
  assert.equal(second.enabled, false)
})

test('readReconcileSettings: malformed JSON keeps the defaults and carries a warning', async () => {
  const dir = agentDir()
  const file = globalConfigPath(dir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{not json', 'utf8')
  const settings = await readReconcileSettings(dir)
  assert.equal(settings.enabled, true)
  assert.equal(settings.intervalMinutes, 360)
  assert.match(settings.warning ?? '', /not valid JSON/)
})

// ---------------------------------------------------------------------------
// warn routing + the pass runner
// ---------------------------------------------------------------------------

test('runReconcilePassOnce: closed env gate runs nothing (no engine, no fetch)', async () => {
  const dir = agentDir()
  await haltedWorkJournal(dir)
  const { calls, fetchImpl } = fakeFetch(DUMP)
  let engineCalls = 0
  const report = await runReconcilePassOnce({
    agentDir: dir,
    warn: () => {},
    env: {},
    fetchImpl,
    listTicketStatuses: settledTicketMap,
    engine: () => {
      engineCalls += 1
      return Promise.resolve({
        scanned: 0,
        candidates: 0,
        stale: [],
        tombstoned: [],
        skipped: [],
        avenFailed: false,
        dryRun: false,
      })
    },
  })
  assert.equal(report, null)
  assert.equal(engineCalls, 0)
  assert.deepEqual(calls, [])
})

test('runReconcilePassOnce: engine receives the wired deps and dryRun=false (true only when asked)', async () => {
  const dir = agentDir()
  await haltedWorkJournal(dir)
  const seen: { refs: string[]; dryRun: boolean }[] = []
  const { fetchImpl } = fakeFetch('')
  const depsProbe = async (
    deps: ReconcileDeps,
    opts: { dryRun: boolean },
  ): Promise<ReconcileReport> => {
    seen.push({ refs: await deps.listJournalRefs(), dryRun: opts.dryRun })
    return {
      scanned: 1,
      candidates: 1,
      stale: [],
      tombstoned: [],
      skipped: [],
      avenFailed: false,
      dryRun: opts.dryRun,
    }
  }
  await runReconcilePassOnce({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' },
    fetchImpl,
    listTicketStatuses: settledTicketMap,
    engine: depsProbe,
  })
  assert.deepEqual(seen, [{ refs: [REF], dryRun: false }])

  await runReconcilePassOnce({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' },
    fetchImpl,
    listTicketStatuses: settledTicketMap,
    dryRun: true,
    engine: depsProbe,
  })
  assert.equal(seen[1]?.dryRun, true)
})

test('runReconcilePassOnce: one real pass tombstones the stale group and routes warns to the daemon channel', async () => {
  const dir = agentDir()
  await haltedWorkJournal(dir)
  const warns: string[] = []
  const { calls, fetchImpl } = fakeFetch(DUMP)
  const report = await runReconcilePassOnce({
    agentDir: dir,
    warn: (message) => {
      warns.push(message)
    },
    env: {
      PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479',
      PI_FLOW_PUSHGATEWAY_TOKEN: 'tk',
    },
    fetchImpl,
    listTicketStatuses: settledTicketMap,
  })
  assert.ok(report !== null)
  assert.equal(report.scanned, 1)
  assert.equal(report.candidates, 1)
  assert.deepEqual(report.tombstoned, [REF])
  assert.deepEqual(warns, [])

  const post = calls.find((call) => call.method === 'POST')
  assert.ok(post !== undefined, 'the tombstone must be POSTed')
  assert.equal(
    post.url,
    'https://g:4479/metrics/job/pi-flow/ref/DP-236/mode/work',
  )
  assert.ok(post.body?.includes('status="stale"'))
  assert.ok(!post.body?.includes('pi_flow_run_halt_reason'))
  assert.ok(post.body?.includes('pi_flow_run_cost_usd'))

  // aven fail-closed routes exactly one warning into the daemon log channel
  const warns2: string[] = []
  const second = await runReconcilePassOnce({
    agentDir: dir,
    warn: (message) => {
      warns2.push(message)
    },
    env: { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' },
    fetchImpl: fakeFetch(DUMP).fetchImpl,
    listTicketStatuses: async () => null,
  })
  assert.ok(second !== null)
  assert.equal(second.avenFailed, true)
  assert.equal(warns2.length, 1)
})

// ---------------------------------------------------------------------------
// summary line (daemon log + 2.3 notify share this shape)
// ---------------------------------------------------------------------------

test('reconcileSummaryLine: one stable line per pass', () => {
  const line = reconcileSummaryLine({
    scanned: 7,
    candidates: 3,
    stale: [{ ref: REF, journalStatus: 'halted', ticketStatus: 'done' }],
    tombstoned: [REF],
    skipped: [{ ref: 'PMR-X', reason: 'already clean' }],
    avenFailed: false,
    dryRun: false,
  })
  assert.equal(
    line,
    'reconcile pass: scanned=7 candidates=3 stale=1 tombstoned=1 skipped=1',
  )
})

test('reconcileSummaryLine: aven failure and dry-run stay visible', () => {
  const line = reconcileSummaryLine({
    scanned: 2,
    candidates: 1,
    stale: [],
    tombstoned: [],
    skipped: [],
    avenFailed: true,
    dryRun: true,
  })
  assert.equal(
    line,
    'reconcile pass: scanned=2 candidates=1 stale=0 tombstoned=0 skipped=0 dry-run aven=failed',
  )
})
