import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { OpenGate } from '../flow/gates.ts'
import {
  initFlowWidget,
  refreshAfterSettle,
  refreshFlowWidget,
  toggleFlowDashboardPin,
} from '../flow/widget.ts'
import type { FlowPhase, FlowRunState } from '../run-state.ts'

// Mock scaffolding: capture the session_start handler and the ctx.ui.setWidget
// calls so the widget lifecycle is exercised WITHOUT a TUI.
// PMR-C3B6 (D1 rewrite): registration is flash/pin-gated — the harness adds
// fake one-shot timers (setTimeout/clearTimeout via the timing seam) so the
// flash expiry and re-arm behavior are deterministic.

type SetWidgetCall = { name: string; component: unknown }

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
}

interface Harness {
  fireSessionStart(): void
  setWidgetCalls(): SetWidgetCall[]
  statusCalls(): Array<[string, string | undefined]>
  armedTimeouts(): FakeTimer[]
  fireLastTimeout(): void
  clearedIntervals(): FakeTimer[]
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
  const oneShots: FakeTimer[] = []
  const intervals: FakeTimer[] = []
  let component: ReturnType<NonNullable<Harness['lastComponent']>> | undefined
  const pi = {
    on(event: string, fn: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === 'session_start') handler = fn
    },
  } as unknown as ExtensionAPI
  initFlowWidget(pi, {
    readState: overrides.readState ?? (async () => null),
    listAssignments: overrides.listAssignments ?? (() => []),
    collectOpenGates: overrides.collectOpenGates ?? (async () => []),
    parentPid: process.pid,
    timing: {
      setInterval: (fn: () => void, ms: number) => {
        const t: FakeTimer = { fn, ms, cleared: false }
        intervals.push(t)
        return t
      },
      clearInterval: (t: unknown) => {
        ;(t as FakeTimer).cleared = true
      },
      setTimeout: (fn: () => void, ms: number) => {
        const t: FakeTimer = { fn, ms, cleared: false }
        oneShots.push(t)
        return t
      },
      clearTimeout: (t: unknown) => {
        ;(t as FakeTimer).cleared = true
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
            } else {
              component = undefined
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
    armedTimeouts: () => oneShots.filter((t) => !t.cleared),
    fireLastTimeout() {
      const armed = oneShots.filter((t) => !t.cleared)
      const last = armed[armed.length - 1]
      assert.notEqual(last, undefined, 'no armed one-shot timer')
      last.fn()
      // Models expiry: the timer is no longer pending (like clearFlash's
      // clearTimeout would leave a re-armed one).
      last.cleared = true
    },
    clearedIntervals: () => intervals.filter((t) => t.cleared),
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

/** PMR-C3B6: establish registration via an explicit pin (the sanctioned
 * reveal path for lifecycle tests asserting registration-dependent facts). */
async function pinForRegistration(): Promise<void> {
  const outcome = await toggleFlowDashboardPin()
  assert.equal(outcome, 'pinned')
}

describe('flow widget lifecycle', () => {
  it('content alone does NOT register (D1 rewrite, PMR-C3B6)', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await settle()
    await refreshFlowWidget()
    // Content alone: no registration, and refresh stays silent on repeats.
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 0)
    // Phase 2 invariant: the footer status is set even while hidden.
    assert.deepEqual(h.statusCalls()[h.statusCalls().length - 1], [
      'flow',
      '📋 PMR-ZGPY',
    ])
  })

  it('content → empty transition unregisters (setWidget undefined)', async () => {
    let state: FlowRunState | null = makeState()
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
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
    await settle()
    await pinForRegistration()
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
    await settle()
    await pinForRegistration()
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    comp?.dispose()
    assert.equal(h.clearedIntervals().length, 1)
  })

  it('render(width) clamps cached lines', async () => {
    const h = makeHarness({
      readState: async () => makeState({ ref: 'PMR-VERY-LONG-REF-NAME' }),
    })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
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
    await settle()
    await pinForRegistration()
    assert.equal(h.setWidgetCalls().length, 1)
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    comp?.dispose()
    // session_start re-syncs (hidden, flash suppressed) → no registration.
    h.fireSessionStart()
    await settle()
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 1)
    // Re-pin after the reload: a fresh setWidget lands (flag was reset).
    await pinForRegistration()
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.notEqual(calls[calls.length - 1]?.component, undefined)
  })

  it('assigns of OTHER parents are filtered out (parentPid)', async () => {
    const h = makeHarness({
      listAssignments: () => [
        { name: 'mine', status: 'working', parentPid: process.pid },
        { name: 'theirs', status: 'working', parentPid: 1 },
      ],
    })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
    const comp = h.lastComponent()
    assert.notEqual(comp, undefined)
    const text = (comp?.render(500) ?? []).join('\n')
    assert.ok(text.includes('mine'))
    assert.ok(!text.includes('theirs'))
  })
})

describe('flow widget flash + pin (PMR-C3B6)', () => {
  it('(a) phase transition registers + arms a 4000 ms one-shot; firing hides', async () => {
    let state = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    assert.equal(h.setWidgetCalls().length, 0)
    state = makeState({ currentPhase: 'implement' })
    await refreshFlowWidget()
    // Registered via the transition, one 4000 ms timer armed.
    assert.equal(h.setWidgetCalls().length, 1)
    const armed = h.armedTimeouts()
    assert.equal(armed.length, 1)
    assert.equal(armed[0].ms, 4000)
    h.fireLastTimeout()
    assert.equal(h.armedTimeouts().length, 0)
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].component, undefined)
  })

  it('(b) a second transition while flashing re-arms the timer', async () => {
    let state = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    state = makeState({ currentPhase: 'implement' })
    await refreshFlowWidget()
    assert.equal(h.armedTimeouts().length, 1)
    state = makeState({ currentPhase: 'validate' })
    await refreshFlowWidget()
    // Old timer cleared, a fresh 4000 ms one armed, still registered.
    const armed = h.armedTimeouts()
    assert.equal(armed.length, 1)
    assert.equal(armed[0].ms, 4000)
    assert.equal(h.setWidgetCalls().length, 1)
    h.fireLastTimeout()
    assert.equal(h.setWidgetCalls().length, 2)
  })

  it('(c) pin → transition ⇒ NO timer armed, stays registered', async () => {
    let state = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
    assert.equal(h.setWidgetCalls().length, 1)
    state = makeState({ currentPhase: 'implement' })
    await refreshFlowWidget()
    assert.equal(h.setWidgetCalls().length, 1)
    assert.equal(h.armedTimeouts().length, 0)
    // Still registered: only the pin call exists, no unregister followed.
    assert.notEqual(h.lastComponent(), undefined)
  })

  it('(d) toggle pins then unpins', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await settle()
    assert.equal(await toggleFlowDashboardPin(), 'pinned')
    assert.equal(h.setWidgetCalls().length, 1)
    assert.notEqual(h.lastComponent(), undefined)
    assert.equal(await toggleFlowDashboardPin(), 'hidden')
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].component, undefined)
  })

  it('(e) toggle with empty deps → no-content, no setWidget call', async () => {
    const h = makeHarness()
    h.fireSessionStart()
    await settle()
    assert.equal(await toggleFlowDashboardPin(), 'no-content')
    assert.equal(h.setWidgetCalls().length, 0)
  })

  it('(f) flow end while pinned unregisters + resets to hidden', async () => {
    let state: FlowRunState | null = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
    assert.equal(h.setWidgetCalls().length, 1)
    state = null
    await refreshFlowWidget()
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].component, undefined)
    // Pin state did not outlive the flow: re-toggling finds no content.
    assert.equal(await toggleFlowDashboardPin(), 'no-content')
  })

  it('(g) pin → session_start re-sync adopts phase with NO registration + NO timer', async () => {
    const h = makeHarness({
      readState: async () => makeState({ currentPhase: 'plan' }),
    })
    h.fireSessionStart()
    await settle()
    await pinForRegistration()
    assert.equal(h.setWidgetCalls().length, 1)
    h.fireSessionStart()
    await settle()
    await refreshFlowWidget()
    // Re-sync: unregistered (hidden branch), and the adopted phase did NOT
    // flash — no timer armed, no re-registration.
    const calls = h.setWidgetCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].component, undefined)
    assert.equal(h.armedTimeouts().length, 0)
  })

  it('(h) footer status identical in hidden / flashing / pinned states', async () => {
    let state = makeState({ currentPhase: 'plan' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    await refreshFlowWidget()
    const hiddenStatus = h.statusCalls()[h.statusCalls().length - 1]
    state = makeState({ currentPhase: 'implement' })
    await refreshFlowWidget()
    const flashingStatus = h.statusCalls()[h.statusCalls().length - 1]
    assert.equal(h.setWidgetCalls().length, 1)
    const pinned = await toggleFlowDashboardPin()
    assert.equal(pinned, 'pinned')
    const pinnedStatus = h.statusCalls()[h.statusCalls().length - 1]
    // Phase 2 invariant: the footer matches the flow state at each refresh
    // in every visibility state.
    assert.deepEqual(hiddenStatus, ['flow', '📋 PMR-ZGPY 📝 plan'])
    assert.deepEqual(flashingStatus, ['flow', '📋 PMR-ZGPY 🔨 implement'])
    assert.deepEqual(pinnedStatus, ['flow', '📋 PMR-ZGPY 🔨 implement'])
  })

  it('(i) registerWidget throw on a stale ctx resets visibility so the next toggle pins again', async () => {
    const h = makeHarness({ readState: async () => makeState() })
    h.fireSessionStart()
    await settle()
    // Stale ctx: setWidget throws (e.g. torn-down TUI). The pin path must not
    // leave the machine 'pinned' for an unregistered widget.
    const staleCtx = {
      hasUI: true,
      ui: {
        setStatus() {},
        setWidget() {
          throw new Error('stale ctx')
        },
      },
    } as unknown as ExtensionContext
    assert.equal(await toggleFlowDashboardPin(staleCtx), 'pinned')
    assert.equal(h.setWidgetCalls().length, 0)
    // Visibility was reset to 'hidden': the next toggle PINS again, it does
    // not take the pinned→hidden unpin path.
    assert.equal(await toggleFlowDashboardPin(), 'pinned')
    assert.equal(h.setWidgetCalls().length, 1)
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
})

describe('settle-ordered refresh (PMR-2KH5)', () => {
  // The agent_settled handler wires loop.onSettled through refreshAfterSettle
  // (packages/pi-flow/index.ts). These tests pin the ordering contract that
  // fixes the stale footer: the loop journals phase-complete/phase-start only
  // inside onSettled, and the widget's footer text projects solely from
  // journal events.

  it('refresh reads the journal only after onSettled lands the phase events', async () => {
    let journaledPhase: FlowPhase | null = 'plan'
    const order: Array<'journal' | 'read'> = []
    const h = makeHarness({
      readState: async () => {
        order.push('read')
        return makeState({ currentPhase: journaledPhase })
      },
    })
    h.fireSessionStart()
    await settle()
    order.length = 0
    await refreshAfterSettle(async () => {
      // Models the loop: an aven readLabels shell-out delays the journal
      // writes past the point where a concurrent refresh would have read.
      await new Promise((resolve) => setTimeout(resolve, 0))
      journaledPhase = 'implement'
      order.push('journal')
    })
    // The widget's read happened after the journal write — the footer ends
    // on the NEW phase (the raced refresh used to re-set the old one).
    assert.deepEqual(order, ['journal', 'read'])
    assert.deepEqual(h.statusCalls()[h.statusCalls().length - 1], [
      'flow',
      '📋 PMR-ZGPY 🔨 implement',
    ])
  })

  it('refresh still runs when onSettled rejects; the rejection propagates', async () => {
    const h = makeHarness({
      readState: async () => makeState({ currentPhase: 'plan' }),
    })
    h.fireSessionStart()
    await settle()
    await assert.rejects(
      refreshAfterSettle(async () => {
        throw new Error('aven shell-out failed')
      }),
      /aven shell-out failed/,
    )
    // finally() ran the refresh despite the rejection — the footer was not
    // skipped; the error itself stays fail-noisy for the caller.
    assert.deepEqual(h.statusCalls()[h.statusCalls().length - 1], [
      'flow',
      '📋 PMR-ZGPY 📝 plan',
    ])
  })

  it('post-settle done/halt: the now-running refresh clears the stale footer', async () => {
    // Deliberate PMR-2KH5 behavior change: at done/halt the loop's activeRef
    // is null, the ordered refresh runs, and the footer is CLEARED — instead
    // of the last phase text surviving indefinitely with no refresh entry.
    let state: FlowRunState | null = makeState({ currentPhase: 'validate' })
    const h = makeHarness({ readState: async () => state })
    h.fireSessionStart()
    await settle()
    state = null
    await refreshAfterSettle(async () => {})
    const calls = h.statusCalls()
    assert.deepEqual(calls[calls.length - 1], ['flow', undefined])
  })

  it('one settle transition arms the flash exactly once', async () => {
    let journaledPhase: FlowPhase | null = 'plan'
    const h = makeHarness({
      readState: async () =>
        journaledPhase === null
          ? null
          : makeState({ currentPhase: journaledPhase }),
    })
    h.fireSessionStart()
    await settle()
    await refreshAfterSettle(async () => {
      journaledPhase = 'implement'
    })
    // Exactly one refresh ran, so exactly one transition was detected: one
    // registration + one 4000 ms flash one-shot. A stray second refresh
    // (or a re-read) must not double-arm it.
    assert.equal(h.setWidgetCalls().length, 1)
    const armed = h.armedTimeouts()
    assert.equal(armed.length, 1)
    assert.equal(armed[0].ms, 4000)
  })
})
