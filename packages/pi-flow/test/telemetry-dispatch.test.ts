// AIDEV-NOTE: PMR-ZV9Y 4.3 — writer fan-out dispatcher tests. Deliberately a
// NEW file (the additive-test rule). The fan-out wraps the mode-aware
// EventWriter, so what is pinned here is the WRAPPER + RENDERER contract:
//  (1) v2 kinds route (state-change -> onStateChange, step-start/stop ->
//      onStepEvent); every other kind passes through with no v2 handler call;
//  (2) the wrapped writer's own semantics are unchanged — `record` keeps its
//      boolean, so a best-effort false still surfaces as false, never a throw
//      (journaled:false stays reachable for flow_submit);
//  (3) handler failures are swallowed PER SINK, so a throwing Loki push never
//      also costs the Tempo step span (ISC-A-5);
//  (4) `createTelemetryHandlers` is the production handler build: Loki disabled
//      = ZERO fetch calls; enabled = the closed label set with flow_ref/mode
//      derived through runTracking over the run-starts observed at the seam;
//      step events drive TelemetryHandle.stepStart/stepStop and an absent
//      handle is safe;
//  (5) the run-attempt fallback audit (AC-1), end to end.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import {
  type FlowRunEvent,
  readRunEvents,
  recordRunEvent,
} from '../run-state.ts'
import {
  createDaemonAliveProbe,
  createEventWriter,
  type EventWriter,
} from '../server/writer.ts'
import {
  buildEventLokiLabels,
  createEventFanoutWriter,
  createTelemetryHandlers,
  type FanoutHandlers,
  type FanoutIdentity,
  lokiPushSettings,
} from '../telemetry/dispatch.ts'
import type { LokiFetch } from '../telemetry/loki.ts'
import {
  createAttemptLedger,
  registerRunAttemptTool,
} from '../tools/run-attempt.ts'
import { mkTmpDir } from './tmpdir.ts'

const AT = '2026-11-25T09:25:01.000Z'
const IDENTITY: FanoutIdentity = { trackRef: 'DP-236', mode: 'work' }

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

type StateChange = Extract<FlowRunEvent, { kind: 'state-change' }>
type StepStart = Extract<FlowRunEvent, { kind: 'step-start' }>
type StepStop = Extract<FlowRunEvent, { kind: 'step-stop' }>

const STATE_CHANGE: StateChange = {
  kind: 'state-change',
  at: AT,
  ref: 'PMR-ZV9Y',
  state: 'waiting_human',
  reason: 'code_review_pending',
}
const STEP_START: StepStart = {
  kind: 'step-start',
  at: AT,
  ref: 'PMR-ZV9Y',
  phase: 'validate',
  step: 'validate.code-review',
}
const STEP_STOP: StepStop = {
  kind: 'step-stop',
  at: AT,
  ref: 'PMR-ZV9Y',
  phase: 'validate',
  step: 'validate.code-review',
}
const RUN_START: FlowRunEvent = {
  kind: 'run-start',
  at: AT,
  ref: 'PMR-ZV9Y',
  mode: 'work',
  trackRef: 'DP-236',
}

interface WriterProbe {
  writer: EventWriter
  written: FlowRunEvent[]
  /** Flipped by the test: the wrapped writer's own reported outcome. */
  outcome: { ok: boolean }
}

function probeWriter(): WriterProbe {
  const written: FlowRunEvent[] = []
  const outcome = { ok: true }
  return {
    written,
    outcome,
    writer: {
      record: async (event) => {
        written.push(event)
        return outcome.ok
      },
      recordJournalOnly: async (event) => {
        written.push(event)
      },
    },
  }
}

function spyHandlers(): {
  handlers: FanoutHandlers
  states: FlowRunEvent[]
  steps: FlowRunEvent[]
} {
  const states: FlowRunEvent[] = []
  const steps: FlowRunEvent[] = []
  return {
    states,
    steps,
    handlers: {
      onStateChange: (event) => {
        states.push(event)
      },
      onStepEvent: (event) => {
        steps.push(event)
      },
    },
  }
}

// --- createEventFanoutWriter: the routing seam ------------------------------

test('fan-out routes state-change to onStateChange and step kinds to onStepEvent', async () => {
  const probe = probeWriter()
  const spy = spyHandlers()
  const fanout = createEventFanoutWriter(probe.writer, spy.handlers)

  assert.equal(await fanout.record(STATE_CHANGE), true)
  assert.equal(await fanout.record(STEP_START), true)
  assert.equal(await fanout.record(STEP_STOP), true)

  assert.deepEqual(spy.states, [STATE_CHANGE])
  assert.deepEqual(spy.steps, [STEP_START, STEP_STOP])
  assert.equal(probe.written.length, 3, 'every event still reaches the writer')
})

test('fan-out leaves non-v2 kinds unrouted (loop-state, note, attempt-record, step-output)', async () => {
  const probe = probeWriter()
  const spy = spyHandlers()
  const fanout = createEventFanoutWriter(probe.writer, spy.handlers)

  const others: FlowRunEvent[] = [
    RUN_START,
    { kind: 'note', at: AT, ref: 'PMR-A', text: 'a halt reason' },
    {
      kind: 'attempt-record',
      at: AT,
      ref: 'PMR-A',
      tool: 'flow_run_attempt',
      outcome: 'retry',
      attempts: 1,
    },
    {
      kind: 'step-output',
      at: AT,
      ref: 'PMR-A',
      phase: 'validate',
      step: 'validate.deviation',
    },
  ]
  for (const event of others) {
    assert.equal(await fanout.record(event), true)
  }
  assert.deepEqual(spy.states, [], 'no v2 transition happened')
  assert.deepEqual(spy.steps, [], 'step-output is NOT a v2 step boundary')
})

test('fan-out keeps the wrapped writer semantics: false stays false, never throws', async () => {
  const probe = probeWriter()
  const spy = spyHandlers()
  const fanout = createEventFanoutWriter(probe.writer, spy.handlers)

  // The production EventWriter reports a failed best-effort append as false
  // (flow_submit surfaces it as journaled:false). The wrapper forwards that
  // outcome unchanged AND still renders the transition (the Loki push
  // describes the state change, not the durability of the append).
  probe.outcome.ok = false
  assert.equal(
    await fanout.record(STATE_CHANGE),
    false,
    'writer contract intact',
  )
  assert.deepEqual(spy.states, [STATE_CHANGE])
})

test('fan-out routes v2 kinds on recordJournalOnly too (one dispatcher, both seams)', async () => {
  const probe = probeWriter()
  const spy = spyHandlers()
  const fanout = createEventFanoutWriter(probe.writer, spy.handlers)

  await fanout.recordJournalOnly(STATE_CHANGE)
  await fanout.recordJournalOnly(STEP_STOP)
  await fanout.recordJournalOnly({
    kind: 'note',
    at: AT,
    ref: 'PMR-A',
    text: 'x',
  })
  assert.deepEqual(spy.states, [STATE_CHANGE])
  assert.deepEqual(spy.steps, [STEP_STOP])
})

test('a throwing handler is swallowed and never costs later routing', async () => {
  const probe = probeWriter()
  let stateCalls = 0
  const steps: FlowRunEvent[] = []
  const fanout = createEventFanoutWriter(probe.writer, {
    onStateChange: () => {
      stateCalls += 1
      throw new Error('loki sink exploded')
    },
    onStepEvent: (event) => {
      steps.push(event)
    },
  })

  assert.equal(await fanout.record(STATE_CHANGE), true, 'never-throw (ISC-A-5)')
  assert.equal(await fanout.record(STEP_START), true)
  assert.equal(stateCalls, 1)
  assert.deepEqual(steps, [STEP_START], 'the step sink still ran afterwards')
})

test('an empty handler bag is a pure pass-through', async () => {
  const probe = probeWriter()
  const fanout = createEventFanoutWriter(probe.writer, {})
  assert.equal(await fanout.record(STATE_CHANGE), true)
  assert.equal(await fanout.record(STEP_START), true)
  assert.deepEqual(probe.written, [STATE_CHANGE, STEP_START])
})

test('onEvent sees every journaled kind and its throw is swallowed too', async () => {
  const probe = probeWriter()
  const seen: string[] = []
  const spy = spyHandlers()
  const fanout = createEventFanoutWriter(probe.writer, {
    ...spy.handlers,
    onEvent: (event) => {
      seen.push(event.kind)
      throw new Error('identity capture exploded')
    },
  })

  await fanout.record(RUN_START)
  await fanout.record(STATE_CHANGE)
  assert.deepEqual(seen, ['run-start', 'state-change'])
  assert.deepEqual(
    spy.states,
    [STATE_CHANGE],
    'routing survives the observer throw',
  )
})

// --- label derivation -------------------------------------------------------

test('buildEventLokiLabels: closed set only, free text never a label', () => {
  assert.deepEqual(buildEventLokiLabels(STATE_CHANGE, IDENTITY), {
    flow_ref: 'DP-236',
    mode: 'work',
    kind: 'state-change',
    state: 'waiting_human',
    reason: 'code_review_pending',
    wait_kind: 'human',
  })
  assert.deepEqual(buildEventLokiLabels(STEP_START, IDENTITY), {
    flow_ref: 'DP-236',
    mode: 'work',
    kind: 'step-start',
    phase: 'validate',
  })
})

test('buildEventLokiLabels: a reasonless state drops reason AND wait_kind', () => {
  const running: StateChange = {
    kind: 'state-change',
    at: AT,
    ref: 'PMR-ZV9Y',
    state: 'running',
    reason: '',
  }
  const labels = buildEventLokiLabels(running, IDENTITY)
  assert.equal(labels.reason, undefined)
  assert.equal(labels.wait_kind, undefined)
  assert.equal(labels.state, 'running')
  assert.equal(labels.phase, undefined, 'state-change carries no phase')
})

test('lokiPushSettings: disabled / empty endpoint = null = zero network calls', () => {
  assert.equal(
    lokiPushSettings({
      enabled: false,
      endpoint: 'http://x:3100',
      headers: {},
    }),
    null,
  )
  assert.equal(
    lokiPushSettings({ enabled: true, endpoint: '', headers: {} }),
    null,
  )
  assert.deepEqual(
    lokiPushSettings({
      enabled: true,
      endpoint: 'http://100.108.226.64:3100',
      headers: { 'x-scope': 'org-1' },
    }),
    { endpoint: 'http://100.108.226.64:3100', headers: { 'x-scope': 'org-1' } },
  )
})

// --- createTelemetryHandlers: the production handler build ------------------

interface Captured {
  url: string
  body: string
}

function capturingLoki(out: Captured[], fail = false): LokiFetch {
  return async (url, init) => {
    out.push({ url, body: init.body })
    if (fail) throw new Error('connection refused')
    return { status: 204 }
  }
}

function pushKinds(calls: Captured[]): string[] {
  return calls.map((call) => {
    const parsed = JSON.parse(call.body) as {
      streams: Array<{ stream: Record<string, string> }>
    }
    return parsed.streams[0].stream.kind
  })
}

function pushStream(calls: Captured[], index = 0): Record<string, string> {
  const parsed = JSON.parse(calls[index].body) as {
    streams: Array<{
      stream: Record<string, string>
      values: [string, string][]
    }>
  }
  return parsed.streams[0].stream
}

interface TelemetryProbe {
  calls: Captured[]
  notes: { ref: string; error: string }[]
  steps: { phase: string; step: string; action: string }[]
  handlers: FanoutHandlers
  lokiOn: { current: boolean }
  handleOn: { current: boolean }
}

function telemetryProbe(
  opts: {
    lokiEnabled?: boolean
    handleThrows?: boolean
    fetchFails?: boolean
    env?: Record<string, string | undefined>
  } = {},
): TelemetryProbe {
  const probe: TelemetryProbe = {
    calls: [],
    notes: [],
    steps: [],
    handlers: {},
    lokiOn: { current: opts.lokiEnabled !== false },
    handleOn: { current: true },
  }
  probe.handlers = createTelemetryHandlers({
    loki: () => {
      if (!probe.lokiOn.current) return null
      return { endpoint: 'http://loki.test:3100', headers: {} }
    },
    handle: () => {
      if (!probe.handleOn.current) return null
      return {
        stepStart: (phase, step) => {
          if (opts.handleThrows === true) throw new Error('tempo exploded')
          probe.steps.push({ phase, step, action: 'start' })
        },
        stepStop: (phase, step) => {
          probe.steps.push({ phase, step, action: 'stop' })
        },
      }
    },
    fetchImpl: capturingLoki(probe.calls, opts.fetchFails === true),
    now: () => Date.parse(AT),
    onNote: (ref, error) => {
      probe.notes.push({ ref, error })
    },
    env: opts.env ?? {},
  })
  return probe
}

test('loki disabled -> ZERO fetch calls; step events still reach the handle', async () => {
  const probe = telemetryProbe({ lokiEnabled: false })
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  await fanout.record(STATE_CHANGE)
  await fanout.record(STEP_START)
  await fanout.record(STEP_STOP)
  await tick()

  assert.deepEqual(
    probe.calls,
    [],
    'telemetry.loki.enabled=false must be silent',
  )
  assert.deepEqual(probe.notes, [], 'a disabled push is not a failure')
  assert.deepEqual(probe.steps, [
    { phase: 'validate', step: 'validate.code-review', action: 'start' },
    { phase: 'validate', step: 'validate.code-review', action: 'stop' },
  ])
})

test('absent telemetry handle (telemetry off) is absent-safe', async () => {
  const probe = telemetryProbe()
  probe.handleOn.current = false
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  await fanout.record(STEP_START)
  await fanout.record(STEP_STOP)
  await tick()

  assert.deepEqual(pushKinds(probe.calls), ['step-start', 'step-stop'])
})

test('enabled loki pushes the closed label set + the full event JSON line', async () => {
  const probe = telemetryProbe()
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  await fanout.record(STATE_CHANGE)
  await tick()

  assert.deepEqual(
    pushKinds(probe.calls),
    ['state-change'],
    'run-start is not a v2 event: no push',
  )
  assert.match(probe.calls[0].url, /\/loki\/api\/v1\/push$/)
  assert.deepEqual(pushStream(probe.calls), {
    job: 'pi-flow',
    flow_ref: 'DP-236',
    mode: 'work',
    state: 'waiting_human',
    reason: 'code_review_pending',
    wait_kind: 'human',
    kind: 'state-change',
  })
  const parsed = JSON.parse(probe.calls[0].body) as {
    streams: Array<{ values: [string, string][] }>
  }
  assert.deepEqual(JSON.parse(parsed.streams[0].values[0][1]), STATE_CHANGE)
  assert.equal(parsed.streams[0].values[0][0], `${Date.parse(AT)}000000`)
})

test('identity: the LAST observed run-start wins (runTracking semantics)', async () => {
  const probe = telemetryProbe()
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  await fanout.record({
    kind: 'run-start',
    at: AT,
    ref: 'PMR-ZV9Y',
    mode: 'personal',
  })
  await fanout.record(STATE_CHANGE)
  await tick()

  assert.equal(pushStream(probe.calls).flow_ref, 'PMR-ZV9Y')
  assert.equal(pushStream(probe.calls).mode, 'personal')
})

test('identity with no observed run-start falls back to the stamped env', async () => {
  const probe = telemetryProbe({
    env: {
      PI_FLOW_REF: 'PMR-D43',
      PI_FLOW_MODE: 'work',
      PI_FLOW_TRACK_REF: 'DP-99',
    },
  })
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record({ ...STATE_CHANGE, ref: 'PMR-D43' })
  await tick()

  assert.equal(pushStream(probe.calls).flow_ref, 'DP-99')
  assert.equal(pushStream(probe.calls).mode, 'work')
})

test('identity for a foreign ref never borrows another run (own ref, personal)', async () => {
  const probe = telemetryProbe({
    env: {
      PI_FLOW_REF: 'PMR-D43',
      PI_FLOW_MODE: 'work',
      PI_FLOW_TRACK_REF: 'DP-99',
    },
  })
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record({ ...STATE_CHANGE, ref: 'PMR-OTHER' })
  await tick()

  assert.equal(pushStream(probe.calls).flow_ref, 'PMR-OTHER')
  assert.equal(pushStream(probe.calls).mode, 'personal')
})

test('a throwing Loki sink never also costs the Tempo step span', async () => {
  const calls: Captured[] = []
  const steps: string[] = []
  const handlers = createTelemetryHandlers({
    loki: () => {
      throw new Error('loki settings exploded')
    },
    handle: () => ({
      stepStart: (phase, step) => {
        steps.push(`start:${phase}/${step}`)
      },
      stepStop: (phase, step) => {
        steps.push(`stop:${phase}/${step}`)
      },
    }),
    fetchImpl: capturingLoki(calls),
    now: () => Date.parse(AT),
    onNote: () => {},
    env: {},
  })
  const fanout = createEventFanoutWriter(probeWriter().writer, handlers)

  assert.equal(await fanout.record(STEP_START), true, 'never-throw')
  assert.deepEqual(steps, ['start:validate/validate.code-review'])
  assert.deepEqual(calls, [])
})

test('a throwing step span never costs the Loki push', async () => {
  const probe = telemetryProbe({ handleThrows: true })
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  assert.equal(await fanout.record(STEP_START), true, 'never-throw')
  await tick()

  assert.deepEqual(pushKinds(probe.calls), ['step-start'])
})

test('loki push failures note AT MOST ONCE per handler instance (shared guard)', async () => {
  const probe = telemetryProbe({ fetchFails: true })
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)

  await fanout.record(RUN_START)
  await fanout.record(STATE_CHANGE)
  await fanout.record({
    kind: 'state-change',
    at: AT,
    ref: 'PMR-ZV9Y',
    state: 'running',
  })
  await tick()
  await tick()

  assert.equal(probe.calls.length, 2, 'both v2 events attempted a push')
  assert.equal(probe.notes.length, 1, 'one note per handler, named for the ref')
  assert.equal(probe.notes[0].ref, 'PMR-ZV9Y')
})

// --- the run-attempt fallback audit (AC-1) ---------------------------------

// AIDEV-NOTE: the audit result, pinned. `createAttemptLedger` WITHOUT a
// deps.record seam writes `attempt-record` straight through recordRunEvent,
// bypassing the wrapped writer entirely — but that kind is NOT a v2 event, so
// nothing reaches Loki that should not, and nothing v2 is lost. The
// escalation's state-change rides deps.journalV2 -> the wrapped writer, so it
// DOES route. index.ts always supplies BOTH seams; this is why no explicit
// dispatcher call is needed at tools/run-attempt.ts's fallback.
const RA_BIN = mkTmpDir('pi-flow-dispatch-bin-')
const RA_SESSION = mkTmpDir('pi-flow-dispatch-session-')
writeFileSync(path.join(RA_BIN, 'aven'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(RA_BIN, 'aven'), 0o755)
mkdirSync(path.join(RA_SESSION, '.pi', 'pi-flow'), { recursive: true })

type Execute = (
  id: string,
  params: { ref: string; result: { ok: boolean; lastError?: string } },
) => Promise<{ isError?: boolean }>

async function withFakeAven(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${RA_BIN}:${previousPath}`
  setAvenSessionCwd(RA_SESSION)
  try {
    await fn()
  } finally {
    if (previousPath === '') delete process.env.PATH
    else process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
}

test('run-attempt: the direct recordRunEvent fallback bypasses the fan-out and carries no v2 kind', async () => {
  const agentDir = mkTmpDir('pi-flow-dispatch-agent-')
  const probe = telemetryProbe()
  const fanout = createEventFanoutWriter(probeWriter().writer, probe.handlers)
  let execute: Execute | undefined

  // Seed the durable journal: applyEvent drops a projected attempt-record for
  // a ref with no run-start, so the fallback needs a real run to land in.
  await recordRunEvent(agentDir, {
    kind: 'run-start',
    at: AT,
    ref: 'PMR-D43',
    mode: 'work',
    trackRef: 'DP-43',
  })

  registerRunAttemptTool(
    {
      registerTool: (tool: { execute: Execute }) => {
        execute = tool.execute
      },
    } as unknown as ExtensionAPI,
    // NO deps.record -> ledger.record falls back to recordRunEvent(agentDir).
    createAttemptLedger(agentDir),
    {
      isYoloRunFn: async () => false,
      journalV2: async (event) => {
        await fanout.record(event)
      },
    },
  )
  assert.ok(execute)
  const run = execute

  await withFakeAven(async () => {
    for (let i = 0; i < 3; i++) {
      await run(`c${i}`, {
        ref: 'PMR-D43',
        result: { ok: false, lastError: 'red' },
      })
    }
  })
  await tick()

  // (a) the fallback really wrote the durable journal...
  const events = await readRunEvents(agentDir, 'PMR-D43')
  assert.ok(events !== null, 'the fallback wrote the journal file')
  const attempts = events.filter((event) => event.kind === 'attempt-record')
  assert.equal(
    attempts.length,
    3,
    'three attempt snapshots journalled directly',
  )

  // (b) ...none of them reached the fan-out (correct: non-v2 kinds), while the
  // escalation v2 state-change did.
  assert.deepEqual(pushKinds(probe.calls), ['state-change'])
  assert.deepEqual(pushStream(probe.calls), {
    job: 'pi-flow',
    flow_ref: 'PMR-D43',
    mode: 'personal',
    state: 'waiting_human',
    reason: 'escalation',
    wait_kind: 'human',
    kind: 'state-change',
  })
})

// --- production-seam integration (AC-1, the real composition) --------------

// AIDEV-NOTE: this is the AC-1 evidence, not a unit rehearsal: the REAL
// mode-aware EventWriter over a temp agent dir (daemon probe forced absent, so
// writes take the full recordRunEvent path), wrapped by the fan-out with the
// production handler build, driven by the REAL flow loop through the same
// serialized chain index.ts uses. It proves (a) the durable journal still
// carries every v2 line (durability untouched), (b) each of those lines also
// reached Loki with the closed label set, (c) the step boundary reached the
// handle, and (d) the pause line keeps its work-mode identity EVEN THOUGH
// loop.onSettled() clears the flow env on the pause teardown — the reason the
// fan-out caches the run-start at the seam instead of reading env per push.
test('production seam: the real loop + real writer land v2 in the journal AND push to Loki AND open the span', async () => {
  const agentDir = mkTmpDir('pi-flow-dispatch-loop-')
  const calls: Captured[] = []
  const spans: string[] = []
  const fanout = createEventFanoutWriter(
    createEventWriter(
      agentDir,
      createDaemonAliveProbe(agentDir, () => false),
    ),
    createTelemetryHandlers({
      loki: () => ({ endpoint: 'http://loki.test:3100', headers: {} }),
      handle: () => ({
        stepStart: (phase, step) => {
          spans.push(`start:${phase}/${step}`)
        },
        stepStop: (phase, step) => {
          spans.push(`stop:${phase}/${step}`)
        },
      }),
      fetchImpl: capturingLoki(calls),
      now: () => Date.parse(AT),
      onNote: () => {},
      env: {},
    }),
  )
  // index.ts's journalSerial: one serialized, never-throw chain for the loop.
  let chain: Promise<void> = Promise.resolve()
  const journalSerial = (event: FlowRunEvent): void => {
    chain = chain
      .then(async () => {
        await fanout.record(event)
      })
      .catch(() => undefined)
  }
  // /flow journals the run-start BEFORE the loop starts (index.ts).
  await fanout.record({
    kind: 'run-start',
    at: AT,
    ref: 'TP-1',
    mode: 'work',
    trackRef: 'DP-INT',
  })

  const deps: FlowLoopDeps = {
    notify: () => {},
    journal: journalSerial,
    journalV2: journalSerial,
    readLabels: async () => [],
    readPlanState: async () => 'review',
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: () => {},
  }
  const loop = createFlowLoop(deps)
  await loop.start({
    ref: 'TP-1',
    phase: 'plan',
    promptInput: {
      mode: 'work',
      ref: 'TP-1',
      gitRoot: '/repo',
      workRoots: [],
    },
  })
  await loop.onSettled()
  await chain

  const events = await readRunEvents(agentDir, 'TP-1')
  assert.ok(events !== null, 'the journal exists')
  const journaled = events.map((event) => event.kind)
  assert.ok(
    journaled.filter((kind) => kind === 'state-change').length === 2,
    `both state-changes are durable: ${String(journaled)}`,
  )
  assert.ok(
    journaled.includes('step-start'),
    `the step boundary is durable: ${String(journaled)}`,
  )

  await tick()
  assert.deepEqual(pushKinds(calls), [
    'state-change',
    'state-change',
    'step-start',
  ])
  const pause = pushStream(calls, 1)
  assert.equal(pause.state, 'waiting_human')
  assert.equal(pause.reason, 'spec_approval_pending')
  assert.equal(pause.wait_kind, 'human')
  assert.equal(pause.flow_ref, 'DP-INT')
  assert.equal(pause.mode, 'work')
  assert.deepEqual(spans, ['start:plan/plan.spec-approval'])
})

// --- wiring guard (index.ts composition, textual like the closure guards) --

// AIDEV-NOTE: PMR-ZV9Y 4.3 — the wiring contract is load-bearing (a second,
// unwrapped EventWriter in the session means a silently missing Loki stream;
// a fan-out on the daemon side means Loki pushing history it must not push).
// flow.test.ts's real-extension harness needs the full canned-aven setup, so
// this guard checks the wiring TEXTUALLY — the same technique as
// test/cost-rows-node-only.test.ts — and the composition BEHAVIOUR is covered
// by the production-seam test above.
function sourceOf(relative: string): string {
  return readFileSync(path.resolve(packageDir, relative), 'utf8')
}

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

test('index.ts wraps its ONE session writer in the fan-out dispatcher', () => {
  const index = sourceOf('index.ts')
  assert.equal(
    // The only createEventWriter call in the extension entrypoint must be the
    // one handed to the fan-out wrapper.
    index.includes('createEventFanoutWriter(\n    createEventWriter('),
    true,
    'the session writer must be constructed INSIDE createEventFanoutWriter',
  )
  assert.equal(
    (index.match(/createEventWriter\(/g) ?? []).length,
    1,
    'index.ts must build exactly ONE EventWriter (no unwrapped second seam)',
  )
  assert.ok(
    index.includes('createTelemetryHandlers({'),
    'the production handler bag is wired at the wrap point',
  )
})

test('the daemon side never gets the fan-out (Loki is session-side only)', () => {
  for (const file of [
    'server/daemon.ts',
    'server/writer.ts',
    'flow/liveness.ts',
    'flow/reconcile.ts',
  ]) {
    assert.ok(
      !sourceOf(file).includes('telemetry/dispatch.ts'),
      `${file} must not import the fan-out dispatcher`,
    )
  }
})

test('dispatch.ts ships in the package files allowlist', () => {
  const pkg = JSON.parse(sourceOf('package.json')) as { files?: string[] }
  assert.ok(pkg.files?.includes('telemetry/dispatch.ts'))
})
