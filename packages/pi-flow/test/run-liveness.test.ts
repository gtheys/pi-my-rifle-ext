// AIDEV-NOTE (PMR-8MQH 2.1 + 2.2): tests for flow/liveness.ts — the node-only
// settings reader, io wiring, and the liveness engine behind the daemon's
// running-flow liveness push.
// The module's node-only import contract is already locked here (bottom
// section) because the daemon starts importing it in 3.2. Same guard shape as
// test/cost-rows-node-only.test.ts.
//
// No test here touches the network or the real agent dir: the gateway POST is
// always an injected `PushFetch` that records its calls, and journals plus
// assignment records live in a mkdtemp agent dir (tmpdir.ts pattern).
import assert from 'node:assert/strict'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createLivenessDeps,
  DEFAULT_LIVENESS_SETTINGS,
  type LivenessDeps,
  type LivenessReport,
  type LivenessSettings,
  livenessSummaryLine,
  parseLivenessSettings,
  runLivenessPassOnce,
} from '../flow/liveness.ts'
import type { PushFetch, PushResult } from '../flow/push.ts'
import {
  type FlowRunEvent,
  type LoopRunStatus,
  recordRunEventJournalOnly,
} from '../run-state.ts'
import { mkTmpDir } from './tmpdir.ts'

const REF = 'PMR-8MQH'
const TRACK_REF = 'DP-253'
const URL = 'https://g:4479'

function agentDir(): string {
  return mkTmpDir('pi-flow-liveness-')
}

// ---------------------------------------------------------------------------
// settings: the tolerant daemon-side `liveness` reader
// ---------------------------------------------------------------------------

test('DEFAULT_LIVENESS_SETTINGS: liveness on, every 5 minutes', () => {
  assert.deepEqual(DEFAULT_LIVENESS_SETTINGS, {
    enabled: true,
    intervalMinutes: 5,
  })
})

test('parseLivenessSettings: null and blank input give the defaults, silently', () => {
  assert.deepEqual(parseLivenessSettings(null), {
    enabled: true,
    intervalMinutes: 5,
  })
  assert.deepEqual(parseLivenessSettings(''), {
    enabled: true,
    intervalMinutes: 5,
  })
  assert.deepEqual(parseLivenessSettings('   \n '), {
    enabled: true,
    intervalMinutes: 5,
  })
})

test('parseLivenessSettings: a config without a liveness block is the defaults', () => {
  assert.deepEqual(parseLivenessSettings('{"reconcile":{"enabled":false}}'), {
    enabled: true,
    intervalMinutes: 5,
  })
})

test('parseLivenessSettings: reads the liveness block (both keys and each alone)', () => {
  assert.deepEqual(
    parseLivenessSettings('{"liveness":{"enabled":false,"intervalMinutes":1}}'),
    { enabled: false, intervalMinutes: 1 },
  )
  assert.deepEqual(parseLivenessSettings('{"liveness":{"enabled":false}}'), {
    enabled: false,
    intervalMinutes: 5,
  })
  assert.deepEqual(
    parseLivenessSettings('{"liveness":{"intervalMinutes":30}}'),
    { enabled: true, intervalMinutes: 30 },
  )
  assert.deepEqual(parseLivenessSettings('{"liveness":{}}'), {
    enabled: true,
    intervalMinutes: 5,
  })
})

test('parseLivenessSettings: malformed JSON falls back to defaults with a warning', () => {
  const got = parseLivenessSettings('{"liveness": {oops')
  assert.equal(got.enabled, true)
  assert.equal(got.intervalMinutes, 5)
  assert.match(got.warning ?? '', /^liveness: .*valid JSON/)
})

test('parseLivenessSettings: wrong shapes fall back to defaults with a warning', () => {
  const bad: string[] = [
    // the file root is not an object
    '[]',
    'null',
    '"liveness"',
    // the liveness section is not an object
    '{"liveness":5}',
    '{"liveness":[1,2]}',
    // enabled must be a boolean
    '{"liveness":{"enabled":"yes"}}',
    '{"liveness":{"enabled":1}}',
    // intervalMinutes must be a finite number >= 1
    '{"liveness":{"intervalMinutes":0}}',
    '{"liveness":{"intervalMinutes":-3}}',
    '{"liveness":{"intervalMinutes":"5"}}',
    '{"liveness":{"intervalMinutes":null}}',
    '{"liveness":{"intervalMinutes":true}}',
  ]
  for (const raw of bad) {
    const got: LivenessSettings = parseLivenessSettings(raw)
    assert.deepEqual(
      { enabled: got.enabled, intervalMinutes: got.intervalMinutes },
      { enabled: true, intervalMinutes: 5 },
      raw,
    )
    assert.match(got.warning ?? '', /^liveness: /, raw)
  }
})

test('parseLivenessSettings: warnings name the offending key', () => {
  assert.match(
    parseLivenessSettings('{"liveness":{"enabled":"yes"}}').warning ?? '',
    /enabled/,
  )
  assert.match(
    parseLivenessSettings('{"liveness":{"intervalMinutes":0}}').warning ?? '',
    /intervalMinutes/,
  )
})

// ---------------------------------------------------------------------------
// deps: the pushgateway env gate closes everything (ISC-4)
// ---------------------------------------------------------------------------

test('createLivenessDeps: null when the env gate is closed, and no io happens', () => {
  let readdirCalls = 0
  let fetchCalls = 0
  const spyReaddir = async (_dir: string): Promise<string[]> => {
    readdirCalls += 1
    return []
  }
  const spyFetch: PushFetch = async () => {
    fetchCalls += 1
    return { status: 202, statusText: 'Accepted' }
  }
  const dir = agentDir()
  const closed = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: {},
    fetchImpl: spyFetch,
    readdir: spyReaddir,
  })
  assert.equal(closed, null)
  assert.equal(readdirCalls, 0)
  assert.equal(fetchCalls, 0)
  // Strongest no-io evidence: `listAssignments` CREATES its data dir as a side
  // effect (ensureSubagentsDataDir), so an absent pi-subagents dir proves the
  // assignment scan never ran either — the closed gate really touches nothing.
  assert.equal(existsSync(path.join(dir, 'pi-subagents')), false)

  // An empty URL string closes the gate the same way (no push to "")
  assert.equal(
    createLivenessDeps({
      agentDir: agentDir(),
      warn: () => {},
      env: { PI_FLOW_PUSHGATEWAY_URL: '' },
      fetchImpl: spyFetch,
      readdir: spyReaddir,
    }),
    null,
  )
  assert.equal(fetchCalls, 0)
})

test('createLivenessDeps: wiring itself does no io — the reads are lazy closures', () => {
  let readdirCalls = 0
  let fetchCalls = 0
  const deps = createLivenessDeps({
    agentDir: agentDir(),
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl: async () => {
      fetchCalls += 1
      return { status: 200, statusText: 'ok' }
    },
    readdir: async () => {
      readdirCalls += 1
      return []
    },
  })
  if (deps === null) throw new Error('expected wired deps')
  assert.equal(readdirCalls, 0)
  assert.equal(fetchCalls, 0)
})

// ---------------------------------------------------------------------------
// deps: the wired reads point at the agent dir we were handed
// ---------------------------------------------------------------------------

async function runningWorkJournal(dir: string, ref = REF): Promise<void> {
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
      phase: 'implement',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status: 'running',
    },
  }
  await recordRunEventJournalOnly(dir, start)
  await recordRunEventJournalOnly(dir, loop)
}

test('createLivenessDeps: listJournalRefs + readRunEvents reach the given agent dir', async () => {
  const dir = agentDir()
  await runningWorkJournal(dir)
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
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

test('createLivenessDeps: injected readdir is the journal enumeration seam', async () => {
  const dir = agentDir()
  const seen: string[] = []
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    readdir: async (wanted: string) => {
      seen.push(wanted)
      return ['PMR-A.journal.jsonl', 'PMR-B.json']
    },
  })
  if (deps === null) throw new Error('expected wired deps')
  assert.deepEqual(await deps.listJournalRefs(), ['PMR-A'])
  assert.deepEqual(seen, [path.join(dir, 'pi-flow', 'runs')])
})

test('createLivenessDeps: listAssignmentRecords keeps only parsed records from the agent dir', async () => {
  const dir = agentDir()
  const assignments = path.join(dir, 'pi-subagents', 'assignments')
  await fs.mkdir(assignments, { recursive: true })
  const record = {
    childId: 'child-1',
    name: 'worker',
    task: 'do it',
    sessionFile: '/s/child-1.jsonl',
    cwd: dir,
    status: 'working',
    claim: { pid: process.pid, id: 'session-1' },
    createdAt: '2026-11-24T06:00:00.000Z',
    updatedAt: '2026-11-24T06:00:00.000Z',
  }
  await fs.writeFile(
    path.join(assignments, 'child-1.json'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  )
  // An unreadable record classifies as 'unknown' and must never reach the
  // rollup (same filter as the widget and /flow-cost in index.ts).
  await fs.writeFile(path.join(assignments, 'child-2.json'), '{oops', 'utf8')
  await fs.writeFile(path.join(assignments, 'notes.txt'), 'ignore me', 'utf8')

  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
  })
  if (deps === null) throw new Error('expected wired deps')
  assert.deepEqual(
    deps.listAssignmentRecords().map((entry) => entry.childId),
    ['child-1'],
  )
})

test('createLivenessDeps: readSessionFile returns text, null when unreadable', async () => {
  const dir = agentDir()
  const file = path.join(dir, 'session.jsonl')
  await fs.writeFile(file, '{"type":"message"}\n', 'utf8')
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
  })
  if (deps === null) throw new Error('expected wired deps')
  assert.equal(deps.readSessionFile(file), '{"type":"message"}\n')
  assert.equal(deps.readSessionFile(path.join(dir, 'gone.jsonl')), null)
})

test('createLivenessDeps: warn routes to the caller-supplied channel', () => {
  const warns: string[] = []
  const deps = createLivenessDeps({
    agentDir: agentDir(),
    warn: (message) => {
      warns.push(message)
    },
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
  })
  if (deps === null) throw new Error('expected wired deps')
  deps.warn('liveness: routed')
  assert.deepEqual(warns, ['liveness: routed'])
})

// ---------------------------------------------------------------------------
// deps: pushBody is the group POST, and it never throws
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function fakeFetch(
  respond: (call: FetchCall) => {
    status: number
    statusText: string
  } = () => ({
    status: 202,
    statusText: 'Accepted',
  }),
  opts: { throws?: Error } = {},
) {
  const calls: FetchCall[] = []
  const fetchImpl: PushFetch = async (url, init) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    }
    calls.push(call)
    if (opts.throws !== undefined) throw opts.throws
    return respond(call)
  }
  return { calls, fetchImpl }
}

function wired(
  over: Partial<{
    env: NodeJS.ProcessEnv
    fetchImpl: PushFetch
    readdir: (dir: string) => Promise<string[]>
  }> = {},
): LivenessDeps | null {
  return createLivenessDeps({
    agentDir: agentDir(),
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    ...over,
  })
}

test('createLivenessDeps: pushBody POSTs the work group URL with the /mode/work suffix (ISC-7)', async () => {
  const { calls, fetchImpl } = fakeFetch()
  const deps = wired({
    fetchImpl,
    env: {
      PI_FLOW_PUSHGATEWAY_URL: `${URL}/`,
      PI_FLOW_PUSHGATEWAY_TOKEN: 'tk',
    },
  })
  if (deps === null) throw new Error('expected wired deps')
  const result: PushResult = await deps.pushBody(TRACK_REF, 'work', 'x\n')
  assert.deepEqual(result, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(
    calls[0]?.url,
    'https://g:4479/metrics/job/pi-flow/ref/DP-253/mode/work',
  )
  assert.equal(calls[0]?.body, 'x\n')
  assert.equal(calls[0]?.headers['content-type'], 'text/plain')
  assert.equal(calls[0]?.headers.authorization, 'Bearer tk')
})

test('createLivenessDeps: pushBody keeps the personal group URL mode-free and unsuffixed', async () => {
  const { calls, fetchImpl } = fakeFetch()
  const deps = wired({ fetchImpl })
  if (deps === null) throw new Error('expected wired deps')
  assert.deepEqual(await deps.pushBody(REF, 'personal', 'y\n'), { ok: true })
  assert.equal(calls[0]?.url, 'https://g:4479/metrics/job/pi-flow/ref/PMR-8MQH')
  assert.equal(calls[0]?.headers.authorization, undefined)
})

test('createLivenessDeps: pushBody turns a non-2xx response into a failure result', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    status: 503,
    statusText: 'Service Unavailable',
  }))
  const deps = wired({ fetchImpl })
  if (deps === null) throw new Error('expected wired deps')
  const result = await deps.pushBody(TRACK_REF, 'work', 'x\n')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /503/)
  assert.equal(calls.length, 1)
})

test('createLivenessDeps: pushBody never throws when the fetch itself throws', async () => {
  const { calls, fetchImpl } = fakeFetch(undefined, {
    throws: new Error('dns cache is frozen'),
  })
  const deps = wired({ fetchImpl })
  if (deps === null) throw new Error('expected wired deps')
  const result = await deps.pushBody(TRACK_REF, 'work', 'x\n')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /dns cache is frozen/)
  assert.equal(calls.length, 1)
})

// ---------------------------------------------------------------------------
// engine: runLivenessPassOnce (2.2)
//
// Two fixture styles, both deliberate:
//   - the wired cases build REAL journals (plus, where cost lines are
//     asserted, a real session jsonl) in a mkTmpDir agent dir and run the
//     engine on `createLivenessDeps` output with a capturing `fakeFetch`, so
//     the whole path journal read -> projection gate -> rollup -> render ->
//     POST is exercised, and the runs dir can be snapshotted to prove the
//     engine never writes (ISC-A-1);
//   - `fakeEngine` swaps in in-memory reads (scripted per-call readRunEvents
//     for the ISC-8 terminal race) while recording pushBody/warn calls.
// ---------------------------------------------------------------------------

const AT_START = '2026-11-24T06:00:00.000Z'
const SESSION_FILE = '/s/main-session.jsonl'

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

function loopEvent(
  ref: string,
  status: LoopRunStatus,
  at: string,
): FlowRunEvent {
  return {
    kind: 'loop-state',
    at,
    ref,
    loop: {
      phase: 'implement',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status,
    },
  }
}

/** A work-mode journal with cost evidence (main-session recorded inside the
 *  implement phase window) and the given loop status. */
function costJournal(ref: string, status: LoopRunStatus): FlowRunEvent[] {
  return [
    {
      kind: 'run-start',
      at: AT_START,
      ref,
      mode: 'work',
      trackRef: TRACK_REF,
    },
    {
      kind: 'phase-start',
      at: '2026-11-24T06:00:01.000Z',
      ref,
      phase: 'implement',
    },
    {
      kind: 'main-session',
      at: '2026-11-24T06:00:02.000Z',
      ref,
      sessionFile: SESSION_FILE,
    },
    loopEvent(ref, status, '2026-11-24T06:00:09.000Z'),
  ]
}

/** The session body `readSessionFile` answers for `SESSION_FILE`: one usage
 *  block inside the implement window (06:00:01 .. 06:00:09). */
function costSessionBody(): string {
  return `${JSON.stringify(assistant('2026-11-24T06:00:05.000Z', 0.5))}\n`
}

/** A journal with NO cost evidence (no spawn notes, no main-session): the
 *  rollup comes back 'empty', so the body is health-only (ISC-10). */
function healthOnlyJournal(ref: string, status: LoopRunStatus): FlowRunEvent[] {
  return [
    { kind: 'run-start', at: AT_START, ref, mode: 'personal' },
    loopEvent(ref, status, '2026-11-24T06:00:09.000Z'),
  ]
}

/** Events that project NO run state at all (no 'run-start', so
 *  `projectRunState` stays null). */
function nullProjectionJournal(ref: string): FlowRunEvent[] {
  return [{ kind: 'note', at: AT_START, ref, text: 'no run-start here' }]
}

// AIDEV-NOTE (PMR-ZV9Y 7.1): this helper used to build the
// `pi_flow_run_status{…status="running"}` line that proved a liveness push
// carried the run-health block. That metric is retired, so it now probes a KEPT
// line of the same block — `pi_flow_retry_attempts`, which renderRunHealthLines
// emits for every projected run. Prefix-only on purpose: the assertion is "the
// health block for this ref is in the body", and the counter value depends on
// the fixture's attempt records.
function healthLine(ref: string): string {
  return `pi_flow_retry_attempts{ref="${ref}"}`
}

interface FakeEngineOptions {
  /** The refs the pass enumerates (journal basenames). */
  refs: string[]
  /** Per-ref journal events for every `readRunEvents` call. */
  events?: Map<string, FlowRunEvent[] | null>
  /** Per-ref scripted read results in CALL order (the last entry repeats).
   *  Wins over `events` for that ref — this is the ISC-8 race seam. */
  scripts?: Map<string, Array<FlowRunEvent[] | null>>
  /** Refs whose journal read throws (a broken journal, not an absent one). */
  readThrowsFor?: string[]
  /** Refs (by pushed trackRef) whose POST throws instead of returning. */
  pushThrowsFor?: string[]
  /** Refs (by pushed trackRef) whose POST fails with a gateway error. */
  pushFailsFor?: string[]
}

function fakeEngine(options: FakeEngineOptions): {
  deps: LivenessDeps
  posts: Array<{ trackRef: string; mode: string; body: string }>
  warns: string[]
  reads: string[]
} {
  const posts: Array<{ trackRef: string; mode: string; body: string }> = []
  const warns: string[] = []
  const reads: string[] = []
  const readCalls = new Map<string, number>()
  const deps: LivenessDeps = {
    listJournalRefs: async () => [...options.refs],
    readRunEvents: async (ref: string) => {
      reads.push(ref)
      if (options.readThrowsFor?.includes(ref)) {
        throw new Error(`journal read exploded for ${ref}`)
      }
      const script = options.scripts?.get(ref)
      if (script !== undefined) {
        const index = readCalls.get(ref) ?? 0
        readCalls.set(ref, index + 1)
        return script[Math.min(index, script.length - 1)]
      }
      return options.events?.get(ref) ?? null
    },
    listAssignmentRecords: () => [],
    readSessionFile: (file: string) => {
      if (file === SESSION_FILE) return costSessionBody()
      return null
    },
    pushBody: async (trackRef, mode, body) => {
      if (options.pushThrowsFor?.includes(trackRef)) {
        throw new Error(`push threw for ${trackRef}`)
      }
      posts.push({ trackRef, mode, body })
      if (options.pushFailsFor?.includes(trackRef)) {
        return { ok: false, error: 'pushgateway responded 503' }
      }
      return { ok: true }
    },
    warn: (message) => {
      warns.push(message)
    },
  }
  return { deps, posts, warns, reads }
}

function eventsMap(entries: Array<[string, FlowRunEvent[] | null]>) {
  return new Map<string, FlowRunEvent[] | null>(entries)
}

async function journalFiles(dir: string): Promise<Map<string, string>> {
  const wanted = path.join(dir, 'pi-flow', 'runs')
  const snapshot = new Map<string, string>()
  let names: string[]
  try {
    names = await fs.readdir(wanted)
  } catch {
    return snapshot
  }
  for (const name of names.sort()) {
    snapshot.set(name, await fs.readFile(path.join(wanted, name), 'utf8'))
  }
  return snapshot
}

async function writeJournal(
  dir: string,
  events: FlowRunEvent[],
): Promise<void> {
  for (const event of events) {
    await recordRunEventJournalOnly(dir, event)
  }
}

// ---- the report + its summary line ---------------------------------------

test('livenessSummaryLine: the exact daemon log shape', () => {
  const report: LivenessReport = {
    scanned: 9,
    pushed: 2,
    skipped: 6,
    failed: 1,
  }
  assert.equal(
    livenessSummaryLine(report),
    'liveness pass: scanned=9 pushed=2 skipped=6 failed=1',
  )
  assert.equal(
    livenessSummaryLine({ scanned: 0, pushed: 0, skipped: 0, failed: 0 }),
    'liveness pass: scanned=0 pushed=0 skipped=0 failed=0',
  )
})

test('runLivenessPassOnce: no refs enumerated means no read, no push, no warn', async () => {
  const t = fakeEngine({ refs: [] })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 0, pushed: 0, skipped: 0, failed: 0 })
  assert.deepEqual(t.posts, [])
  assert.deepEqual(t.reads, [])
  assert.deepEqual(t.warns, [])
})

// ---- the running gate (ISC-1 / ISC-3) ------------------------------------

test('runLivenessPassOnce: a running work ref is pushed with the health block AND cost lines (ISC-1/2/7)', async () => {
  const t = fakeEngine({
    refs: [REF],
    events: eventsMap([[REF, costJournal(REF, 'running')]]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 1, pushed: 1, skipped: 0, failed: 0 })
  assert.equal(t.posts.length, 1)
  assert.equal(t.posts[0]?.trackRef, TRACK_REF)
  assert.equal(t.posts[0]?.mode, 'work')
  const body = t.posts[0]?.body ?? ''
  assert.ok(
    body.includes(healthLine(TRACK_REF)),
    `expected the run-health block, got:\n${body}`,
  )
  assert.match(body, /pi_flow_run_cost_usd\{[^}]*\} 0\.5\n/)
  assert.match(body, /pi_flow_tokens_total\{[^}]*kind="input"[^}]*\} 10/)
  assert.match(body, /pi_flow_run_duration_seconds\{[^}]*phase="implement"/)
  assert.deepEqual(t.warns, [])
})

test('runLivenessPassOnce: a running personal ref pushes under its own ref in personal mode (ISC-7)', async () => {
  const t = fakeEngine({
    refs: [REF],
    events: eventsMap([[REF, healthOnlyJournal(REF, 'running')]]),
  })
  await runLivenessPassOnce(t.deps)
  assert.equal(t.posts[0]?.trackRef, REF)
  assert.equal(t.posts[0]?.mode, 'personal')
})

test('runLivenessPassOnce: paused, halted, done, no-loop and null-projection refs are never pushed (ISC-3)', async () => {
  const refs = [
    'PMR-PAUSED',
    'PMR-HALTED',
    'PMR-DONE',
    'PMR-NO-LOOP',
    'PMR-NULL-STATE',
  ]
  const t = fakeEngine({
    refs,
    events: eventsMap([
      ['PMR-PAUSED', costJournal('PMR-PAUSED', 'paused')],
      ['PMR-HALTED', costJournal('PMR-HALTED', 'halted')],
      ['PMR-DONE', costJournal('PMR-DONE', 'done')],
      // A run-start with no loop-state projects a state with NO loop record,
      // which is not "running" — exactly what the gate must refuse.
      [
        'PMR-NO-LOOP',
        [
          {
            kind: 'run-start',
            at: AT_START,
            ref: 'PMR-NO-LOOP',
            mode: 'personal',
          },
        ],
      ],
      ['PMR-NULL-STATE', nullProjectionJournal('PMR-NULL-STATE')],
    ]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(t.posts, [])
  assert.deepEqual(t.warns, [])
  assert.deepEqual(report, { scanned: 5, pushed: 0, skipped: 5, failed: 0 })
  // the gate is the cheap read: the rollup never runs, so each ref is read once
  assert.deepEqual(t.reads, refs)
})

test('runLivenessPassOnce: an absent journal is skipped, not failed', async () => {
  const t = fakeEngine({
    refs: [REF, 'PMR-GONE'],
    events: eventsMap([
      [REF, costJournal(REF, 'running')],
      ['PMR-GONE', null],
    ]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 2, pushed: 1, skipped: 1, failed: 0 })
  assert.equal(t.posts[0]?.trackRef, TRACK_REF)
})

test('runLivenessPassOnce: an empty-rollup running ref is pushed health-only (ISC-10)', async () => {
  const t = fakeEngine({
    refs: [REF],
    events: eventsMap([[REF, healthOnlyJournal(REF, 'running')]]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 1, pushed: 1, skipped: 0, failed: 0 })
  const body = t.posts[0]?.body ?? ''
  assert.ok(body.includes(healthLine(REF)), body)
  assert.match(body, /pi_flow_run_start_seconds\{/)
  assert.equal(body.includes('pi_flow_run_cost_usd'), false)
  assert.equal(body.includes('pi_flow_tokens_total'), false)
})

// AIDEV-NOTE (PMR-8MQH review P2): the empty-rollup push is keyed by
// trackRef, and a work-mode journal's trackRef is the SHARED Jira key —
// a health-only body there would erase the previous run's cost series of
// the same issue. Such refs must be skipped until a cost-bearing rollup
// exists (the `ok` path keeps its full-re-render semantics).
test('runLivenessPassOnce: an empty-rollup WORK-mode ref (trackRef != ref) is skipped, never POSTed', async () => {
  const workJournal: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: AT_START,
      ref: REF,
      mode: 'work',
      trackRef: TRACK_REF,
    },
    loopEvent(REF, 'running', '2026-11-24T06:00:09.000Z'),
  ]
  const t = fakeEngine({
    refs: [REF, 'PMR-OK'],
    events: eventsMap([
      [REF, workJournal],
      ['PMR-OK', healthOnlyJournal('PMR-OK', 'running')],
    ]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 2, pushed: 1, skipped: 1, failed: 0 })
  assert.deepEqual(
    t.posts.map((post) => post.trackRef),
    ['PMR-OK'],
  )
  assert.equal(t.warns.length, 0)
})

// ---- failures never escape the pass (ISC-5) ------------------------------

test('runLivenessPassOnce: a gateway failure is one warn and failed++, the pass still resolves', async () => {
  const t = fakeEngine({
    refs: [REF, 'PMR-OTHER'],
    events: eventsMap([
      [REF, costJournal(REF, 'running')],
      ['PMR-OTHER', healthOnlyJournal('PMR-OTHER', 'running')],
    ]),
    pushFailsFor: [TRACK_REF],
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(report, { scanned: 2, pushed: 1, skipped: 0, failed: 1 })
  assert.equal(t.posts.length, 2)
  assert.equal(t.warns.length, 1)
  assert.match(t.warns[0] ?? '', new RegExp(`liveness ${REF}`))
  assert.match(t.warns[0] ?? '', /503/)
})

test('runLivenessPassOnce: a throwing read or push counts that ref as failed and never rejects', async () => {
  const read = fakeEngine({
    refs: ['PMR-BROKEN', 'PMR-OK'],
    events: eventsMap([['PMR-OK', healthOnlyJournal('PMR-OK', 'running')]]),
    readThrowsFor: ['PMR-BROKEN'],
  })
  const readReport = await runLivenessPassOnce(read.deps)
  assert.deepEqual(readReport, { scanned: 2, pushed: 1, skipped: 0, failed: 1 })
  assert.equal(read.warns.length, 1)
  assert.match(read.warns[0] ?? '', /liveness PMR-BROKEN/)
  assert.match(read.warns[0] ?? '', /journal read exploded/)

  const pushed = fakeEngine({
    refs: [REF],
    events: eventsMap([[REF, healthOnlyJournal(REF, 'running')]]),
    pushThrowsFor: [REF],
  })
  const pushReport = await runLivenessPassOnce(pushed.deps)
  assert.deepEqual(pushReport, { scanned: 1, pushed: 0, skipped: 0, failed: 1 })
  assert.match(pushed.warns[0] ?? '', /push threw for/)
})

test('runLivenessPassOnce: a failing enumeration warns once and resolves an empty report', async () => {
  const warns: string[] = []
  const deps: LivenessDeps = {
    listJournalRefs: async () => {
      throw new Error('runs dir is gone')
    },
    readRunEvents: async () => null,
    listAssignmentRecords: () => [],
    readSessionFile: () => null,
    pushBody: async () => ({ ok: true }),
    warn: (message) => {
      warns.push(message)
    },
  }
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 0, pushed: 0, skipped: 0, failed: 0 })
  assert.equal(warns.length, 1)
  assert.match(warns[0] ?? '', /liveness: journal enumeration failed/)
  assert.match(warns[0] ?? '', /runs dir is gone/)
})

// ---- the pre-push re-check (ISC-8) ---------------------------------------

test('runLivenessPassOnce: a ref that goes terminal between rollup and POST is skipped, no POST (ISC-8)', async () => {
  const running = costJournal(REF, 'running')
  const terminal = costJournal(REF, 'done')
  const t = fakeEngine({
    refs: [REF],
    scripts: new Map([[REF, [running, running, terminal]]]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(t.posts, [])
  assert.deepEqual(t.warns, [])
  assert.deepEqual(report, { scanned: 1, pushed: 0, skipped: 1, failed: 0 })
  // gate read, rollup read, pre-push re-check read
  assert.deepEqual(t.reads, [REF, REF, REF])
})

test('runLivenessPassOnce: a journal that vanishes before the POST is skipped', async () => {
  const running = costJournal(REF, 'running')
  const t = fakeEngine({
    refs: [REF],
    scripts: new Map([[REF, [running, running, null]]]),
  })
  const report = await runLivenessPassOnce(t.deps)
  assert.deepEqual(t.posts, [])
  assert.deepEqual(report, { scanned: 1, pushed: 0, skipped: 1, failed: 0 })
})

// ---- the env gate closes the whole pass (ISC-4) --------------------------

test('runLivenessPassOnce: env unset means null deps, so no pass is wired and no io happens (ISC-4)', async () => {
  const dir = agentDir()
  await writeJournal(dir, healthOnlyJournal(REF, 'running'))
  const before = await journalFiles(dir)
  let readdirCalls = 0
  let fetchCalls = 0
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1
      return { status: 202, statusText: 'Accepted' }
    },
    readdir: async () => {
      readdirCalls += 1
      return []
    },
  })
  // The daemon's contract (3.2): a null deps value means no timer and no
  // pass, so the engine is never even handed a deps object.
  assert.equal(deps, null)
  assert.equal(readdirCalls, 0)
  assert.equal(fetchCalls, 0)
  assert.deepEqual(await journalFiles(dir), before)
})

// ---- the wired path end to end, on real journals -------------------------

test('runLivenessPassOnce: wired deps POST the work group URL from real journals (ISC-1/7)', async () => {
  const dir = agentDir()
  await writeJournal(dir, costJournal(REF, 'running'))
  const { calls, fetchImpl } = fakeFetch()
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl,
  })
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 1, pushed: 1, skipped: 0, failed: 0 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(
    calls[0]?.url,
    'https://g:4479/metrics/job/pi-flow/ref/DP-253/mode/work',
  )
  const body = calls[0]?.body ?? ''
  assert.ok(body.includes(healthLine(TRACK_REF)), body)
  // the journaled session file does not exist here: a coverage gap renders
  // NO cost series (never an invented zero), only health lines.
  assert.equal(body.includes('pi_flow_run_cost_usd'), false)
})

test('runLivenessPassOnce: wired deps render real cost lines from a real session file', async () => {
  const dir = agentDir()
  const session = path.join(dir, 'main-session.jsonl')
  await fs.writeFile(session, costSessionBody(), 'utf8')
  const events = costJournal(REF, 'running').map((event) => {
    if (event.kind !== 'main-session') return event
    return { ...event, sessionFile: session }
  })
  await writeJournal(dir, events)
  const { calls, fetchImpl } = fakeFetch()
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl,
  })
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 1, pushed: 1, skipped: 0, failed: 0 })
  assert.match(calls[0]?.body ?? '', /pi_flow_run_cost_usd\{[^}]*\} 0\.5\n/)
  assert.match(
    calls[0]?.body ?? '',
    /pi_flow_tokens_total\{[^}]*kind="input"[^}]*\} 10/,
  )
})

test('runLivenessPassOnce: a mixed pass reports every count and one summary line', async () => {
  const dir = agentDir()
  await writeJournal(dir, costJournal('PMR-RUN', 'running'))
  await writeJournal(dir, costJournal('PMR-PAUSED', 'paused'))
  const { calls, fetchImpl } = fakeFetch()
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl,
    // enumerate a third ref that has no journal file at all
    readdir: async (wanted: string) => {
      const names = await fs.readdir(wanted)
      names.push('PMR-GONE.journal.jsonl')
      return names
    },
  })
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 3, pushed: 1, skipped: 2, failed: 0 })
  assert.equal(
    livenessSummaryLine(report),
    'liveness pass: scanned=3 pushed=1 skipped=2 failed=0',
  )
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0]?.url,
    'https://g:4479/metrics/job/pi-flow/ref/DP-253/mode/work',
  )
})

// ---- the engine never writes to the runs dir (ISC-A-1) -------------------

test('runLivenessPassOnce never writes to the runs dir (ISC-A-1)', async () => {
  const dir = agentDir()
  await writeJournal(dir, costJournal(REF, 'running'))
  await writeJournal(dir, healthOnlyJournal('PMR-HEALTH', 'running'))
  await writeJournal(dir, costJournal('PMR-HALTED', 'halted'))
  const before = await journalFiles(dir)
  const { calls, fetchImpl } = fakeFetch()
  const deps = createLivenessDeps({
    agentDir: dir,
    warn: () => {},
    env: { PI_FLOW_PUSHGATEWAY_URL: URL },
    fetchImpl,
  })
  if (deps === null) throw new Error('expected wired deps')
  const report = await runLivenessPassOnce(deps)
  assert.deepEqual(report, { scanned: 3, pushed: 2, skipped: 1, failed: 0 })
  assert.equal(calls.length, 2)
  const after = await journalFiles(dir)
  assert.deepEqual(after, before)
  // no run-state projection file was ever written next to the journals
  assert.equal(
    [...after.keys()].some((name) => name.endsWith('.json')),
    false,
  )
})

// ---------------------------------------------------------------------------
// module contract: flow/liveness.ts stays node-only (the daemon imports it
// in 3.2, so the guard lands with the module, not with the timer)
// ---------------------------------------------------------------------------

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const livenessPath = path.join(packageDir, 'flow', 'liveness.ts')

/** Everything flow/liveness.ts may import (node built-ins are implicit). */
const LIVENESS_ALLOWED = [
  '../run-state.ts',
  './cost-rows.ts',
  './push.ts',
  './reconcile-deps.ts',
  '@gtheys/pi-interactive-subagents/assignments',
  '@gtheys/pi-interactive-subagents/usage',
]

function isAllowed(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return LIVENESS_ALLOWED.includes(specifier)
}

/** Strip comments so header prose can never look like an import. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function importSpecifiers(source: string): string[] {
  const code = withoutComments(source)
  const specifiers: string[] = []
  for (const pattern of [
    /from\s*['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let match = pattern.exec(code)
    while (match) {
      specifiers.push(match[1])
      match = pattern.exec(code)
    }
  }
  return specifiers
}

test('flow/liveness.ts imports stay inside the node-only allowlist', () => {
  const specifiers = importSpecifiers(readFileSync(livenessPath, 'utf8'))
  assert.ok(specifiers.length > 0, 'expected the scanner to find imports')
  for (const specifier of specifiers) {
    assert.ok(
      isAllowed(specifier),
      `flow/liveness.ts must not import ${specifier}; allowed: node:*, ${LIVENESS_ALLOWED.join(', ')}`,
    )
  }
})

test('the liveness import guard rejects the package root and the pi runtime', () => {
  assert.ok(!isAllowed('@gtheys/pi-interactive-subagents'))
  assert.ok(!isAllowed('@earendil-works/pi-coding-agent'))
  assert.ok(!isAllowed('../config.ts'))
  assert.ok(!isAllowed('./cost.ts'))
  assert.ok(!isAllowed('./reconcile.ts'))
  assert.ok(isAllowed('@gtheys/pi-interactive-subagents/assignments'))
  assert.ok(isAllowed('node:fs'))
})

// AIDEV-NOTE (PMR-8MQH 2.2): the two write-side invariants of the liveness
// pass, locked textually because the import allowlist cannot see them: both
// `fetchGroupBody` and the journal appenders live in ALREADY-ALLOWED modules
// (`./push.ts`, `../run-state.ts`), so only a source scan refuses them.
// ISC-A-5: a group read-back would re-POST a partial body and drop the series
// the terminal push owns; ISC-A-1: the daemon must never write run evidence.
test('flow/liveness.ts never reads a group back and never appends journal events (ISC-A-1/5)', () => {
  const code = withoutComments(readFileSync(livenessPath, 'utf8'))
  const forbidden = [
    'fetchGroupBody',
    'GroupBodyResult',
    'recordRunEvent',
    'recordRunEventJournalOnly',
    'appendFile',
    'writeFile',
    'mkdir',
  ]
  for (const symbol of forbidden) {
    assert.ok(
      !code.includes(symbol),
      `flow/liveness.ts must not reference ${symbol}`,
    )
  }
})
