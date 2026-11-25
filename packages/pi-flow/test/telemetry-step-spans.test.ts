// AIDEV-NOTE: PMR-ZV9Y 4.1 — step-span tests (TelemetryHandle.stepStart /
// stepStop). Deliberately a NEW file: telemetry.test.ts stays untouched, so
// the phase-span rules it pins keep guarding the change. Harness mirrors the
// FakePi + registerTelemetry deps pattern there, but exposes the handle and
// uses an advancing clock so real start/end times are assertable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  phaseSpanId,
  registerTelemetry,
  stepSpanId,
  type TelemetryHandle,
} from '../telemetry/index.ts'

type Handler = (event: never, ctx: { cwd: string }) => unknown

class FakePi {
  handlers = new Map<string, Handler[]>()

  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      void handler((payload ?? {}) as never, { cwd: '/repo' })
    }
  }

  subscribedEvents(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

function fakePiCast(pi: FakePi): ExtensionAPI {
  return pi as unknown as ExtensionAPI
}

const seqRng = {
  bytes: (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) out[i] = (i + 1) % 256
    return out
  },
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const traceId = '0123456789abcdef0123456789abcdef'
const rootSpanId = 'fedcba9876543210'
const traceparent = `00-${traceId}-${rootSpanId}-01`

interface StepWiring {
  pi: FakePi
  handle: TelemetryHandle
  bodies: string[]
  env: Record<string, string | undefined>
  /** Mutable clock (ms); advances the real start/end stamps of step spans. */
  clock: { ms: number }
}

function wire(
  env: Record<string, string | undefined>,
  settings: { endpoint: string } | null,
): StepWiring {
  const pi = new FakePi()
  const bodies: string[] = []
  const clock = { ms: 1_700_000_000_000 }
  const handle = registerTelemetry(fakePiCast(pi), {
    loadSettings: async () => {
      if (settings === null) return null
      return { endpoint: settings.endpoint, headers: {} }
    },
    env,
    rng: seqRng,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return { status: 200 }
    }) as never,
    now: () => clock.ms,
    onExportFailure: () => {},
  })
  return { pi, handle, bodies, env, clock }
}

/** Flow env as the loop stamps it at a phase start. */
function flowEnv(
  ref: string,
  phase: string,
): Record<string, string | undefined> {
  return {
    PI_FLOW_REF: ref,
    PI_FLOW_PHASE: phase,
    PI_FLOW_TRACEPARENT: traceparent,
  }
}

interface RawSpan {
  name: string
  spanId: string
  traceId: string
  parentSpanId?: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: { stringValue: string } }>
}

function spans(w: StepWiring): RawSpan[] {
  const out: RawSpan[] = []
  for (const body of w.bodies) {
    const list = JSON.parse(body).resourceSpans[0].scopeSpans[0]
      .spans as RawSpan[]
    out.push(...list)
  }
  return out
}

function attrsOf(span: RawSpan): Map<string, string> {
  return new Map(span.attributes.map((a) => [a.key, a.value.stringValue]))
}

function stepSpans(w: StepWiring, name: string): RawSpan[] {
  return spans(w).filter((s) => s.name === name)
}

test('stepSpanId is sha256(traceId:phase:step)[0:16] and deterministic', () => {
  const expected = createHash('sha256')
    .update(`${traceId}:validate:validate.code-review`)
    .digest('hex')
    .slice(0, 16)
  assert.equal(
    stepSpanId(traceId, 'validate', 'validate.code-review'),
    expected,
  )
  assert.equal(
    stepSpanId(traceId, 'validate', 'validate.code-review'),
    expected,
  )
  assert.match(expected, /^[0-9a-f]{16}$/)
  // a different component changes the id (and it never collides with the phase)
  assert.notEqual(
    stepSpanId(traceId, 'validate', 'validate.deviation'),
    expected,
  )
  assert.notEqual(
    stepSpanId(traceId, 'validate', 'validate.code-review'),
    phaseSpanId(traceId, 'validate'),
  )
})

test('stepStart→stepStop exports the step span once, nested under the phase span', async () => {
  const w = wire(flowEnv('PMR-ST', 'validate'), { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('validate', 'validate.code-review')
  w.clock.ms += 5_000
  w.handle.stepStop('validate', 'validate.code-review')
  await tick()

  const step = stepSpans(w, 'PMR-ST - validate.code-review')
  assert.equal(step.length, 1)
  assert.equal(
    step[0].spanId,
    stepSpanId(traceId, 'validate', 'validate.code-review'),
  )
  assert.equal(step[0].traceId, traceId)
  assert.equal(step[0].parentSpanId, phaseSpanId(traceId, 'validate'))
  // real duration: start at stepStart time, end at close time
  assert.equal(step[0].startTimeUnixNano, '1700000000000000000')
  assert.equal(step[0].endTimeUnixNano, '1700000005000000000')
  const attrs = attrsOf(step[0])
  assert.equal(attrs.get('flow.span'), 'step')
  assert.equal(attrs.get('flow.ref'), 'PMR-ST')
  assert.equal(attrs.get('phase'), 'validate')
  assert.equal(attrs.get('step'), 'validate.code-review')

  // nothing re-sent at shutdown
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  assert.equal(stepSpans(w, 'PMR-ST - validate.code-review').length, 1)
})

test('duplicate stepStart is ignored (idempotent) and a closed step is never re-sent', async () => {
  const w = wire(flowEnv('PMR-IDEM', 'validate'), {
    endpoint: 'https://t:4478',
  })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('validate', 'validate.deviation')
  w.handle.stepStart('validate', 'validate.deviation')
  w.handle.stepStop('validate', 'validate.deviation')
  // a second start/stop pair for the SAME (phase, step) must not re-send the
  // deterministic id: Tempo keeps both copies of a re-sent span id.
  w.handle.stepStart('validate', 'validate.deviation')
  w.handle.stepStop('validate', 'validate.deviation')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  assert.equal(stepSpans(w, 'PMR-IDEM - validate.deviation').length, 1)
})

test('stepStop without stepStart is a silent no-op', async () => {
  const w = wire(flowEnv('PMR-NOSTART', 'plan'), { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStop('plan', 'plan.spec-approval')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  assert.equal(stepSpans(w, 'PMR-NOSTART - plan.spec-approval').length, 0)
  // the phase span still closes normally
  assert.equal(stepSpans(w, 'PMR-NOSTART - plan').length, 1)
})

test('phase close closes an open step span exactly once (trailing step of a phase)', async () => {
  const w = wire(flowEnv('PMR-PHASE', 'plan'), { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('plan', 'plan.spec-approval')
  // the loop moves on without the step ever stopping: syncFlowEnv sees the new
  // phase, closes the plan phase span, and must close the open step with it.
  w.env.PI_FLOW_PHASE = 'implement'
  w.handle.syncFlowEnv()
  await tick()

  const step = stepSpans(w, 'PMR-PHASE - plan.spec-approval')
  assert.equal(step.length, 1)
  assert.equal(step[0].parentSpanId, phaseSpanId(traceId, 'plan'))
  assert.equal(step[0].endTimeUnixNano, '1700000000000000000')
  // the late stop for the already-closed step never re-sends it
  w.handle.stepStop('plan', 'plan.spec-approval')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  assert.equal(stepSpans(w, 'PMR-PHASE - plan.spec-approval').length, 1)
  assert.equal(stepSpans(w, 'PMR-PHASE - implement').length, 1)
})

test('syncFlowEnv halt/clear closes an open step span', async () => {
  const env = flowEnv('PMR-HALT', 'validate')
  const w = wire(env, { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('validate', 'validate.code-review')
  delete env.PI_FLOW_REF
  delete env.PI_FLOW_PHASE
  delete env.PI_FLOW_TRACEPARENT
  w.handle.syncFlowEnv()
  await tick()

  assert.equal(stepSpans(w, 'PMR-HALT - validate.code-review').length, 1)
})

test('session_shutdown closes an open step span exactly once', async () => {
  const w = wire(flowEnv('PMR-SHUT', 'validate'), {
    endpoint: 'https://t:4478',
  })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('validate', 'validate.code-review')
  w.clock.ms += 2_000
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  const step = stepSpans(w, 'PMR-SHUT - validate.code-review')
  assert.equal(step.length, 1)
  assert.equal(step[0].endTimeUnixNano, '1700000002000000000')
})

test('no open phase span: step span nests on the same fallback as tool/gen spans', async () => {
  // no PI_FLOW_PHASE stamped, so no phase span exists: the step span must not
  // be dropped — it parents like every other span does (root parent marker).
  const w = wire(
    { PI_FLOW_REF: 'PMR-NOPHASE', PI_FLOW_TRACEPARENT: traceparent },
    { endpoint: 'https://t:4478' },
  )
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('plan', 'plan.spec-approval')
  w.handle.stepStop('plan', 'plan.spec-approval')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  const step = stepSpans(w, 'PMR-NOPHASE - plan.spec-approval')
  assert.equal(step.length, 1)
  assert.equal(step[0].parentSpanId, rootSpanId)
})

test('workers never export step spans (the main process owns the step tree)', async () => {
  const env = flowEnv('PMR-WORKER', 'validate')
  env.PI_SUBAGENT_NAME = 'worker-1'
  const w = wire(env, { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('validate', 'validate.code-review')
  w.handle.stepStop('validate', 'validate.code-review')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  assert.equal(stepSpans(w, 'PMR-WORKER - validate.code-review').length, 0)
})

test('telemetry disabled: stepStart/stepStop are no-ops that allocate nothing', async () => {
  const w = wire(flowEnv('PMR-OFF', 'validate'), null)
  assert.deepEqual(w.pi.subscribedEvents(), ['session_start'])
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  assert.deepEqual(w.pi.subscribedEvents(), ['session_start'])

  w.handle.stepStart('validate', 'validate.code-review')
  w.handle.stepStop('validate', 'validate.code-review')
  w.handle.stepStop('validate', 'never.started')
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  assert.equal(w.bodies.length, 0)
})

test('step spans inside a phase flush with the buffer, before the phase closes', async () => {
  // proves the export ordering the Tempo rule needs: a step span made and
  // closed inside one phase is sent once, and its parent phase span is sent
  // later with its own single copy.
  const w = wire(flowEnv('PMR-ORDER', 'plan'), { endpoint: 'https://t:4478' })
  w.pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()

  w.handle.stepStart('plan', 'plan.spec-approval')
  w.handle.stepStop('plan', 'plan.spec-approval')
  w.env.PI_FLOW_PHASE = 'implement'
  w.handle.syncFlowEnv()
  w.pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()

  const all = spans(w)
  const step = all.filter((s) => s.name === 'PMR-ORDER - plan.spec-approval')
  const planPhase = all.filter((s) => s.name === 'PMR-ORDER - plan')
  assert.equal(step.length, 1)
  assert.equal(planPhase.length, 1)
  assert.equal(step[0].parentSpanId, planPhase[0].spanId)
  const duplicateIds = new Map<string, number>()
  for (const s of all) {
    duplicateIds.set(s.spanId, (duplicateIds.get(s.spanId) ?? 0) + 1)
  }
  for (const [spanId, count] of duplicateIds) {
    assert.equal(count, 1, `span ${spanId} exported ${count} times`)
  }
})
