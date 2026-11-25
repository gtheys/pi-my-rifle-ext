// AIDEV-NOTE: PMR-ZV9Y 4.3 — THE writer fan-out dispatcher (renderer #2's
// router of the plan's three-renderer architecture: Prometheus folds the
// journal in the push chain, THIS module re-renders each event live to Loki +
// the Tempo step spans, pi-desktop-notify joins the same bag in phase 5).
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
import { reasonWaitKind } from '../flow/vocabulary.ts'
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
      try {
        pushToLoki(event)
      } catch {
        // never-throw (ISC-A-5)
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
