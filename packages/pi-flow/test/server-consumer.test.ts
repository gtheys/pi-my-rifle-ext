// Unit tests for the PMR-XTQQ pending-record consumer (server/consumer.ts).
// Fake sender + fake io / fake journal read — no live pi process, no real fs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FlowRunEvent } from '../run-state.ts'
import {
  type ResumeConsumerDeps,
  resumedMessage,
  resumeParkedRun,
} from '../server/consumer.ts'
import {
  consumePending,
  PENDING_SCHEMA,
  type PendingIo,
  type PendingRecord,
} from '../server/pending.ts'

function parkedEvents(ref: string, parked: boolean): FlowRunEvent[] {
  const start: FlowRunEvent = {
    kind: 'run-start',
    at: new Date().toISOString(),
    ref,
    mode: 'personal',
  }
  const event: FlowRunEvent = {
    kind: 'loop-state',
    at: new Date().toISOString(),
    ref,
    loop: {
      phase: 'implement',
      awaitingOutcome: parked,
      blockerRetries: 0,
      validateStartedAt: new Date().toISOString(),
      status: parked ? 'running' : 'paused',
    },
  }
  return [start, event]
}

function validRecord(ref: string): PendingRecord {
  return {
    schema: PENDING_SCHEMA,
    ref,
    phase: 'implement',
    createdAt: new Date().toISOString(),
    sourceAt: new Date().toISOString(),
  }
}

/** Fake io: rename always succeeds, readFile returns a valid record. */
function fakePendingIo(): PendingIo {
  return {
    readFile: async () => JSON.stringify(validRecord('PMR-XTQQ')),
    writeFile: async () => {},
    rename: async () => {},
    unlink: async () => {},
    readdir: async () => [],
    mkdir: async () => {},
  }
}

interface Harness {
  deps: ResumeConsumerDeps
  sent: string[]
  notified: { message: string; level: string }[]
  latch: Set<string>
  setParked: (parked: boolean) => void
}

function harness(overrides?: Partial<ResumeConsumerDeps>): Harness {
  const sent: string[] = []
  const notified: { message: string; level: string }[] = []
  const latch = new Set<string>()
  let parked = true
  const deps: ResumeConsumerDeps = {
    ref: 'PMR-XTQQ',
    agentDir: '/fake/agent',
    pendingDir: '/fake/agent/pi-flow/pending',
    enabled: () => true,
    loopActive: () => false,
    latch,
    notify: (message, level) => notified.push({ message, level }),
    send: (message) => sent.push(message),
    readRunEvents: async () => parkedEvents('PMR-XTQQ', parked),
    consumePending: (
      pendingDir: string,
      ref: string,
      verify: (record: PendingRecord) => Promise<boolean> | boolean,
    ) => consumePending(pendingDir, ref, verify, fakePendingIo()),
    ...overrides,
  }
  return {
    deps,
    sent,
    notified,
    latch,
    setParked: (p: boolean) => {
      parked = p
    },
  }
}

test('parked record + inactive loop + enabled → exactly one /flow injection', async () => {
  const h = harness()
  await resumeParkedRun(h.deps)
  assert.deepEqual(h.sent, ['/flow PMR-XTQQ'])
  assert.deepEqual(
    h.notified.map((n) => n.message),
    [resumedMessage('PMR-XTQQ')],
  )
  assert.ok(h.latch.has('PMR-XTQQ'))
})

test('repeated settles → no duplicates (latch + ENOENT-on-consumed)', async () => {
  const h = harness()
  await resumeParkedRun(h.deps)
  await resumeParkedRun(h.deps)
  await resumeParkedRun(h.deps)
  assert.deepEqual(h.sent, ['/flow PMR-XTQQ'])
})

test('loop active → no consumption attempt at all', async () => {
  let consumeCalls = 0
  const h = harness({
    loopActive: () => true,
    consumePending: async () => {
      consumeCalls += 1
      return { consumed: true }
    },
  })
  await resumeParkedRun(h.deps)
  assert.equal(consumeCalls, 0)
  assert.deepEqual(h.sent, [])
})

test('verify-fail (dropped) → fallback wording, no injection', async () => {
  const h = harness()
  h.setParked(false)
  await resumeParkedRun(h.deps)
  assert.deepEqual(h.sent, [])
  assert.match(h.notified[0].message, /failed verification and was dropped/)
  assert.match(h.notified[0].message, /rerun \/flow PMR-XTQQ/)
})

test('sendUserMessage throws → fallback notify, no crash, latch set', async () => {
  const h = harness({
    send: () => {
      throw new Error('streaming run in flight')
    },
  })
  await resumeParkedRun(h.deps)
  assert.match(h.notified[1].message, /run \/flow PMR-XTQQ to resume/)
  assert.ok(h.latch.has('PMR-XTQQ'))
})

test('runServer disabled → no-op (no consumption, no send)', async () => {
  let consumeCalls = 0
  const h = harness({
    enabled: () => false,
    consumePending: async () => {
      consumeCalls += 1
      return { consumed: true }
    },
  })
  await resumeParkedRun(h.deps)
  assert.equal(consumeCalls, 0)
  assert.deepEqual(h.sent, [])
})

test('nothing pending (ENOENT) → silent no-op', async () => {
  const h = harness({
    consumePending: async () => ({ consumed: false }),
  })
  await resumeParkedRun(h.deps)
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.notified, [])
})
