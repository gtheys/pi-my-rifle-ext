// AIDEV-NOTE: PMR-8MQH 3.2 — tests for the daemon liveness timer
// (server/daemon.ts `startLivenessTimer`), the liveness wiring of the shared
// `startPeriodicPassTimer` factory. Mirrors test/server-reconcile-timer.test.ts
// case for case: the scheduler is injected so the 60s-first-pass / configured
// interval policy is testable in milliseconds, the gate is
// `PI_FLOW_PUSHGATEWAY_URL`, and the settings source is the REAL liveness
// reader over a mkdtemp agent dir — a config file mutated between passes must
// change the next delay, which is the only way to prove the "re-read each
// pass" contract (interval and enabled changes apply without a daemon
// restart). runPass is injected so no gateway io happens.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { LivenessReport } from '../flow/liveness.ts'
import { globalConfigPath } from '../flow/reconcile-deps.ts'
import {
  LIVENESS_FIRST_PASS_DELAY_MS,
  LIVENESS_MINUTE_MS,
  type ReconcileTimerHandle,
  startLivenessTimer,
} from '../server/daemon.ts'
import { mkTmpDir } from './tmpdir.ts'

const GATEWAY_ENV = { PI_FLOW_PUSHGATEWAY_URL: 'https://g:4479' }

interface FakeTimer {
  armed: { ms: number; fn: () => void; cancelled: boolean; refed: boolean }[]
  schedule: (fn: () => void, ms: number) => ReconcileTimerHandle
  fire: (index?: number) => void
}

function fakeScheduler(): FakeTimer {
  const armed: FakeTimer['armed'] = []
  return {
    armed,
    schedule: (fn, ms) => {
      const entry = { ms, fn, cancelled: false, refed: true }
      armed.push(entry)
      return {
        cancel: () => {
          entry.cancelled = true
        },
        hasRef: () => entry.refed && !entry.cancelled,
      }
    },
    fire: (index = armed.length - 1) => {
      const entry = armed[index]
      if (entry === undefined) throw new Error('nothing armed to fire')
      entry.fn()
    },
  }
}

function report(overrides: Partial<LivenessReport> = {}): LivenessReport {
  return { scanned: 3, pushed: 2, skipped: 1, failed: 0, ...overrides }
}

async function configuredDir(raw: string | null): Promise<string> {
  const dir = mkTmpDir('pi-flow-liveness-timer-')
  if (raw !== null) {
    const file = globalConfigPath(dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, raw, 'utf8')
  }
  return dir
}

/** Let the timer's async chain settle (no timers are waited on). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  }
}

test('liveness timer: enabled=false at startup creates no timer at all', async () => {
  const dir = await configuredDir('{"liveness":{"enabled":false}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return Promise.resolve(report())
    },
  })
  await settle()
  assert.deepEqual(timers.armed, [])
  assert.equal(passes, 0)
  assert.match(logs.join('\n'), /disabled/i)
  timer.cancel()
})

test('liveness timer: unset PI_FLOW_PUSHGATEWAY_URL creates no timer, logged once', async () => {
  const dir = await configuredDir(null)
  const logs: string[] = []
  const timers = fakeScheduler()
  const timer = startLivenessTimer({
    agentDir: dir,
    env: {},
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => Promise.resolve(report()),
  })
  await settle()
  assert.deepEqual(timers.armed, [])
  assert.equal(
    logs.filter((line) => /PI_FLOW_PUSHGATEWAY_URL/.test(line)).length,
    1,
  )
  assert.match(
    logs.filter((line) => /PI_FLOW_PUSHGATEWAY_URL/.test(line))[0] ?? '',
    /^liveness: /,
  )
  timer.cancel()
})

test('liveness timer: first pass is the 60s delay, then the configured interval', async () => {
  const dir = await configuredDir('{"liveness":{"intervalMinutes":120}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return Promise.resolve(report())
    },
  })
  await settle()
  assert.equal(timers.armed.length, 1)
  assert.equal(timers.armed[0]?.ms, LIVENESS_FIRST_PASS_DELAY_MS)
  assert.equal(LIVENESS_FIRST_PASS_DELAY_MS, 60_000)

  timers.fire()
  await settle()
  assert.equal(passes, 1)
  assert.equal(timers.armed.length, 2)
  assert.equal(timers.armed[1]?.ms, 120 * LIVENESS_MINUTE_MS)
  // one summary line per pass (plan behavior step 6)
  assert.equal(
    logs.filter((line) => line.startsWith('liveness pass:')).length,
    1,
  )
  assert.match(
    logs.find((line) => line.startsWith('liveness pass:')) ?? '',
    /scanned=3 pushed=2 skipped=1 failed=0/,
  )
  timer.cancel()
})

test('liveness timer: the settings file is re-read every pass (interval AND enabled)', async () => {
  const dir = await configuredDir('{"liveness":{"intervalMinutes":120}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return Promise.resolve(report())
    },
  })
  await settle()

  // Mutate the file between passes — no restart, and the next delay follows.
  await fs.writeFile(
    globalConfigPath(dir),
    '{"liveness":{"intervalMinutes":5}}\n',
    'utf8',
  )
  timers.fire()
  await settle()
  assert.equal(passes, 1)
  assert.equal(timers.armed[1]?.ms, 5 * LIVENESS_MINUTE_MS)

  // Flipping enabled off mid-life skips the pass but keeps the chain armed
  // (plan: "Each pass: settings disabled ⇒ skip"), so re-enabling later needs
  // no daemon restart.
  await fs.writeFile(
    globalConfigPath(dir),
    '{"liveness":{"enabled":false,"intervalMinutes":7}}\n',
    'utf8',
  )
  timers.fire()
  await settle()
  assert.equal(passes, 1)
  assert.equal(timers.armed[2]?.ms, 7 * LIVENESS_MINUTE_MS)
  assert.equal(logs.filter((line) => /disabled/i.test(line)).length, 1)

  await fs.writeFile(
    globalConfigPath(dir),
    '{"liveness":{"intervalMinutes":9}}\n',
    'utf8',
  )
  timers.fire()
  await settle()
  assert.equal(passes, 2)
  assert.equal(timers.armed[3]?.ms, 9 * LIVENESS_MINUTE_MS)
  timer.cancel()
})

test('liveness timer: a pass in flight never stacks — the next tick skips', async () => {
  const dir = await configuredDir('{"liveness":{"intervalMinutes":1}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  // Object holder, not a bare `let`: TS narrows a captured-and-assigned `let`
  // to `never` after a null guard, which would hide the real assertion.
  const held: { release: (() => void) | null } = { release: null }
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return new Promise<LivenessReport>((resolve) => {
        held.release = () => {
          resolve(report())
        }
      })
    },
  })
  await settle()

  timers.fire() // pass 1 starts and stays in flight
  await settle()
  assert.equal(passes, 1)
  timers.fire() // the interval elapsed while pass 1 still runs
  await settle()
  assert.equal(passes, 1, 'a second pass must not stack behind the first')
  assert.match(logs.join('\n'), /still running/)

  if (held.release === null) throw new Error('pass never started')
  held.release() // pass 1 finishes; the chain continues normally
  await settle()
  assert.equal(passes, 1)
  timers.fire()
  await settle()
  assert.equal(passes, 2)
  timer.cancel()
})

test('liveness timer: pass failures are logged, the chain survives', async () => {
  const dir = await configuredDir('{"liveness":{"intervalMinutes":1}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return Promise.reject(new Error('gateway exploded'))
    },
  })
  await settle()
  timers.fire()
  await settle()
  assert.match(logs.join('\n'), /gateway exploded/)
  assert.equal(timers.armed.length, 2)
  timers.fire()
  await settle()
  assert.equal(passes, 2, 'a failed pass must not poison the schedule')
  timer.cancel()
})

test('liveness timer: createLivenessDeps returning null (gate closed late) reports nothing', async () => {
  // The factory maps a null report to "no summary line" — the adapter's
  // default runPass must produce null when the gateway env has gone away
  // after startup (2.2 handoff). With runPass injected we simulate exactly
  // that "no pass" shape.
  const dir = await configuredDir('{"liveness":{"intervalMinutes":1}}')
  const logs: string[] = []
  const timers = fakeScheduler()
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
    schedule: timers.schedule,
    runPass: () => Promise.resolve(null),
  })
  await settle()
  timers.fire()
  await settle()
  assert.equal(
    logs.filter((line) => line.startsWith('liveness pass:')).length,
    0,
  )
  assert.equal(timers.armed.length, 2)
  timer.cancel()
})

test('liveness timer: cancel() stops the chain and the pending handle', async () => {
  const dir = await configuredDir(null)
  const timers = fakeScheduler()
  let passes = 0
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: () => {},
    schedule: timers.schedule,
    runPass: () => {
      passes += 1
      return Promise.resolve(report())
    },
  })
  await settle()
  assert.equal(timers.armed.length, 1)
  timer.cancel()
  assert.equal(timers.armed[0]?.cancelled, true)
  timers.fire()
  await settle()
  assert.equal(passes, 0)
})

// AIDEV-NOTE: keepalive contract (plan risk 7) — the liveness timer must NEVER
// be unref'd, so the default scheduler's handle reports ref'd. An unref here
// would let the daemon exit between passes if the poll interval ever moves.
test('liveness timer: the real scheduler arms a REFED (keepalive) timer', async () => {
  const dir = await configuredDir(null)
  const logs: string[] = []
  const timer = startLivenessTimer({
    agentDir: dir,
    env: GATEWAY_ENV,
    log: (message) => {
      logs.push(message)
    },
  })
  await settle()
  assert.equal(timer.hasRef(), true, "liveness timer must stay ref'd")
  timer.cancel()
  assert.equal(timer.hasRef(), false)
})
