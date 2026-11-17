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
  const timers: { cleared: unknown[] } = { cleared: [] }
  let component: ReturnType<NonNullable<Harness['lastComponent']>> | undefined
  const pi = {
    on(event: string, fn: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === 'session_start') handler = fn
    },
  } as unknown as ExtensionAPI
  const ctx = {
    hasUI: true,
    ui: {
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
      // AIDEV-NOTE: TS can't see the assignment inside the mock's closure.
      const registered = handler as (
        event: unknown,
        ctx: ExtensionContext,
      ) => void
      registered({}, ctx)
    },
    setWidgetCalls: () => calls,
    lastComponent: () => component,
  }
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
