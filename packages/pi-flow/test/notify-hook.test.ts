// AIDEV-NOTE: PMR-ZV9Y 5.2 — the desktop-notify sink tests. Deliberately a NEW
// file (the additive-test rule, the 4.2/4.3 precedent). The seam pinned here is
// `createNotifySink` plus its composition into
// `createTelemetryHandlers().onStateChange`. The DYNAMIC IMPORT is injected (a
// fake DesktopNotifyModule), so no test touches the real
// '@gtheys/pi-desktop-notify/notify' package, its config file, or a desktop
// notification daemon.
//
// What the suite locks down (the subtask's acceptance criteria):
//   (1) notify fires EXACTLY on waiting_human / halted state-change events,
//       with the documented summary + expected-action body;
//   (2) running / done / waiting_machine / step events never reach the channel,
//       and a disabled `notify.desktop.enabled` gate short-circuits BEFORE the
//       import (zero loads, zero dispatches) — independently disable-able (D3);
//   (3) a missing/broken package degrades to ONE warn note per handler
//       instance and turns the channel off (never a rejected promise into the
//       fan-out, never a throw into the flow loop — ISC-A-5);
//   (4) the notify sink and the Loki sink are guarded INDEPENDENTLY: a throwing
//       half never costs the other, and each switch works with the other off
//       (D3 — pi-flow config for desktop, Grafana's own pause/mute for alerts);
//   (5) fire-and-forget: a hanging module load never delays `record`;
//   (6) the index.ts / package.json / dispatch.ts wiring exists (textual guard,
//       the 4.3 technique) — behaviour is covered above.
//
// DEDUPE POSTURE (decided here, pinned below): ONE notification per
// state-change EVENT, no per-(ref, state, reason) once-guard.
// `flow/loop.ts`'s 2.1 guarded emission already suppresses same-state repeats
// inside a process, so a duplicate only happens when a gate genuinely re-asks
// (waiting_human → running → waiting_human) — which deserves the second page.
// Cross-process re-asks (a resumed run, a second session) re-notify as well;
// accepted, because the notification mirrors the journal, and the journal is
// the audit record the operator reads.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import {
  createEventFanoutWriter,
  createNotifySink,
  createTelemetryHandlers,
  type DesktopNotifyModule,
  type FanoutHandlers,
  type NotifySinkDeps,
  notifyBody,
  notifySummary,
  shouldNotifyState,
} from '../telemetry/dispatch.ts'
import type { LokiFetch } from '../telemetry/loki.ts'

const AT = '2026-11-25T09:25:01.000Z'
const SESSION_CWD = '/home/dev/Code/salaryhero'

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

function sourceOf(relative: string): string {
  return readFileSync(path.resolve(packageDir, relative), 'utf8')
}

type StateChange = Extract<FlowRunEvent, { kind: 'state-change' }>

const WAITING_HUMAN: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'waiting_human',
  reason: 'code_review_pending',
}
const HALTED: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'halted',
  reason: 'label_miss',
}
const RUNNING: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'running',
}
const DONE: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'done',
}
const WAITING_MACHINE: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'waiting_machine',
  reason: 'subagent_in_flight',
}
const STEP_START: FlowRunEvent = {
  kind: 'step-start',
  at: AT,
  ref: 'PMR-ZV9Y',
  phase: 'validate',
  step: 'validate.code-review',
}

/** Let queued microtasks run — the sink is fire-and-forget by contract. */ async function settle(
  rounds = 4,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function probeWriter(): EventWriter {
  return {
    record: async () => true,
    recordJournalOnly: async () => {},
  }
}

/** A fake 5.1 module surface + call ledgers (no notify backend involved). */
interface NotifyFake {
  module: DesktopNotifyModule
  loadedCwds: string[]
  dispatched: { summary: string; body: string }[]
  notes: { ref: string; error: string }[]
  /** dynamic-import seam call count. */
  loads: number
  handlers: FanoutHandlers
  lokiBodies: string[]
}

interface NotifyFakeOptions {
  /** the `notify.desktop.enabled` gate (default: enabled). */
  enabled?: () => boolean
  /** make the dynamic import reject (absent / broken package). */
  importFails?: boolean
  /** make dispatchNotification reject. */
  dispatchFails?: boolean
  /** never resolve the import (the fire-and-forget pin). */
  importHangs?: boolean
  /** hand back a namespace WITHOUT the consumed members (wrong version). */
  brokenModule?: boolean
  /** Loki on/off for the composed bag (default: on). */
  lokiEnabled?: boolean
}

function notifyFake(opts: NotifyFakeOptions = {}): NotifyFake {
  const fake: NotifyFake = {
    module: {
      loadConfig: async (cwd: string) => {
        fake.loadedCwds.push(cwd)
        return { desktop: { enabled: true } }
      },
      dispatchNotification: async (_config, summary, body) => {
        if (opts.dispatchFails === true) {
          throw new Error('notify backend exploded')
        }
        fake.dispatched.push({ summary, body })
      },
    },
    loadedCwds: [],
    dispatched: [],
    notes: [],
    loads: 0,
    handlers: {},
    lokiBodies: [],
  }
  const fetchImpl: LokiFetch = async (_url, init) => {
    fake.lokiBodies.push(init.body)
    return { status: 204 }
  }
  const loadModule = (): Promise<DesktopNotifyModule> => {
    fake.loads += 1
    if (opts.importFails === true) {
      return Promise.reject(
        new Error("Cannot find package '@gtheys/pi-desktop-notify'"),
      )
    }
    if (opts.importHangs === true) {
      return new Promise<DesktopNotifyModule>(() => {})
    }
    if (opts.brokenModule === true) {
      return Promise.resolve({} as unknown as DesktopNotifyModule)
    }
    return Promise.resolve(fake.module)
  }
  fake.handlers = createTelemetryHandlers({
    loki: () => {
      if (opts.lokiEnabled === false) return null
      return { endpoint: 'http://loki.test:3100', headers: {} }
    },
    handle: () => null,
    fetchImpl,
    now: () => Date.parse(AT),
    onNote: () => {},
    env: {},
    notify: {
      desktop: opts.enabled ?? (() => true),
      cwd: () => SESSION_CWD,
      loadModule,
      onNote: (ref, error) => {
        fake.notes.push({ ref, error })
      },
    },
  })
  return fake
}

/** A bare sink over a fake (unit level, no fan-out composition). */
function sinkWith(
  fake: NotifyFake,
  overrides: Partial<NotifySinkDeps> = {},
): (event: StateChange) => void {
  const deps: NotifySinkDeps = {
    desktop: () => true,
    cwd: () => SESSION_CWD,
    loadModule: async () => fake.module,
    onNote: (ref, error) => {
      fake.notes.push({ ref, error })
    },
    ...overrides,
  }
  return createNotifySink(deps)
}

// --- the pure message surface ---------------------------------------------

test('shouldNotifyState: waiting_human + halted page the operator, the rest do not (PMR-ZV9Y 5.2)', () => {
  assert.equal(shouldNotifyState('waiting_human'), true)
  assert.equal(shouldNotifyState('halted'), true)
  // waiting_machine is board material, not a page; running/done/stale silent.
  assert.equal(shouldNotifyState('waiting_machine'), false)
  assert.equal(shouldNotifyState('running'), false)
  assert.equal(shouldNotifyState('done'), false)
  assert.equal(shouldNotifyState('stale'), false)
})

test('notifySummary: the grep-able "pi-flow <ref>: <state>"', () => {
  assert.equal(notifySummary(WAITING_HUMAN), 'pi-flow PMR-ZV9Y: waiting_human')
  assert.equal(notifySummary(HALTED), 'pi-flow PMR-ZV9Y: halted')
})

test('notifyBody: expected action first, then the closed reason', () => {
  assert.equal(
    notifyBody(WAITING_HUMAN),
    '/flow answer PMR-ZV9Y pass|fail — reason: code_review_pending',
  )
  assert.equal(
    notifyBody({ ...WAITING_HUMAN, reason: 'spec_approval_pending' }),
    '/flow answer PMR-ZV9Y approve — reason: spec_approval_pending',
  )
  assert.equal(
    notifyBody({ ...WAITING_HUMAN, reason: 'escalation' }),
    'intervene: /flow PMR-ZV9Y (or fix forward) — reason: escalation',
  )
  // A halt registers no unblock command: the reason + recovery carry it.
  assert.equal(
    notifyBody(HALTED),
    'reason: label_miss — recover with /flow PMR-ZV9Y',
  )
  // A reasonless transition falls back to the recovery command alone.
  assert.equal(notifyBody(RUNNING), 'recover with /flow PMR-ZV9Y')
})

// --- the sink alone -------------------------------------------------------

test('sink: one notification per paging event (no silent in-process dedupe)', async () => {
  const fake = notifyFake()
  const sink = sinkWith(fake)

  sink(HALTED)
  sink(HALTED)
  await settle()

  assert.deepEqual(fake.dispatched, [
    {
      summary: 'pi-flow PMR-ZV9Y: halted',
      body: 'reason: label_miss — recover with /flow PMR-ZV9Y',
    },
    {
      summary: 'pi-flow PMR-ZV9Y: halted',
      body: 'reason: label_miss — recover with /flow PMR-ZV9Y',
    },
  ])
})

test('sink: the module is imported ONCE and reused for later events', async () => {
  let loads = 0
  const fake = notifyFake()
  const sink = createNotifySink({
    desktop: () => true,
    cwd: () => SESSION_CWD,
    loadModule: async () => {
      loads += 1
      return fake.module
    },
    onNote: (ref, error) => {
      fake.notes.push({ ref, error })
    },
  })

  sink(WAITING_HUMAN)
  await settle()
  sink(HALTED)
  await settle()

  assert.equal(loads, 1)
  assert.equal(fake.dispatched.length, 2)
})

test('sink: config off → ZERO imports and ZERO dispatches', async () => {
  const fake = notifyFake()
  const sink = sinkWith(fake, { desktop: () => false })

  sink(WAITING_HUMAN)
  sink(HALTED)
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.deepEqual([fake.loads, fake.notes.length], [0, 0])
})

test('sink: non-paging states never load the module', async () => {
  const fake = notifyFake()
  const sink = sinkWith(fake)

  sink(RUNNING)
  sink(DONE)
  sink(WAITING_MACHINE)
  await settle()

  assert.deepEqual([fake.loads, fake.dispatched.length], [0, 0])
})

test('sink: a throwing desktop getter is swallowed, notifies nothing, stays off', async () => {
  const fake = notifyFake()
  const sink = sinkWith(fake, {
    desktop: () => {
      throw new Error('config exploded')
    },
  })

  assert.doesNotThrow(() => {
    sink(WAITING_HUMAN)
  })
  await settle()
  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.notes.length, 1)
})

test('sink: a module namespace without the consumed surface notes once', async () => {
  // A wrong-version pi-desktop-notify: the import resolves but the members do
  // not exist, so the TypeError is a channel failure (ONE line, then off).
  const fake = notifyFake({ brokenModule: true })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true, 'never-throw')
  await fanout.record(HALTED)
  await settle()

  assert.equal(fake.notes.length, 1, 'ONE warn line')
  assert.equal(fake.loads, 1, 'not retried per event')
  assert.deepEqual(fake.dispatched, [])
})

// --- composition into createTelemetryHandlers -----------------------------

test('waiting_human through the fan-out notifies with the expected-action body', async () => {
  const fake = notifyFake()
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true)
  await settle()

  assert.deepEqual(fake.dispatched, [
    {
      summary: 'pi-flow PMR-ZV9Y: waiting_human',
      body: '/flow answer PMR-ZV9Y pass|fail — reason: code_review_pending',
    },
  ])
  assert.deepEqual(
    fake.loadedCwds,
    [SESSION_CWD],
    'pi-desktop-notify loads ITS OWN config with the session cwd',
  )
  assert.equal(fake.lokiBodies.length, 1, 'the Loki sink ran too')
})

test('halted through the fan-out notifies (reason + recovery body)', async () => {
  const fake = notifyFake()
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.record(HALTED)
  await settle()

  assert.deepEqual(fake.dispatched, [
    {
      summary: 'pi-flow PMR-ZV9Y: halted',
      body: 'reason: label_miss — recover with /flow PMR-ZV9Y',
    },
  ])
})

test('running/done/waiting_machine and step events never notify', async () => {
  const fake = notifyFake()
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.record(RUNNING)
  await fanout.record(DONE)
  await fanout.record(WAITING_MACHINE)
  await fanout.record(STEP_START)
  await fanout.record({ kind: 'run-start', at: AT, ref: 'PMR-A', mode: 'work' })
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.loads, 0, 'the package is never even imported')
})

test('notify.desktop.enabled=false → zero calls, no warn (independent disable, D3)', async () => {
  const fake = notifyFake({ enabled: () => false })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.record(WAITING_HUMAN)
  await fanout.record(HALTED)
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.loads, 0)
  assert.deepEqual(fake.notes, [], 'a disabled channel is not a failure')
})

test('loki disabled still notifies — the two channels are independent (D3)', async () => {
  const fake = notifyFake({ lokiEnabled: false })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.record(WAITING_HUMAN)
  await settle()

  assert.deepEqual(fake.lokiBodies, [])
  assert.equal(fake.dispatched.length, 1)
})

test('notify disabled still pushes Loki — the two channels are independent (D3)', async () => {
  const fake = notifyFake({ enabled: () => false })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.record(WAITING_HUMAN)
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.lokiBodies.length, 1)
})

test('recordJournalOnly notifies too (one dispatcher, both seams)', async () => {
  const fake = notifyFake()
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  await fanout.recordJournalOnly(WAITING_HUMAN)
  await settle()

  assert.equal(fake.dispatched.length, 1)
})

test('missing/broken pi-desktop-notify → ONE warn note, channel off, never throws', async () => {
  const fake = notifyFake({ importFails: true })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  assert.equal(
    await fanout.record(WAITING_HUMAN),
    true,
    'never-throw (ISC-A-5)',
  )
  await fanout.record(HALTED)
  await fanout.record(WAITING_HUMAN)
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.notes.length, 1, 'at most ONE warn line')
  assert.match(fake.notes[0].error, /pi-desktop-notify/)
  assert.equal(fake.notes[0].ref, 'PMR-ZV9Y')
  assert.equal(fake.loads, 1, 'a failed import is not retried per event')
  assert.equal(fake.lokiBodies.length, 3, 'the Loki sink is unaffected')
})

test('dispatchNotification rejection → ONE warn note, never a throw', async () => {
  const fake = notifyFake({ dispatchFails: true })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true)
  await fanout.record(HALTED)
  await settle()

  assert.deepEqual(fake.dispatched, [])
  assert.equal(fake.notes.length, 1)
  assert.match(fake.notes[0].error, /notify backend exploded/)
})

test('a hanging module load never delays the journal write (fire-and-forget)', async () => {
  const fake = notifyFake({ importHangs: true })
  const fanout = createEventFanoutWriter(probeWriter(), fake.handlers)

  // `record` resolving while the import promise is still pending is the pin:
  // awaiting the channel here would stall the flow loop.
  assert.equal(await fanout.record(WAITING_HUMAN), true)
  assert.equal(fake.loads, 1)
  assert.deepEqual(fake.dispatched, [])
})

test('a throwing notify gate never costs the Loki push', async () => {
  const fake = notifyFake()
  const handlers = createTelemetryHandlers({
    loki: () => ({ endpoint: 'http://loki.test:3100', headers: {} }),
    handle: () => null,
    fetchImpl: async (_url, init) => {
      fake.lokiBodies.push(init.body)
      return { status: 204 }
    },
    now: () => Date.parse(AT),
    onNote: () => {},
    env: {},
    notify: {
      desktop: () => {
        throw new Error('notify gate exploded')
      },
      cwd: () => SESSION_CWD,
      loadModule: async () => fake.module,
      onNote: () => {},
    },
  })
  const fanout = createEventFanoutWriter(probeWriter(), handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true)
  await settle()

  assert.equal(fake.lokiBodies.length, 1, 'Loki ran despite the notify throw')
})

test('a throwing Loki sink never costs the notify', async () => {
  const fake = notifyFake()
  const handlers = createTelemetryHandlers({
    loki: () => {
      throw new Error('loki settings exploded')
    },
    handle: () => null,
    fetchImpl: async () => ({ status: 204 }),
    now: () => Date.parse(AT),
    onNote: () => {},
    env: {},
    notify: {
      desktop: () => true,
      cwd: () => SESSION_CWD,
      loadModule: async () => fake.module,
      onNote: () => {},
    },
  })
  const fanout = createEventFanoutWriter(probeWriter(), handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true)
  await settle()

  assert.equal(fake.dispatched.length, 1, 'notify ran despite the Loki throw')
})

test('absent notify deps = no channel, no throw (telemetry-only wiring)', async () => {
  const handlers = createTelemetryHandlers({
    loki: () => ({ endpoint: 'http://loki.test:3100', headers: {} }),
    handle: () => null,
    fetchImpl: async () => ({ status: 204 }),
    now: () => Date.parse(AT),
    onNote: () => {},
    env: {},
  })
  const fanout = createEventFanoutWriter(probeWriter(), handlers)

  assert.equal(await fanout.record(WAITING_HUMAN), true)
  assert.equal(await fanout.record(HALTED), true)
  await settle()
})

// --- wiring guards (index.ts + package.json + dispatch.ts) -----------------

test('index.ts wires the notify sink into the production handler bag', () => {
  const index = sourceOf('index.ts')
  assert.ok(
    index.includes('syncNotifySettings('),
    'the notify gate + cwd are synced from the session config reads',
  )
  assert.ok(
    index.includes('notify: {'),
    'createTelemetryHandlers receives the notify deps',
  )
  assert.ok(
    index.includes('resolveNotifySettings'),
    'the typed notify reader is used (no inline default)',
  )
})

test('pi-desktop-notify is an OPTIONAL workspace dependency (absence degrades)', () => {
  const pkg = JSON.parse(sourceOf('package.json')) as {
    optionalDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  assert.equal(
    pkg.optionalDependencies?.['@gtheys/pi-desktop-notify'],
    'workspace:*',
  )
  assert.equal(
    pkg.dependencies?.['@gtheys/pi-desktop-notify'],
    undefined,
    'a hard dependency would break installs without the notify package',
  )
})

test('dispatch.ts reaches pi-desktop-notify DYNAMICALLY only (no static edge)', () => {
  const dispatch = sourceOf('telemetry/dispatch.ts')
  const staticEdges = dispatch
    .split('\n')
    .filter(
      (line) =>
        line.trimStart().startsWith('import') &&
        line.includes('@gtheys/pi-desktop-notify'),
    )
  assert.deepEqual(
    staticEdges,
    [],
    'an optional dependency must never become a static import',
  )
  assert.ok(
    dispatch.includes("'@gtheys/pi-desktop-notify/notify'"),
    'the production loader references the 5.1 ./notify subpath',
  )
})
