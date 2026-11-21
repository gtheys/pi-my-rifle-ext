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
// Fix round 2: dispose() resets the registration flag, so a NEW session_start
// ctx re-registers a fresh component (setWidget runs again).
// PMR-C3B6 (D1 rewrite): visibility is a 3-state machine — 'hidden'
// (default), 'flashing' (phase transition reveals the widget for FLASH_MS
// via a one-shot timer), 'pinned' (explicit toggleFlowDashboardPin). Content
// alone NEVER registers; the footer status (Phase 2) is NEVER gated on
// visibility. session_start re-syncs: it resets visibility to hidden and
// suppresses the flash so the first refresh adopts the current phase
// silently. registerWidget/unregisterWidget are shared module helpers used
// by refresh, the toggle, and the flash expiry callback.

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { FlowRunState } from '../run-state.ts'
import { frameFlowStatusLines } from './frame.ts'
import type { OpenGate } from './gates.ts'
import {
  type AssignmentSummary,
  renderFlowStatusLines,
  renderFooterStatus,
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
    setTimeout?: (fn: () => void, ms: number) => unknown
    clearTimeout?: (handle: unknown) => void
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
// AIDEV-NOTE (PMR-MGWP): minimal phase slice cached alongside cachedLines so
// render() picks the frame accent without re-reading state (render stays IO-free).
let cachedPhase: string | null = null
// Captured at setWidget-factory time; render() falls back to the plain clamp
// when absent (test harnesses invoke the factory with tui only).
let widgetTheme: Theme | null = null
// AIDEV-NOTE (PMR-C3B6): visibility state machine — default hidden (D1
// rewrite): content alone never registers; the ONLY reveal paths are a
// phase-transition flash and an explicit pin (toggleFlowDashboardPin). The
// footer status (Phase 2) is NEVER gated on visibility.
type WidgetVisibility = 'hidden' | 'flashing' | 'pinned'
let visibility: WidgetVisibility = 'hidden'
let flashHandle: unknown = null
let suppressFlashOnce = false
const FLASH_MS = 4000

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

/** PMR-C3B6: one-shot timer pair — injected timing when it provides
 * setTimeout/clearTimeout, globals otherwise (same discipline as the tick). */
function resolveOneShotTiming(): {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
} {
  const t = deps?.timing
  if (t?.setTimeout !== undefined && t?.clearTimeout !== undefined) {
    return { setTimeout: t.setTimeout, clearTimeout: t.clearTimeout }
  }
  return {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    },
  }
}

/** PMR-C3B6: arm (or re-arm) the flash one-shot — on expiry the widget goes
 * back to hidden and unregisters. The callback runs OUTSIDE updateWidget's
 * try/catch, so its unregister is identity-guarded (PMR-AD0H pattern). */
function armFlash(ctx: ExtensionContext): void {
  clearFlash()
  const timing = resolveOneShotTiming()
  flashHandle = timing.setTimeout(() => {
    flashHandle = null
    visibility = 'hidden'
    if (widgetTui === null && !widgetRegistered) return
    unregisterWidget(ctx)
  }, FLASH_MS)
}

/** PMR-C3B6: cancel a pending flash timer, if any. */
function clearFlash(): void {
  if (flashHandle === null) return
  const timing = resolveOneShotTiming()
  timing.clearTimeout(flashHandle)
  flashHandle = null
}

/** PMR-C3B6: shared unregister — flag reset + guarded setWidget(undefined).
 * Used by refresh (empty/hidden paths), the toggle, and the flash expiry. */
function unregisterWidget(ctx: ExtensionContext): void {
  if (!widgetRegistered) return
  widgetRegistered = false
  widgetTui = null
  try {
    ctx.ui.setWidget(WIDGET_NAME, undefined)
  } catch {}
}

/** PMR-C3B6: shared register — idempotent (already registered → cheap
 * redraw). The factory reads timing from deps?.timing at registration time;
 * callers run under updateWidget's try/catch (the toggle wraps its own). */
function registerWidget(ctx: ExtensionContext): void {
  if (widgetRegistered) {
    // Cheap path (subagents :1115): don't re-register — that would reset the
    // 2s tick. Refresh the cache and ask for a redraw.
    try {
      widgetTui?.requestRender()
    } catch {}
    return
  }
  widgetRegistered = true
  const timing = deps?.timing
  try {
    ctx.ui.setWidget(
      WIDGET_NAME,
      (tui: { requestRender: () => void }, theme?: Theme) => {
        widgetTui = tui
        // AIDEV-NOTE (PMR-MGWP): theme is captured once per registration;
        // render must never reach back into ctx (it can go stale mid-session).
        if (theme !== undefined) {
          widgetTheme = theme
        }
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
            // PMR-ZGPY fix round 2 (mirrors subagents index.ts dispose): the
            // registration flag MUST reset, or after a session reload tears
            // the component down every refresh takes the cheap requestRender
            // no-op path and the widget never returns. Guarded by the same
            // identity check the precedent uses, BEFORE nulling.
            if (widgetTui === tui) {
              widgetTui = null
              widgetRegistered = false
            }
          },
          render(width: number): string[] {
            // AIDEV-NOTE (PMR-MGWP): ANSI-aware framing replaces the old
            // String.slice clamp; without a theme (harness) we keep the plain clamp.
            // Styling (PMR-X7BH) lives inside frameFlowStatusLines; cachedLines
            // must stay plain ASCII — the no-theme clamp below would split
            // surrogate pairs / cut SGR sequences mid-escape otherwise.
            const localTheme = widgetTheme
            if (localTheme === null) {
              return cachedLines.map((line) =>
                line.slice(0, Math.max(0, width)),
              )
            }
            return frameFlowStatusLines(
              cachedLines,
              width,
              localTheme,
              cachedPhase,
            )
          },
        }
      },
    )
  } catch (error) {
    // PMR-C3B6: never leave the flag set when pi rejected the registration —
    // the host may rethrow on a stale ctx outside updateWidget's guard.
    widgetRegistered = false
    throw error
  }
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
    // PMR-C3B6: the pin does not outlive the flow — clear flash + pin state.
    clearFlash()
    visibility = 'hidden'
    cachedLines = []
    cachedPhase = null
    try {
      ctx.ui.setStatus('flow', undefined)
    } catch {}
    unregisterWidget(ctx)
    return
  }
  // AIDEV-NOTE (PMR-C3B6): detect the phase transition BEFORE updating
  // cachedPhase. suppressFlashOnce marks a session_start re-sync — the first
  // refresh after a session start adopts the current phase without flashing.
  const newPhase = collected.state?.currentPhase ?? null
  const transitioned =
    newPhase !== null && newPhase !== cachedPhase && !suppressFlashOnce
  suppressFlashOnce = false
  cachedLines = renderFlowStatusLines(input)
  cachedPhase = newPhase
  // AIDEV-NOTE (PMR-C3B6): footer status is set on every content refresh —
  // unconditional (Phase 2 invariant), never gated on visibility. Covers the
  // three refresh entries: index.ts onFlowSpawn, index.ts agent_settled,
  // session_start (via initFlowWidget → refreshFlowWidget).
  try {
    ctx.ui.setStatus('flow', renderFooterStatus(collected.state))
  } catch {}
  // AIDEV-NOTE (PMR-C3B6): visibility branch — only registration is gated.
  if (visibility === 'pinned') {
    // Pinned: ensure registered, NO flash — transitions are a no-op.
    registerWidget(ctx)
    return
  }
  if (transitioned) {
    // Phase transition: reveal for FLASH_MS, (re-)arm the one-shot timer.
    visibility = 'flashing'
    registerWidget(ctx)
    armFlash(ctx)
    return
  }
  if (visibility === 'flashing') {
    // Still flashing, no new transition: timer keeps running.
    registerWidget(ctx)
    return
  }
  // Hidden: defensive unregister (PMR-AD0H) — pi may hold an orphan
  // registration from a pre-reset lifecycle.
  unregisterWidget(ctx)
}

/** Pull-based refresh — index.ts calls this from the onFlowSpawn hook and
 * (via refreshAfterSettle) from agent_settled. Never throws (ISC-A-2). */
export async function refreshFlowWidget(): Promise<void> {
  await updateWidget()
}

/** PMR-2KH5: settle-ordered refresh for the agent_settled handler. Phase
 * truth (phase-complete / phase-start) is journaled only inside the loop's
 * onSettled — after an aven readLabels shell-out — while the widget projects
 * currentPhase solely from journal events. Firing the refresh concurrently
 * with onSettled read the pre-transition journal, re-set the stale footer
 * phase, and left nothing to correct it until the next settle (footer a turn
 * behind; done/halt never refreshed). Chaining the refresh on the settle
 * promise fixes the ordering; finally() guarantees the refresh still runs
 * when onSettled rejects. The rejection itself propagates to the caller
 * (fail-noisy, unchanged from the old bare `void loop.onSettled()`). */
export function refreshAfterSettle(
  onSettled: () => Promise<void>,
): Promise<void> {
  return onSettled().finally(() => refreshFlowWidget())
}

export type DashboardToggleOutcome = 'pinned' | 'hidden' | 'no-content'

/** Toggle-pin the dashboard widget (PMR-C3B6). Uses the passed ctx (command /
 * shortcut handlers receive fresh ones), else the module latestCtx holder.
 * pinned → hidden: clear pin, unregister. hidden|flashing → pinned:
 * re-collect data; without renderable content return 'no-content' changing
 * nothing; otherwise pin, refresh the caches, and register. */
export async function toggleFlowDashboardPin(
  ctx?: ExtensionContext,
): Promise<DashboardToggleOutcome> {
  const target = ctx ?? latestCtx
  if (visibility === 'pinned') {
    visibility = 'hidden'
    if (target !== null) {
      try {
        unregisterWidget(target)
      } catch {}
    }
    return 'hidden'
  }
  if (target === null || !target.hasUI) return 'no-content'
  const collected = await collectWidgetData()
  if (collected === null) return 'no-content'
  const input = {
    state: collected.state,
    subtasks: collected.subtasks.map((a) => ({
      name: a.name,
      status: a.status,
    })),
    gates: collected.gates,
  }
  if (!shouldShowWidget(input)) return 'no-content'
  clearFlash()
  visibility = 'pinned'
  cachedLines = renderFlowStatusLines(input)
  cachedPhase = collected.state?.currentPhase ?? null
  try {
    target.ui.setStatus('flow', renderFooterStatus(collected.state))
  } catch {}
  try {
    registerWidget(target)
  } catch {
    // AIDEV-NOTE: a throw here (e.g. a stale ctx whose setWidget fails) must
    // not leave the machine claiming 'pinned' for an unregistered widget —
    // reset to 'hidden' so the next toggle re-pins instead of unpinning; the
    // footer status set above still reflects the attempted pin and the next
    // session_start re-syncs regardless.
    visibility = 'hidden'
  }
  return 'pinned'
}

/** Register the widget lifecycle: session_start listener capturing latestCtx
 * plus an initial refresh. Wiring-only call from index.ts. AIDEV-NOTE
 * (PMR-ZGPY 3.2): init is the ONLY path that resets lifecycle state
 * (registered flag, cached lines, tick handle) — mid-run refreshes must never
 * re-register, or the 2s presentation tick would reset every time.
 * PMR-C3B6: init also resets the visibility machine; session_start re-syncs
 * (hidden + flash suppressed) instead of counting as a transition. */
export function initFlowWidget(
  pi: ExtensionAPI,
  widgetDeps: FlowWidgetDeps,
): void {
  deps = widgetDeps
  widgetRegistered = false
  widgetTui = null
  cachedLines = []
  cachedPhase = null
  widgetTheme = null
  visibility = 'hidden'
  clearFlash()
  suppressFlashOnce = false
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx
    // PMR-C3B6: a session start is a re-sync, not a transition — adopt the
    // current phase silently on the next refresh.
    visibility = 'hidden'
    clearFlash()
    suppressFlashOnce = true
    void refreshFlowWidget()
  })
}
