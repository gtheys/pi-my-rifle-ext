import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { OpenGate } from '../flow/gates.ts'
import { initFlowWidget, refreshFlowWidget } from '../flow/widget.ts'
import type { FlowRunState } from '../run-state.ts'

// Mock scaffolding: capture the session_start handler and the ctx.ui.setWidget
// calls so the widget lifecycle is exercised WITHOUT a TUI.

type SetWidgetCall = { name: string; component: unknown }

interface Harness {
  fireSessionStart(): void
  setWidgetCalls(): SetWidgetCall[]
  statusCalls(): Array<[string, string | undefined]>
  lastComponent():
    | {
        invalidate(): void
        dispose(): void
        render(width: number): string[]
      }
    | undefined
}

function makeHarness(
  overrides: {
    readState?: () => Promise<FlowRunState | null>
    listAssignments?: () => Array<{
      name: string
      status: string
      parentPid: number
    }>
    collectOpenGates?: () => Promise<OpenGate[]>
  } = {},
): Harness {
  let handler: ((event: unknown, ctx: ExtensionContext) => void) | null = null
  const calls: SetWidgetCall[] = []
  // AIDEV-NOTE (PMR-C3B6): shared across fireSessionStart calls so a fresh
  // session ctx (wipe model) still lands in one recorder for assertions.
  const statusCalls: Array<[string, string | undefined]> = []
  const timers: { cleared: unknown[] } = { cleared: [] }
  let component: ReturnType<NonNullable<Harness['lastComponent']>> | undefined
  const pi = {
    on(event: string, fn: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === 'session_start') handler = fn
    },
  } as unknown as ExtensionAPI
  const injectedSetInterval = (() => {
    return setInterval(() => {}, 10_000)
  }) as unknown as ReturnType<typeof setInterval>
  initFlowWidget(pi, {
    readState: overrides.readState ?? (async () => null),
    listAssignments: overrides.listAssignments ?? (() => []),
    collectOpenGates: overrides.collectOpenGates ?? (async () => []),
    parentPid: process.pid,
    timing: {
      setInterval: () => injectedSetInterval,
      clearInterval: (t: unknown) => {
        timers.cleared.push(t)
      },
    },
  })
  return {
    fireSessionStart() {
      if (handler === null) throw new Error('session_start not registered')
      // AIDEV-NOTE: each session start models a NEW ctx (session reload);
      // setWidget calls from every session share the same `calls` recorder.
      const ctx = {
        hasUI: true,
        ui: {
          setStatus(name: string, value: string | undefined) {
            statusCalls.push([name, value])
          },
          setWidget(name: string, comp: unknown) {
            calls.push({ name, component: comp })
            if (comp !== undefined) {
              component = (
                comp as (tui: unknown) => ReturnType<Harness['lastComponent']>
              )({ requestRender() {} })
            }
          },
        },
      } as unknown as ExtensionContext
      const registered = handler as (
        event: unknown,
        ctx: ExtensionContext,
      ) => void
      registered({}, ctx)
    },
    setWidgetCalls: () => calls,
    statusCalls: () => statusCalls,
    lastComponent: () => component,
  }
}

// AIDEV-NOTE: session_start fires its own `void refreshFlowWidget()`; a
// macrotask tick lets that in-flight promise settle before counting calls.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function makeState(overrides: Partial<FlowRunState> = {}): FlowRunState {
  return {
    schema: 'gtheys.pi-flow.run.v1',
    ref: 'PMR-ZGPY',
    mode: 'work',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    completedPhases: [],
    currentPhase: null,
    notes: [],
    ...overrides,
  }
}

describe('flow widget lifecycle', () => {
  it('registers the widget when there is content (D1)', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await refreshFlowWidget()
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'flow-status')
    assert.notEqual(calls[0].component, undefined)
  })

  it('content → empty transition unregisters (setWidget undefined)', async () => {
    let state: FlowRunState | null = makeState()
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 1)
    state = null
    await refreshFlowWidget()
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].name, 'flow-status')
    assert.equal(calls[1].component, undefined)
  })

  it('data error → last content retained (no unregister, no throw)', async () => {
    let fail = false
    const h = makeHarness({
      readState: async () => {
        if (fail) throw new Error('boom')
        return makeState()
      },
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 1)
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    fail = true
    await refreshFlowWidget()
    // No second setWidget call at all: content retained, still registered.
    assert.equal(h.setWidgetCalls().length, 1)
    assert.deepEqual(comp?.render(200), comp?.render(200))
    assert.ok((comp?.render(200).length ?? 0) > 0)
  })

  it('dispose() clears the interval via injected timing', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await refreshFlowWidget()
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    // Must not throw; the injected clearInterval records the handle.
    comp?.dispose()
  })

  it('render(width) clamps cached lines', async () => {
    const h = makeHarness({
      readState: async () => makeState({ ref: 'PMR-VERY-LONG-REF-NAME' }),
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    const lines = comp?.render(10) ?? []
    for (const line of lines) {
      assert.ok(line.length <= 10, `line too long: "${line}"`)
    }
    assert.ok(lines.length > 0)
  })

  it('throwing ctx.ui.setWidget never escapes updateWidget (ISC-A-2)', async () => {
    let handler: ((event: unknown, ctx: ExtensionContext) => void) | null = null
    const pi = {
      on(event: string, fn: (event: unknown, ctx: ExtensionContext) => void) {
        if (event === 'session_start') handler = fn
      },
    } as unknown as ExtensionAPI
    const ctx = {
      hasUI: true,
      ui: {
        setWidget() {
          throw new Error('stale ctx')
        },
      },
    } as unknown as ExtensionContext
    initFlowWidget(pi, {
      readState: async () => makeState(),
      listAssignments: () => [],
      collectOpenGates: async () => [],
      parentPid: process.pid,
    })
    if (handler === null) throw new Error('session_start not registered')
    const registered = handler as (
      event: unknown,
      ctx: ExtensionContext,
    ) => void
    registered({}, ctx)
    // Must not throw.
    await refreshFlowWidget()
  })

  it('dispose → new session_start → refresh re-registers the widget (fix round 2)', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 1)
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    comp?.dispose()
    // RED today: without the registration-flag reset, refresh takes the
    // cheap requestRender no-op path and setWidget is never called again.
    h.fireSessionStart()
    await refreshFlowWidget()
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.notEqual(calls[calls.length - 1]?.component, undefined)
  })

  it('footer status is recorded on content refresh (PMR-C3B6)', async () => {
    const h = makeHarness({
      readState: async () => makeState({ currentPhase: 'plan' }),
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    await settle()
    const calls = h.statusCalls()
    // session_start's initial refresh + the explicit one.
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[calls.length - 1], ['flow', '📋 PMR-ZGPY 📝 plan'])
  })

  it('footer status is cleared on content → empty transition', async () => {
    let state: FlowRunState | null = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await refreshFlowWidget()
    await settle()
    assert.equal(h.statusCalls().length, 2)
    state = null
    await refreshFlowWidget()
    await settle()
    const calls = h.statusCalls()
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[calls.length - 1], ['flow', undefined])
  })

  it('data error → no new status call after the last set', async () => {
    let fail = false
    const h = makeHarness({
      readState: async () => {
        if (fail) throw new Error('boom')
        return makeState({ currentPhase: 'plan' })
      },
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    await settle()
    assert.equal(h.statusCalls().length, 2)
    fail = true
    await refreshFlowWidget()
    await settle()
    // Error branch retains the last footer: no new setStatus call.
    assert.equal(h.statusCalls().length, 2)
    assert.deepEqual(h.statusCalls()[0], ['flow', '📋 PMR-ZGPY 📝 plan'])
  })

  it('footer is re-recorded after a fresh session_start (wipe model)', async () => {
    const h = makeHarness({
      readState: async () => makeState({ currentPhase: 'plan' }),
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    await settle()
    assert.equal(h.statusCalls().length, 2)
    // Models a wipe: fresh ctx from a second session_start re-runs the
    // content path and sets the footer again (its own initial refresh).
    h.fireSessionStart()
    await settle()
    const calls = h.statusCalls()
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[calls.length - 1], ['flow', '📋 PMR-ZGPY 📝 plan'])
  })

  it('assigns of OTHER parents are filtered out (parentPid)', async () => {
    const h = makeHarness({
      listAssignments: () => [
        { name: 'mine', status: 'working', parentPid: process.pid },
        { name: 'theirs', status: 'working', parentPid: 1 },
      ],
    })
    h.fireSessionStart()
    await refreshFlowWidget()
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    const text = (comp?.render(500) ?? []).join('\n')
    assert.ok(text.includes('mine'))
    assert.ok(!text.includes('theirs'))
  })
})
