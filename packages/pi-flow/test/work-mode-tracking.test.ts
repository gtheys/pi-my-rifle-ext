import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  clearFlowEnv,
  FLOW_ENV_KEYS,
  stampFlowStart,
} from '../flow/attribution.ts'
import { pushToGateway } from '../flow/cost.ts'
import { createCostAutoPush } from '../flow/cost-autopush.ts'
import { computeCostRollup, type FlowCostDeps } from '../flow/cost-command.ts'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import { trackingRef } from '../flow/ref-kind.ts'
import type { FlowRunEvent } from '../run-state.ts'
import { flowAttributes } from '../telemetry/attributes.ts'
import { registerTelemetry } from '../telemetry/index.ts'

test('stampFlowStart stamps tracking ref + mode, drops stale values, rejects invalid track refs', () => {
  const env: Record<string, string | undefined> = {
    PI_FLOW_TRACK_REF: 'STALE-1',
    PI_FLOW_MODE: 'work',
  }
  assert.deepEqual(
    stampFlowStart(env, 'PMR-AB12', 'plan', undefined, {
      trackRef: 'DP-236',
      mode: 'work',
    }),
    { ok: true },
  )
  assert.equal(env.PI_FLOW_REF, 'PMR-AB12')
  assert.equal(env.PI_FLOW_TRACK_REF, 'DP-236')
  assert.equal(env.PI_FLOW_MODE, 'work')
  // a later personal run must not inherit the work values
  stampFlowStart(env, 'PMR-ZZ99', 'plan', undefined, { mode: 'personal' })
  assert.equal(env.PI_FLOW_TRACK_REF, undefined)
  assert.equal(env.PI_FLOW_MODE, 'personal')
  // invalid tracking ref is ignored (fail closed), never stamped mangled
  stampFlowStart(env, 'PMR-ZZ99', 'plan', undefined, {
    trackRef: 'bad ref!',
    mode: 'work',
  })
  assert.equal(env.PI_FLOW_TRACK_REF, undefined)
  clearFlowEnv(env)
  for (const key of FLOW_ENV_KEYS) assert.equal(key in env, false)
})

test('trackingRef: personal = aven ref; work = typed Jira id, else epic jira-ref, else aven ref', () => {
  assert.equal(trackingRef({ mode: 'personal', avenRef: 'PMR-1' }), 'PMR-1')
  assert.equal(
    trackingRef({ mode: 'personal', avenRef: 'PMR-1', jiraId: 'DP-1' }),
    'PMR-1',
  )
  assert.equal(
    trackingRef({ mode: 'work', avenRef: 'DP-AB12', jiraId: 'DP-236' }),
    'DP-236',
  )
  assert.equal(
    trackingRef({ mode: 'work', avenRef: 'DP-AB12', epicJiraRef: 'DP-236' }),
    'DP-236',
  )
  assert.equal(
    trackingRef({ mode: 'work', avenRef: 'DP-AB12', epicJiraRef: null }),
    'DP-AB12',
  )
})

test('loop.start stamps the tracking ref and the mode into the flow env', async () => {
  const env: Record<string, string | undefined> = {}
  const deps: FlowLoopDeps = {
    notify: () => {},
    journal: () => {},
    readLabels: async () => [],
    readPlanState: async () => null,
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: () => {},
    env,
  }
  await createFlowLoop(deps).start({
    ref: 'DP-AB12',
    trackRef: 'DP-236',
    phase: 'plan',
    promptInput: {
      mode: 'work',
      ref: 'DP-AB12',
      gitRoot: '/home/x/repo',
      workRoots: ['/home/x'],
    },
  })
  assert.equal(env.PI_FLOW_REF, 'DP-AB12')
  assert.equal(env.PI_FLOW_TRACK_REF, 'DP-236')
  assert.equal(env.PI_FLOW_MODE, 'work')
})

test('flowAttributes: tracking ref becomes flow.ref (aven ref kept as flow.aven_ref); mode is flow.mode', () => {
  assert.deepEqual(
    flowAttributes({
      PI_FLOW_REF: 'DP-AB12',
      PI_FLOW_TRACK_REF: 'DP-236',
      PI_FLOW_MODE: 'work',
    }),
    { 'flow.ref': 'DP-236', 'flow.aven_ref': 'DP-AB12', 'flow.mode': 'work' },
  )
  // personal: tracking == aven ref -> no flow.aven_ref
  assert.deepEqual(
    flowAttributes({
      PI_FLOW_REF: 'PMR-1',
      PI_FLOW_TRACK_REF: 'PMR-1',
      PI_FLOW_MODE: 'personal',
    }),
    { 'flow.ref': 'PMR-1', 'flow.mode': 'personal' },
  )
  // old env without the new vars behaves exactly as before
  assert.deepEqual(flowAttributes({ PI_FLOW_REF: 'PMR-1' }), {
    'flow.ref': 'PMR-1',
  })
})

type Handler = (event: never, ctx: { cwd: string }) => unknown
class FakePi {
  handlers = new Map<string, Handler[]>()
  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {}
  }
  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      void handler((payload ?? {}) as never, { cwd: '/repo' })
    }
  }
}
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function spansFor(
  env: Record<string, string | undefined>,
  jiraBaseUrl?: string,
): Promise<Map<string, Map<string, string>>> {
  const pi = new FakePi()
  const bodies: string[] = []
  registerTelemetry(pi as unknown as ExtensionAPI, {
    loadSettings: async () => ({
      endpoint: 'https://t:4478',
      headers: {},
      jiraBaseUrl,
    }),
    env,
    rng: { bytes: (n: number) => new Uint8Array(n).fill(3) },
    fetchImpl: (async (_u: string, init: { body: string }) => {
      bodies.push(init.body)
      return { status: 200 }
    }) as never,
    now: () => 1_700_000_000_000,
    onExportFailure: () => {},
  })
  pi.emit('session_start', { type: 'session_start', reason: 'startup' })
  await tick()
  pi.emit('tool_execution_start', {
    type: 'tool_execution_start',
    toolCallId: 't',
    toolName: 'bash',
    args: {},
  })
  pi.emit('tool_execution_end', {
    type: 'tool_execution_end',
    toolCallId: 't',
    toolName: 'bash',
    result: {},
    isError: false,
  })
  pi.emit('session_shutdown', { type: 'session_shutdown' })
  await tick()
  const spans = JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0]
    .spans as Array<{
    name: string
    attributes: Array<{ key: string; value: { stringValue: string } }>
  }>
  return new Map(
    spans.map((s) => [
      s.name,
      new Map(s.attributes.map((a) => [a.key, a.value.stringValue])),
    ]),
  )
}

const WORK_ENV = {
  PI_FLOW_REF: 'DP-AB12',
  PI_FLOW_TRACK_REF: 'DP-236',
  PI_FLOW_MODE: 'work',
  PI_FLOW_PHASE: 'plan',
  PI_FLOW_TRACEPARENT:
    '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
}

test('work-mode spans: flow.ref is the Jira key and flow.url links to Jira when a base URL is configured', async () => {
  const base = 'https://salaryhero.atlassian.net/browse/'
  const spans = await spansFor({ ...WORK_ENV }, base)
  const tool = spans.get('tool bash')
  assert.equal(tool?.get('flow.ref'), 'DP-236')
  assert.equal(tool?.get('flow.mode'), 'work')
  assert.equal(tool?.get('flow.aven_ref'), 'DP-AB12')
  assert.equal(tool?.get('flow.url'), `${base}DP-236`)
  // root + phase span names use the tracking ref too
  assert.ok(spans.has('flow DP-236'))
  assert.ok(spans.has('DP-236 - plan'))
  assert.equal(spans.get('flow DP-236')?.get('flow.url'), `${base}DP-236`)
})

test('no flow.url without a configured base URL, and never for personal mode', async () => {
  const noBase = await spansFor({ ...WORK_ENV })
  assert.equal(noBase.get('tool bash')?.has('flow.url'), false)
  const personal = await spansFor(
    {
      ...WORK_ENV,
      PI_FLOW_REF: 'PMR-1',
      PI_FLOW_TRACK_REF: 'PMR-1',
      PI_FLOW_MODE: 'personal',
    },
    'https://salaryhero.atlassian.net/browse/',
  )
  assert.equal(personal.get('tool bash')?.has('flow.url'), false)
  assert.equal(personal.get('tool bash')?.get('flow.mode'), 'personal')
})

test('pushToGateway: only work mode adds the mode grouping segment (personal group unchanged)', async () => {
  const urls: string[] = []
  const f = async (url: string) => {
    urls.push(url)
    return { status: 200, statusText: 'OK' }
  }
  await pushToGateway('https://g:4479/', 'DP-236', 'x\n', f, 't', 'work')
  await pushToGateway('https://g:4479', 'PMR-1', 'x\n', f, 't', 'personal')
  await pushToGateway('https://g:4479', 'PMR-1', 'x\n', f, 't')
  assert.deepEqual(urls, [
    'https://g:4479/metrics/job/pi-flow/ref/DP-236/mode/work',
    'https://g:4479/metrics/job/pi-flow/ref/PMR-1',
    'https://g:4479/metrics/job/pi-flow/ref/PMR-1',
  ])
})

const SESSION = `${JSON.stringify({
  type: 'message',
  timestamp: '2026-11-07T07:00:30.000Z',
  message: {
    role: 'assistant',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
  },
})}\n`
const FILE = '/s/2026-11-07T07-00-00-000Z_aaaaaaaa-bbbb.jsonl'

function journal(runStart: object): FlowRunEvent[] {
  const at = '2026-11-07T07:00:00.000Z'
  return [
    { kind: 'run-start', at, ref: 'DP-AB12', ...runStart } as FlowRunEvent,
    { kind: 'phase-start', at, ref: 'DP-AB12', phase: 'plan' },
    { kind: 'main-session', at, ref: 'DP-AB12', sessionFile: FILE },
    {
      kind: 'phase-complete',
      at: '2026-11-07T07:01:00.000Z',
      ref: 'DP-AB12',
      phase: 'plan',
      label: 'planned',
    },
  ]
}

function costDeps(events: FlowRunEvent[]): FlowCostDeps {
  return {
    readRunEvents: async () => events,
    listAssignmentRecords: () => [],
    readSessionFile: (f) => {
      if (f === FILE) return SESSION
      return null
    },
    push: async () => ({ ok: true }),
  }
}

test('computeCostRollup: tracking ref and mode come from the last run-start (old journals fall back)', async () => {
  const work = await computeCostRollup(
    'DP-AB12',
    costDeps(journal({ mode: 'work', trackRef: 'DP-236' })),
  )
  assert.equal(work.kind, 'ok')
  if (work.kind === 'ok') {
    assert.equal(work.trackRef, 'DP-236')
    assert.equal(work.mode, 'work')
  }
  const old = await computeCostRollup(
    'DP-AB12',
    costDeps(journal({ mode: 'personal' })),
  )
  assert.equal(old.kind, 'ok')
  if (old.kind === 'ok') {
    assert.equal(old.trackRef, 'DP-AB12')
    assert.equal(old.mode, 'personal')
  }
})

test('auto push labels metrics with the Jira key and pushes to the work group', async () => {
  const pushed: Array<{ ref: string; body: string; mode?: string }> = []
  const run = createCostAutoPush({
    ...costDeps(journal({ mode: 'work', trackRef: 'DP-236' })),
    push: async (ref, body, mode) => {
      pushed.push({ ref, body, mode })
      return { ok: true }
    },
    enabled: () => true,
    notify: () => {},
    settle: async () => {},
  })
  await run('DP-AB12')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].ref, 'DP-236')
  assert.equal(pushed[0].mode, 'work')
  assert.match(pushed[0].body, /pi_flow_run_cost_usd\{ref="DP-236",/)
  assert.doesNotMatch(pushed[0].body, /ref="DP-AB12"/)
})
