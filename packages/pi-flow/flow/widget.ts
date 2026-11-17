// AIDEV-NOTE (PMR-ZGPY 3.2): flow-status widget lifecycle — modeled on the
// pi-interactive-subagents widget (latestCtx module holder, updateWidget →
// updateWidgetUnsafe guarded try/catch, factory component with a 2s
// presentation-only tick). ISC-A-2: every ctx.ui.setWidget call happens
// inside updateWidgetUnsafe, which only ever runs under updateWidget's
// try/catch — a stale ctx after session reload can never crash the host.
// ISC-A-3: no fs.watch anywhere — refresh is pull-based (refreshFlowWidget
// from index.ts's agent_settled / onFlowSpawn paths) plus the presentation
// tick that ONLY calls tui.requestRender() (no data IO in the tick).
// Fail-closed data collection (collectWidgetData): one broken source keeps
// its own empty/null slice; a throw inside the pipeline keeps the last
// cached content — we unregister ONLY on genuinely-empty content, never on
// an error. The re-register guard mirrors subagents :1115: when already
// registered we update the cache and ask for a redraw (widgetTui
// .requestRender()) instead of re-registering, which would reset the tick.

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { FlowRunState } from '../run-state.ts'
import type { OpenGate } from './gates.ts'
import {
  type AssignmentSummary,
  renderFlowStatusLines,
  shouldShowWidget,
} from './status.ts'

/** Per-assignment slice the widget consumes; parentPid lets the module filter
 * to THIS process's children (spec: filter lives here, not in the caller). */
export interface WidgetAssignment extends AssignmentSummary {
  parentPid: number
}

/** Injectable data + timing seams (tests inject recording fakes). */
export interface FlowWidgetDeps {
  readState(): Promise<FlowRunState | null>
  listAssignments(): WidgetAssignment[]
  collectOpenGates(): Promise<OpenGate[]>
  parentPid: number
  timing?: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

const WIDGET_NAME = 'flow-status'
const TICK_MS = 2000

// Module holders — same shape as subagents index.ts :817.
let latestCtx: ExtensionContext | null = null
let deps: FlowWidgetDeps | null = null
let widgetTui: { requestRender: () => void } | null = null
let widgetRegistered = false
let cachedLines: string[] = []

interface WidgetData {
  state: FlowRunState | null
  subtasks: WidgetAssignment[]
  gates: OpenGate[]
}

/** Fail-closed fan-out: a rejected source becomes its empty slice. Returns
 * null when ANY source rejected — callers keep the last cached content
 * (an error must never be confused with genuinely-empty data). */
async function collectWidgetData(): Promise<WidgetData | null> {
  const localDeps = deps
  if (localDeps === null) {
    return { state: null, subtasks: [], gates: [] }
  }
  const [stateRes, assignmentsRes, gatesRes] = await Promise.allSettled([
    localDeps.readState(),
    Promise.resolve(localDeps.listAssignments()),
    localDeps.collectOpenGates(),
  ])
  if (
    stateRes.status === 'rejected' ||
    assignmentsRes.status === 'rejected' ||
    gatesRes.status === 'rejected'
  ) {
    return null
  }
  const subtasks = assignmentsRes.value.filter(
    (a) => a.parentPid === localDeps.parentPid,
  )
  return { state: stateRes.value, subtasks, gates: gatesRes.value }
}

async function updateWidget(): Promise<void> {
  if (!latestCtx?.hasUI) return
  // AIDEV-NOTE: latestCtx goes stale after session replacement/reload — pi
  // throws on stale ctx; a dead widget render must never crash the host
  // (subagents :1115 pattern). Covers every setWidget call (ISC-A-2).
  try {
    await updateWidgetUnsafe()
  } catch {}
}

async function updateWidgetUnsafe(): Promise<void> {
  const localDeps = deps
  if (localDeps === null) return
  const ctx = latestCtx
  if (ctx === null) return
  const collected = await collectWidgetData()
  if (collected === null) {
    // AIDEV-NOTE (PMR-ZGPY 3.2): a source ERROR (not genuinely-empty data) —
    // keep the last cached content and just redraw; never unregister on a
    // data error, that would blink the widget away on a transient failure.
    try {
      widgetTui?.requestRender()
    } catch {}
    return
  }
  const input = {
    state: collected.state,
    subtasks: collected.subtasks.map((a) => ({
      name: a.name,
      status: a.status,
    })),
    gates: collected.gates,
  }
  if (!shouldShowWidget(input)) {
    // Unregister only on genuinely-empty content, never on a data error.
    cachedLines = []
    if (widgetRegistered) {
      widgetRegistered = false
      widgetTui = null
      ctx.ui.setWidget(WIDGET_NAME, undefined)
    }
    return
  }
  cachedLines = renderFlowStatusLines(input)
  if (widgetRegistered) {
    // Cheap path (subagents :1115): don't re-register — that would reset the
    // 2s tick. Refresh the cache and ask for a redraw.
    try {
      widgetTui?.requestRender()
    } catch {}
    return
  }
  widgetRegistered = true
  const timing = localDeps.timing
  ctx.ui.setWidget(WIDGET_NAME, (tui: { requestRender: () => void }) => {
    widgetTui = tui
    // Presentation tick ONLY — no data IO here (ISC-A-3 complement). The
    // stop action is captured per-branch so dispose() needs no casts.
    let stopTick: () => void
    if (timing === undefined) {
      const t = setInterval(() => {
        try {
          tui.requestRender()
        } catch {}
      }, TICK_MS)
      stopTick = () => {
        clearInterval(t)
      }
    } else {
      const t = timing.setInterval(() => {
        try {
          tui.requestRender()
        } catch {}
      }, TICK_MS)
      stopTick = () => {
        timing.clearInterval(t)
      }
    }
    return {
      invalidate() {},
      dispose() {
        stopTick()
        widgetTui = null
      },
      render(width: number): string[] {
        return cachedLines.map((line) => line.slice(0, Math.max(0, width)))
      },
    }
  })
}

/** Pull-based refresh — index.ts calls this from agent_settled and the
 * onFlowSpawn hook. Never throws (ISC-A-2). */
export async function refreshFlowWidget(): Promise<void> {
  await updateWidget()
}

/** Register the widget lifecycle: session_start listener capturing latestCtx
 * plus an initial refresh. Wiring-only call from index.ts. AIDEV-NOTE
 * (PMR-ZGPY 3.2): init is the ONLY path that resets lifecycle state
 * (registered flag, cached lines, tick handle) — mid-run refreshes must never
 * re-register, or the 2s presentation tick would reset every time. */
export function initFlowWidget(
  pi: ExtensionAPI,
  widgetDeps: FlowWidgetDeps,
): void {
  deps = widgetDeps
  widgetRegistered = false
  widgetTui = null
  cachedLines = []
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx
    void refreshFlowWidget()
  })
}
