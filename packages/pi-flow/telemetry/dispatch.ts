// AIDEV-NOTE: PMR-ZV9Y 4.3 — THE writer fan-out dispatcher (renderer #2's
// router of the plan's three-renderer architecture: Prometheus folds the
// journal in the push chain, THIS module re-renders each event live to Loki +
// the Tempo step spans, and since 5.2 pi-desktop-notify shares the same bag —
// see createNotifySink below).
//
// ══ SEAM MAP: where v2 events are journaled, and why ONE wrap point covers
// them all. Every v2 emission site routes through the mode-aware EventWriter
// (server/writer.ts) — nobody writes a journal line by hand except the two
// audited fallbacks below — so `createEventFanoutWriter` wraps THAT object at
// its single construction site (index.ts, session writer) and each event then
// passes exactly ONE dispatcher. No double Loki push, no missed seam:
//
//   1. flow/loop.ts `emitV2` (state-change + step boundaries)
//        -> deps.journal / deps.journalV2 -> index.ts journalSerial
//        -> journal() -> writer.record                     [COVERED: wrapped]
//   2. tools/code-review.ts openReviewGate/closeReviewGate
//        -> journalV2 -> writer.record                     [COVERED: wrapped]
//   3. tools/deviation.ts step pair + rerun state-change
//        -> journalV2 -> journalGateEvent(event, writer)
//        -> writer.record                                  [COVERED: wrapped]
//   4. tools/run-attempt.ts escalation state-change
//        -> deps.journalV2 -> index.ts writer.record       [COVERED: wrapped]
//   5. tools/run-attempt.ts ATTEMPT LEDGER fallback (the scout §3 exception):
//        createAttemptLedger(agentDir, {}) WITHOUT deps.record writes
//        `attempt-record` straight through recordRunEvent, BYPASSING this
//        wrapper. AUDITED 2026-11-25 and deliberately NOT routed: that kind is
//        not a v2 event (nothing for Loki/Tempo to render), and index.ts
//        always injects the record seam -> the writer. The v2 state-change of
//        the same escalation rides seam 4, so nothing v2 is lost. Pinned by
//        test/telemetry-dispatch.test.ts.
//   6. tools/flow-submit.ts direct recordRunEvent fallback (same shape):
//        writes `step-output`, not a v2 kind, and index.ts always passes the
//        writer. Not routed, same reason.
//   7. index.ts's own consumers of the same object — journalOnly (the /flow
//        answer appendJournal, nested spawn-record), the receipt journals
//        (code_review / phase_complete / spec_approve / land) and
//        reviewExtension(pi, writer) — all hold the WRAPPED writer, so no
//        second dispatcher is ever built for them.
//   8. server/daemon.ts (liveness/reconcile/tombstone writes): never wrapped.
//        The daemon has no live event stream and pushes no Loki (see the
//        telemetry.loki AIDEV-NOTE in config.ts) — wrapping it there is a bug,
//        not a feature. Pinned by test/telemetry-dispatch.test.ts.
//
// ══ NEVER-THROW (ISC-A-5). `record` awaits the wrapped writer FIRST and
// forwards its outcome unchanged (best-effort false stays false, so
// flow_submit's journaled:false contract survives), then routes inside
// per-handler try/catch. Each sink is guarded separately: a throwing Loki
// settings getter never also costs the Tempo step span, and vice versa. Loki
// disabled / telemetry off = zero network calls, zero allocations beyond the
// identity map. Non-v2 kinds cost one kind check.
//
// ══ NO RE-VALIDATION. Whatever the writer recorded is routed; the closed
// label builder (telemetry/loki.ts buildLokiStream) is the label guard and the
// free text (note prose, deviation reasons, the step name) rides the JSON
// line only — never a label (ISC-A-1).
// PMR-ZV9Y 5.2: `recoveryCommand` is the single source of the `/flow <ref>`
// hint (flow/binding-heal.ts) — reusing it keeps the notify body and the
// session's recovery lines in lockstep. No cycle: binding-heal never imports
// telemetry/.
import { recoveryCommand } from '../flow/binding-heal.ts'
import {
  expectedAction,
  type FlowState,
  NO_EXPECTED_ACTION,
  reasonWaitKind,
} from '../flow/vocabulary.ts'
import type { FlowRunEvent } from '../run-state.ts'
import { runTracking } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import {
  type LokiFetch,
  type LokiLabels,
  type LokiNoteState,
  type LokiSettings,
  pushLokiEvent,
} from './loki.ts'

type StateChangeEvent = Extract<FlowRunEvent, { kind: 'state-change' }>
type StepStartEvent = Extract<FlowRunEvent, { kind: 'step-start' }>
type StepStopEvent = Extract<FlowRunEvent, { kind: 'step-stop' }>
/** The v2 step-boundary union (both kinds carry phase + step). */
export type StepBoundaryEvent = StepStartEvent | StepStopEvent

/**
 * The fan-out sinks. All optional and individually guarded; `onEvent` runs
 * first for EVERY journaled event (the identity tracker needs the run-start
 * lines that never reach the v2 sinks).
 */
export interface FanoutHandlers {
  onEvent?: (event: FlowRunEvent) => void
  onStateChange?: (event: StateChangeEvent) => void
  onStepEvent?: (event: StepBoundaryEvent) => void
  /**
   * AIDEV-NOTE: PMR-ZV9Y fix round (P1 blocker) — a SEPARATELY guarded observer
   * that fires for EVERY journaled `state-change` event, regardless of which
   * seam emitted it. index.ts wires it to the flow loop's
   * `noteExternalV2State(ref, state)` so the loop's guarded v2 emission is
   * invalidated by TOOL-journaled waits (run-attempt escalate, deviation rerun)
   * that the loop does not emit through its own seam. `onStateChange` is NOT
   * reused for that: it is the telemetry/Loki+notify sink and a throwing notify
   * would then also cost the loop bookkeeping (ISC-A-5). This observer runs in
   * its OWN try/catch BEFORE onStateChange, so neither can cost the other and
   * the loop learns the wait even when Loki/notify are off. The dispatcher is
   * the single choke point (see the seam map above); hooking here needs zero
   * journal re-reads and never re-validates the label (ISC-A-1 — the loop
   * re-validates against FLOW_STATES itself).
   */
  onV2StateChangeObserved?: (event: StateChangeEvent) => void
}

/** The Pushgateway identity pair a Loki stream is keyed by. */
export interface FanoutIdentity {
  trackRef: string
  mode: 'work' | 'personal'
}

/**
 * Wrap the mode-aware writer so every recorded event keeps its original
 * best-effort semantics AND routes to the v2 sinks (see the seam map above).
 * Both writer methods dispatch: `record` (main process / daemon absent) and
 * `recordJournalOnly` (nested worker + daemon-owned writes) — one dispatcher,
 * whichever seam an event entered through.
 */
export function createEventFanoutWriter(
  writer: EventWriter,
  handlers: FanoutHandlers,
): EventWriter {
  const route = (event: FlowRunEvent): void => {
    // The observer is guarded separately from the kind sinks so a throwing
    // identity capture can never also cost a Loki push.
    if (handlers.onEvent !== undefined) {
      try {
        handlers.onEvent(event)
      } catch {
        // never-throw (ISC-A-5)
      }
    }
    if (event.kind === 'state-change') {
      // The loop-bookkeeping observer runs FIRST and in its OWN try/catch so a
      // throwing telemetry sink never costs it (PMR-ZV9Y fix round, P1).
      if (handlers.onV2StateChangeObserved !== undefined) {
        try {
          handlers.onV2StateChangeObserved(event)
        } catch {
          // never-throw (ISC-A-5)
        }
      }
      if (handlers.onStateChange === undefined) return
      try {
        handlers.onStateChange(event)
      } catch {
        // never-throw (ISC-A-5)
      }
      return
    }
    if (event.kind === 'step-start' || event.kind === 'step-stop') {
      if (handlers.onStepEvent === undefined) return
      try {
        handlers.onStepEvent(event)
      } catch {
        // never-throw (ISC-A-5)
      }
    }
  }
  return {
    record: async (event) => {
      // The writer first, and its outcome forwarded verbatim: the fan-out is
      // a renderer, never a new durability contract.
      const journaled = await writer.record(event)
      route(event)
      return journaled
    },
    recordJournalOnly: async (event) => {
      await writer.recordJournalOnly(event)
      route(event)
    },
  }
}

/**
 * Map the resolved `telemetry.loki` config block onto the pusher's settings:
 * disabled or an empty endpoint is `null`, which `pushLokiEvent` treats as
 * ZERO fetch calls (the same no-op posture as the OTLP path).
 */
export function lokiPushSettings(settings: {
  enabled: boolean
  endpoint: string
  headers?: Record<string, string>
}): LokiSettings | null {
  if (!settings.enabled) return null
  if (settings.endpoint.length === 0) return null
  return { endpoint: settings.endpoint, headers: settings.headers ?? {} }
}

/**
 * The closed Loki label set for one v2 event (telemetry/loki.ts owns the key
 * list; this only fills it). `flow_ref`/`mode` come from the run identity,
 * never from free text; `wait_kind` derives through reasonWaitKind so a drifted
 * reason can never fabricate a "waiting on you" label. Step events carry
 * `phase`; the step NAME is not a label (ISC-A-1) — it rides the JSON line.
 */
export function buildEventLokiLabels(
  event: StateChangeEvent | StepBoundaryEvent,
  identity: FanoutIdentity,
): LokiLabels {
  const labels: LokiLabels = {
    flow_ref: identity.trackRef,
    mode: identity.mode,
    kind: event.kind,
  }
  if (event.kind === 'state-change') {
    labels.state = event.state
    const reason = event.reason
    if (reason !== undefined && reason !== '') {
      labels.reason = reason
      labels.wait_kind = reasonWaitKind(reason)
    }
    return labels
  }
  labels.phase = event.phase
  return labels
}

/** The step-span slice of the telemetry handle (TelemetryHandle satisfies it). */
export interface StepSpanHandle {
  stepStart: (phase: string, step: string) => void
  stepStop: (phase: string, step: string) => void
}

export interface TelemetryHandlerDeps {
  /** Resolved Loki push settings; null = disabled = zero network calls. */
  loki: () => LokiSettings | null
  /** Late-bound Tempo handle; null = telemetry off / not registered yet.
   * NOT re-gated here: the 4.1 handle returns early while telemetry is
   * disabled and its stepStart/stepStop carry the `isWorker()` guard, so a
   * worker session journalling a step boundary still reaches Loki but never
   * exports a duplicate step span (verified 2026-11-25). */
  handle: () => StepSpanHandle | null
  fetchImpl: LokiFetch
  now: () => number
  /** Failure note; at most one call per handler instance (shared guard). */
  onNote: (ref: string, error: string) => void
  /** Process env, read lazily for the resume case (PI_FLOW_TRACK_REF/MODE). */
  env: Record<string, string | undefined>
  timeoutMs?: number
  /**
   * AIDEV-NOTE: PMR-ZV9Y 5.2 — the desktop-notify sink, COMPOSED into
   * `onStateChange` beside the Loki push. Absent = no notify path at all
   * (the telemetry-only wiring stays silent). Each sink runs in its OWN
   * try/catch: a throwing notify never costs the Loki push and vice versa
   * (ISC-A-5), and the sinks are independent switches (D3) — `notify.desktop
   * = false` still pushes Loki, `telemetry.loki = false` still pages.
   */
  notify?: NotifySinkDeps
}

/**
 * Build the session's fan-out sinks: Loki for state-change + step boundaries,
 * Tempo step spans for step boundaries. ONE instance per session, so its
 * `LokiNoteState` once-guard and its run-identity map are exactly what the
 * 4.2 pusher expects (process-level, never per event).
 *
 * IDENTITY: runTracking is the single source for a run's trackRef + mode
 * (PMR-MSDJ 1.2), but the fan-out only ever sees ONE event at a time. So it
 * watches the `run-start` lines passing the seam (the same source runTracking
 * folds, last-wins) and falls back to the stamped attribution env for a run
 * whose start happened in an earlier process, and finally to
 * {aven ref, personal} — exactly runTracking's no-run-start semantics.
 */
export function createTelemetryHandlers(
  deps: TelemetryHandlerDeps,
): FanoutHandlers {
  const noteState: LokiNoteState = { noted: false }
  const identities = new Map<string, FanoutIdentity>()
  // PMR-ZV9Y 5.2: null = no notify channel wired (telemetry-only sessions).
  let notifySink: NotifySink | null = null
  if (deps.notify !== undefined) notifySink = createNotifySink(deps.notify)

  const identityFor = (ref: string): FanoutIdentity => {
    const observed = identities.get(ref)
    if (observed !== undefined) return observed
    const envMode = deps.env.PI_FLOW_MODE
    const envTrack = deps.env.PI_FLOW_TRACK_REF
    if (deps.env.PI_FLOW_REF === ref && envMode === 'work') {
      let trackRef = ref
      if (envTrack !== undefined && envTrack.length > 0) trackRef = envTrack
      return { trackRef, mode: 'work' }
    }
    return runTracking([], ref)
  }

  const pushToLoki = (event: StateChangeEvent | StepBoundaryEvent): void => {
    // The settings getter and the label/line build are the only throwing
    // parts here — pushLokiEvent is no-throw by contract (4.2) and callers
    // guard this function anyway.
    const settings = deps.loki()
    if (settings === null) return
    const labels = buildEventLokiLabels(event, identityFor(event.ref))
    pushLokiEvent(settings, labels, JSON.stringify(event), {
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      state: noteState,
      onNote: (error) => {
        deps.onNote(event.ref, error)
      },
      timeoutMs: deps.timeoutMs,
    })
  }

  return {
    onEvent: (event) => {
      if (event.kind !== 'run-start') return
      // Last run-start wins, the same rule runTracking pins (test/
      // run-state-tracking.test.ts): a /flow rerun in work mode must not keep
      // pushing personal-labelled Loki lines.
      identities.set(event.ref, runTracking([event], event.ref))
    },
    onStateChange: (event) => {
      // Two independently guarded sinks (4.3 Loki, 5.2 notify): a throwing
      // notify never costs the Loki push and vice versa.
      try {
        pushToLoki(event)
      } catch {
        // never-throw (ISC-A-5)
      }
      if (notifySink === null) return
      try {
        notifySink(event)
      } catch {
        // never-throw (ISC-A-5): the sink is fire-and-forget by construction
        // (createNotifySink catches inside its own async body), so this guard
        // only covers a throwing gate.
      }
    },
    onStepEvent: (event) => {
      try {
        pushToLoki(event)
      } catch {
        // never-throw (ISC-A-5)
      }
      const handle = deps.handle()
      if (handle === null) return
      try {
        if (event.kind === 'step-start') {
          handle.stepStart(event.phase, event.step)
          return
        }
        handle.stepStop(event.phase, event.step)
      } catch {
        // never-throw (ISC-A-5)
      }
    },
  }
}

// ══ DESKTOP NOTIFY SINK (PMR-ZV9Y 5.2) ═══════════════════════════════════
// AIDEV-NOTE: PMR-ZV9Y 5.2 — the second human-facing renderer of the v2 state
// machine: the live session's paging channel. It is a SIBLING of the Loki push
// inside `createTelemetryHandlers().onStateChange`, and each sink is guarded
// SEPARATELY — a throwing notify never costs the Loki line, and vice versa
// (ISC-A-5). pi-desktop-notify is an OPTIONAL dependency: the ONLY reference to
// it in this file is `typeof import(...)` (type-only, erased at emit) plus the
// dynamic `import()` in loadNotifyModule below. NEVER add a static import of
// '@gtheys/pi-desktop-notify' here — test/notify-hook.test.ts pins that, and a
// static edge would make an absent package a load-time crash instead of a
// degraded channel.
//
// FIRE RULE (exactly two states, `shouldNotifyState`): `waiting_human` (a
// human unblocks it) and `halted` (a human must). `waiting_machine` is Grafana/
// Loki material, never a page; `running`/`done`/`stale` silent. Gate ORDER is
// state → config → import, so a disabled or non-paging event never touches the
// module system.
//
// DEDUPE (decided, pinned by test/notify-hook.test.ts): ONE notification per
// state-change EVENT — no per-(ref, state, reason) once-guard. 2.1's guarded
// emission already suppresses same-state repeats inside a process, so a repeat
// only happens when a gate genuinely re-asks (waiting_human → running →
// waiting_human), which earns a second page. Cross-process re-asks (a resumed
// run, a second session) re-notify too: accepted, because the notification
// mirrors the journal and the journal is the audit record.
//
// MESSAGE FORMAT (pinned; keep it short + grep-able — a notification is an
// interruption, the journal is the detail):
//   summary  `pi-flow <ref>: <state>`
//   body     waiting_human → `<expectedAction> — reason: <reason>`
//            e.g. `/flow answer PMR-ZV9Y pass|fail — reason: code_review_pending`
//            halted        → `reason: <reason> — recover with /flow <ref>`
//            no registered action/reason → `recover with /flow <ref>`
// The action half comes from `expectedAction` (flow/vocabulary.ts is the single
// source; the Waiting-on-me board mirrors the same strings), so the command an
// operator types is exactly what the board already advertises. Free text (halt
// prose) never enters the body — the closed reason enum only (ISC-A-1).
//
// FAILURE POSTURE: at most ONE `onNote` per sink instance (the sink is built
// once per session, like the Loki note guard), then the channel is OFF for the
// rest of the session — never a retry storm, never a rejected promise into the
// host, never a throw into the flow loop.

/** The `@gtheys/pi-desktop-notify/notify` surface (subtask 5.1), referenced
 * TYPE-ONLY so an uninstalled optional dependency never breaks this module at
 * RUNTIME (the type reference erases; only `loadNotifyModule` below touches the
 * package, dynamically, inside a try/catch). Caveat: a consumer that runs `tsc`
 * over pi-flow's SOURCES needs the optional package present to resolve the
 * type — pi's loader does not typecheck, so an installed-without-notify setup
 * still runs, it just degrades the channel on the first paging event. */
export type DesktopNotifyModule =
  typeof import('@gtheys/pi-desktop-notify/notify')

/** The production dynamic-import seam. Rejects when the package is absent or
 * broken; `createNotifySink` turns that into one warn line + channel off. */
function loadNotifyModule(): Promise<DesktopNotifyModule> {
  return import('@gtheys/pi-desktop-notify/notify')
}

export interface NotifySinkDeps {
  /** Late-bound `notify.desktop.enabled` (default TRUE — an opt-out channel).
   * Checked BEFORE the import, so a disabled channel loads nothing. */
  desktop: () => boolean
  /** Session cwd: pi-desktop-notify loads ITS OWN channel config (desktop /
   * herdr / ntfy toggles) with it, so the user's per-repo notify settings win
   * and pi-flow only decides whether a flow event pages at all. */
  cwd: () => string
  /** Dynamic-import seam (tests inject a fake; default = the 5.1 subpath). */
  loadModule?: () => Promise<DesktopNotifyModule>
  /** ONE call per sink instance on the first channel failure. */
  onNote: (ref: string, error: string) => void
}

/** The v2 states that page a human (everything else stays board-only). */
export function shouldNotifyState(state: FlowState): boolean {
  if (state === 'waiting_human') return true
  return state === 'halted'
}

/** Notification title: ref + state, the shortest grep-able identity. */
export function notifySummary(event: StateChangeEvent): string {
  return `pi-flow ${event.ref}: ${event.state}`
}

/** Notification body: the command that unblocks the run, then the closed
 * reason. See the MESSAGE FORMAT note above. */
export function notifyBody(event: StateChangeEvent): string {
  const reason = event.reason
  const action = expectedAction(event.state, reason ?? '', event.ref)
  const parts: string[] = []
  if (action !== NO_EXPECTED_ACTION) parts.push(action)
  if (reason !== undefined && reason !== '') parts.push(`reason: ${reason}`)
  // A halt registers no unblock command, so the recovery hint carries it; a
  // transition with neither still says what to type.
  if (event.state === 'halted' || parts.length === 0) {
    parts.push(`recover with ${recoveryCommand(event.ref)}`)
  }
  return parts.join(' — ')
}

/** The sink's own handle: call it with every v2 state-change event. */
export type NotifySink = (event: StateChangeEvent) => void

/**
 * Build the session's desktop-notify sink. ONE instance per session (like the
 * handler bag that composes it), so the once-guard and the cached module
 * import are exactly process-scoped.
 */
export function createNotifySink(deps: NotifySinkDeps): NotifySink {
  const loadModule = deps.loadModule ?? loadNotifyModule
  let loading: Promise<DesktopNotifyModule> | null = null
  let noted = false
  let off = false

  const noteOnce = (ref: string, error: unknown): void => {
    if (noted) return
    noted = true
    let text = 'unknown notify failure'
    if (error instanceof Error) text = error.message
    deps.onNote(ref, text)
  }

  return (event) => {
    if (off) return
    // Sync, allocation-free gate first (see the FIRE RULE note).
    if (!shouldNotifyState(event.state)) return
    // Fire-and-forget: the fan-out must never await a desktop notification.
    void (async () => {
      try {
        if (!deps.desktop()) return
        if (loading === null) loading = loadModule()
        // Aliased so the await below keeps the narrowed type (a mutable
        // closure variable loses its narrowing across an await).
        const pending = loading
        const notify = await pending
        const config = await notify.loadConfig(deps.cwd())
        await notify.dispatchNotification(
          config,
          notifySummary(event),
          notifyBody(event),
        )
      } catch (error) {
        // Absent/broken package, a malformed notify config, or a dead channel:
        // ONE line, then the channel stays off for the session. The module
        // import is not retried per event either (`loading` keeps the
        // rejected promise, and `off` stops later calls from reaching it).
        off = true
        noteOnce(event.ref, error)
      }
    })()
  }
}
