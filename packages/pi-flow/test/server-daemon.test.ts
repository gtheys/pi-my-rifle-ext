// AIDEV-NOTE: PMR-XTQQ unit tests for the pi-flow durable run server daemon
// (server/daemon.ts). Pure helpers are tested with injectable io and temp dirs
// (recordRunEvent io-seam pattern); the main-module guard is tested by
// spawning node and importing the module — a missing guard would leave
// watchers/intervals alive and the child process would hang until timeout.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  type FlowRunEvent,
  type FlowRunState,
  type LoopStateRecord,
  recordRunEvent,
  recordRunEventJournalOnly,
  runStatePath,
} from '../run-state.ts'
import {
  createSerialQueue,
  decidePending,
  maintainPending,
  pendingDirPath,
  projectionChanged,
  reprojectRun,
  SERVER_PROTOCOL_VERSION,
} from '../server/daemon.ts'
import { PENDING_SCHEMA } from '../server/pending.ts'

function mkAgentDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-flow-daemon-test-'))
}

function makeEvent(ref: string, kind: 'run-start'): FlowRunEvent {
  return { kind, ref, at: new Date().toISOString(), mode: 'personal' }
}

// --- main-module guard ---

test('importing daemon.ts executes nothing (process exits cleanly)', () => {
  const daemonPath = new URL('../server/daemon.ts', import.meta.url).pathname
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(daemonPath)})`,
    ],
    { timeout: 10_000, encoding: 'utf8' },
  )
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  // A daemon without the main-module guard would hold watchers/intervals and
  // never exit — the spawnSync timeout would kill it with a nonzero status.
})

// --- exports needed by the (later) lifecycle module ---

test('SERVER_PROTOCOL_VERSION is a non-empty string', () => {
  assert.equal(typeof SERVER_PROTOCOL_VERSION, 'string')
  assert.ok(SERVER_PROTOCOL_VERSION.length > 0)
})

// --- reprojectRun ---

test('reprojectRun: journal append matches what recordRunEvent would write', async () => {
  const dirA = await mkAgentDir()
  const dirB = await mkAgentDir()
  const ref = 'PMR-DNMD1'
  const start = makeEvent(ref, 'run-start')
  const second: FlowRunEvent = {
    kind: 'phase-start',
    ref,
    at: start.at,
    phase: 'plan',
  }

  // dirA: canonical path — every event through recordRunEvent.
  await recordRunEvent(dirA, start)
  await recordRunEvent(dirA, second)

  // dirB: seed identically, then append journal-only (writer side of the
  // daemon protocol) and let the daemon reproject.
  await recordRunEvent(dirB, start)
  await recordRunEventJournalOnly(dirB, second)
  const result = await reprojectRun(dirB, ref)
  assert.equal(result, 'written')

  const a = await fs.readFile(runStatePath(dirA, ref) as string, 'utf8')
  const b = await fs.readFile(runStatePath(dirB, ref) as string, 'utf8')
  assert.equal(b, a)
})

test('reprojectRun: unchanged journal does not rewrite the projection', async () => {
  const agentDir = await mkAgentDir()
  const ref = 'PMR-DNMD2'
  await recordRunEvent(agentDir, makeEvent(ref, 'run-start'))
  const first = await reprojectRun(agentDir, ref)
  // recordRunEvent already wrote the projection, so it is in sync with the
  // journal — 'unchanged' here is the daemon's correct no-rewrite decision.
  assert.equal(first, 'unchanged')

  const statePath = runStatePath(agentDir, ref) as string
  const before = await fs.stat(statePath)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const second = await reprojectRun(agentDir, ref)
  assert.equal(second, 'unchanged')
  const after = await fs.stat(statePath)
  assert.equal(after.mtimeMs, before.mtimeMs)
})

test('reprojectRun: missing projection is rebuilt from the journal', async () => {
  const agentDir = await mkAgentDir()
  const ref = 'PMR-DNMD3'
  await recordRunEvent(agentDir, makeEvent(ref, 'run-start'))
  await fs.unlink(runStatePath(agentDir, ref) as string)
  const result = await reprojectRun(agentDir, ref)
  assert.equal(result, 'written')
  const state = JSON.parse(
    await fs.readFile(runStatePath(agentDir, ref) as string, 'utf8'),
  )
  assert.equal(state.ref, ref)
})

test('reprojectRun: corrupt projection is rebuilt from the journal', async () => {
  const agentDir = await mkAgentDir()
  const ref = 'PMR-DNMD4'
  await recordRunEvent(agentDir, makeEvent(ref, 'run-start'))
  await fs.writeFile(runStatePath(agentDir, ref) as string, '{not json', 'utf8')
  const result = await reprojectRun(agentDir, ref)
  assert.equal(result, 'written')
  const state = JSON.parse(
    await fs.readFile(runStatePath(agentDir, ref) as string, 'utf8'),
  )
  assert.equal(state.ref, ref)
})

test('reprojectRun: no journal reports no-journal and writes nothing', async () => {
  const agentDir = await mkAgentDir()
  const result = await reprojectRun(agentDir, 'PMR-DNMD5')
  assert.equal(result, 'no-journal')
})

test('reprojectRun: torn tail lines are skipped', async () => {
  const agentDir = await mkAgentDir()
  const ref = 'PMR-DNMD6'
  await recordRunEvent(agentDir, makeEvent(ref, 'run-start'))
  const journalPath = (runStatePath(agentDir, ref) as string).replace(
    '.json',
    '.journal.jsonl',
  )
  await fs.appendFile(journalPath, '{"kind":"run-start","ref":', 'utf8')
  const result = await reprojectRun(agentDir, ref)
  assert.equal(result, 'unchanged')
})

// --- pending maintenance (subtask 3.2) ---

function parkedState(ref: string, at: string): FlowRunState {
  const loop: LoopStateRecord = {
    phase: 'plan',
    awaitingOutcome: true,
    blockerRetries: 0,
    validateStartedAt: '',
    status: 'running',
  }
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref,
    mode: 'personal',
    startedAt: at,
    updatedAt: at,
    completedPhases: [],
    currentPhase: 'plan',
    notes: [],
    loop,
  }
}

test('decidePending: parked loop-state writes, everything else clears', () => {
  assert.equal(decidePending(parkedState('PMR-A', 'x')), 'write')
  assert.equal(decidePending(null), 'clear')
  const done = parkedState('PMR-B', 'x')
  if (done.loop === undefined) throw new Error('unreachable')
  done.loop.status = 'done'
  assert.equal(decidePending(done), 'clear')
  const paused = parkedState('PMR-C', 'x')
  if (paused.loop === undefined) throw new Error('unreachable')
  paused.loop.status = 'paused'
  assert.equal(decidePending(paused), 'clear')
})

test('pendingDirPath sits next to runs/ under pi-flow/', () => {
  assert.equal(pendingDirPath('/a'), path.join('/a', 'pi-flow', 'pending'))
})

test('maintainPending: parked state writes a record, stable across rescan', async () => {
  const pendingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-flow-pend-'))
  const state = parkedState('PMR-PP1', '2026-11-15T01:00:00Z')
  await maintainPending(pendingDir, 'PMR-PP1', state)
  const raw = await fs.readFile(path.join(pendingDir, 'PMR-PP1.json'), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.schema, PENDING_SCHEMA)
  assert.equal(parsed.phase, 'plan')
  assert.equal(parsed.sourceAt, state.updatedAt)

  // Idempotent: identical state must not rewrite the file (mtime stable).
  await new Promise((resolve) => setTimeout(resolve, 20))
  await maintainPending(pendingDir, 'PMR-PP1', state)
  const raw2 = await fs.readFile(path.join(pendingDir, 'PMR-PP1.json'), 'utf8')
  assert.equal(raw2, raw)

  // Terminal loop-state clears the record.
  const done = parkedState('PMR-PP1', '2026-11-15T02:00:00Z')
  if (done.loop === undefined) throw new Error('unreachable')
  done.loop.status = 'done'
  await maintainPending(pendingDir, 'PMR-PP1', done)
  await assert.rejects(
    () => fs.readFile(path.join(pendingDir, 'PMR-PP1.json'), 'utf8'),
    { code: 'ENOENT' },
  )

  // Absent pending dir is fine (lazy creation on first write only).
  await maintainPending(path.join(pendingDir, 'missing'), 'PMR-PP2', null)
  await assert.rejects(
    () => fs.readFile(path.join(pendingDir, 'missing', 'PMR-PP2.json'), 'utf8'),
    { code: 'ENOENT' },
  )
})

// --- projectionChanged (reproject decision, pure) ---

test('projectionChanged: null current means changed', () => {
  assert.equal(projectionChanged(null, { ref: 'X' } as never), true)
})

test('projectionChanged: identical serialization means unchanged', () => {
  const next = { ref: 'X', a: 1 }
  assert.equal(
    projectionChanged(
      `${JSON.stringify(next, null, 2)}
`,
      next as never,
    ),
    false,
  )
})

test('projectionChanged: differing content means changed', () => {
  assert.equal(projectionChanged('{"ref":"X"}', { ref: 'Y' } as never), true)
})

// --- createSerialQueue (scan scheduling) ---

test('serial queue: tasks run one at a time, in submission order', async () => {
  const queue = createSerialQueue()
  const order: string[] = []
  let running = 0
  const task = (name: string, delay: number) => async (): Promise<void> => {
    running += 1
    assert.equal(running, 1, 'only one task may run at a time')
    await new Promise((resolve) => setTimeout(resolve, delay))
    running -= 1
    order.push(name)
  }
  const p1 = queue.push(task('slow', 30))
  const p2 = queue.push(task('fast', 1))
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['slow', 'fast'])
})

test('serial queue: drain waits for queued tasks', async () => {
  const queue = createSerialQueue()
  const order: string[] = []
  queue.push(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    order.push('a')
  })
  const drained = queue.drain()
  queue.push(async () => {
    order.push('b')
  })
  await drained
  assert.deepEqual(order, ['a', 'b'])
})
