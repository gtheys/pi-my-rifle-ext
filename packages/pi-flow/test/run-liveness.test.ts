// AIDEV-NOTE (PMR-8MQH 2.1): tests for flow/liveness.ts — the node-only
// settings reader + io wiring behind the daemon's running-flow liveness push.
// Subtask 2.2 appends the engine (`runLivenessPassOnce`) cases to THIS file;
// the module's node-only import contract is already locked here (bottom
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
  type LivenessSettings,
  parseLivenessSettings,
} from '../flow/liveness.ts'
import type { PushFetch, PushResult } from '../flow/push.ts'
import { type FlowRunEvent, recordRunEventJournalOnly } from '../run-state.ts'
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
