// AIDEV-NOTE: PMR-ZV9Y 3.1 — the pure v2 journal→Prometheus derivation behind
// the six gauge families of the plan's vocabulary table: pi_flow_state,
// pi_flow_state_start_seconds, pi_flow_phase, pi_flow_wait_seconds,
// pi_flow_step, pi_flow_step_seconds.
//
// NODE-ONLY, DAEMON-REACHABLE, PURE. Closure is deliberately narrower than
// cost-rows.ts's allowlist: '../run-state.ts' (types + `projectRunState`),
// './vocabulary.ts', './cost-rows.ts' (`labelString`) — nothing else, no node
// builtin needed. Subtask 3.2 adds this file to the textual guard in
// test/cost-rows-node-only.test.ts. No I/O and no `Date.now()`: identical
// events render byte-identical lines, which is what the Pushgateway group body
// depends on (flow/push.ts). The cycle this creates once 3.2 wires it in
// (cost-rows → run-health → state-metrics → cost-rows) is ESM-safe for the
// same reason the existing cost-rows ↔ run-health cycle is: every side exports
// hoisted function declarations consumed at CALL time — never call
// `labelString` from a module initializer here.
//
// THE DERIVATION CONTRACT (pinned by test/state-metrics.test.ts):
//  1. Current state: the projected `FlowRunState.currentState` wins. It IS the
//     last valid 'state-change' (applyEvent enforces the closed enums), so a
//     drifted enum can never become a label value — ISC-A-1 holds by
//     construction, not by re-checking here.
//  2. Legacy fallback (ISC-6): with no 'state-change' events, v2 state comes
//     from the projected v1 loop status — paused→waiting_human, halted→halted,
//     running→running, done→done — always with reason '' ("old runs render,
//     just without reason granularity"). `LoopRunStatus` is untouched
//     (ISC-A-2). The state's start is the last 'loop-state' event's `at`,
//     because LoopStateRecord carries no timestamp of its own.
//  3. No projection (no run-start) and no loop snapshot → null → NO lines,
//     mirroring renderRunHealthLines for the same journal: both blocks in one
//     push body must describe the same run.
//  4. Wait windows walk the RAW events (a dropped projection write must never
//     lose window math). A window opens at a transition whose (state, reason)
//     pair differs from the open window's and closes at the next transition;
//     identical repeats do NOT restart the clock, a reason change DOES
//     re-open (the seconds then land in the new reason's bucket, which is the
//     point of the per-reason gauge). Open windows contribute nothing,
//     re-opened waits sum, arithmetic stays unfloored — the same posture as the
//     retired v1 scanPausedWindows in run-health.ts. Only waiting_human /
//     waiting_machine accumulate; running / halted / done / stale never count
//     as a wait.
//  5. A journal with no 'state-change' events falls back to the paused-window
//     scan re-implemented here (wait_kind 'human', reason '') rather than
//     importing run-health.ts: that import is not on this subtask's allowlist
//     and would deepen the cycle above. The arithmetic mirrored run-health.ts's
//     scanPausedWindows exactly, so ISC-6 values agreed with the frozen
//     pi_flow_human_wait_seconds aggregate. AIDEV-NOTE (PMR-ZV9Y 7.1): that
//     aggregate and its scan are RETIRED, which makes this mirror the sole
//     implementation of the paused-window arithmetic — the values it produces
//     are unchanged, they simply no longer have a v1 twin to match. A v2 journal
//     never runs the legacy scan — the two would double-count the same pause.
//
// AIDEV-NOTE: THE TYPE-LINE RULE — never add `# TYPE` / `# HELP` lines here,
// even though that looks like the "correct" exposition format. No source in
// this package emits them; the gateway auto-detects and stores every family
// here as UNTYPED (the `# TYPE pi_flow_run_status untyped` strings in the
// test/push.ts and test/reconcile.ts fixtures are copied from a LIVE dump). So
// bare lines ARE the repo convention, not an omission. Emitting
// `# TYPE pi_flow_state gauge` would flip that family to gauge on the first
// push while `filterGroupLines` (flow/push.ts) strips every `#` line from the
// body `tombstoneBody` re-POSTs (flow/reconcile.ts) — typed first push plus
// untyped re-POST is the whole-group 400 documented in the push.ts header
// (PMR-WBC2: "… is not a GAUGE", which once made every tombstone re-POST
// fail). It would break reconcile for every ref carrying v2 lines, starting
// with the pi_flow_state series the cutover alert reads.
//
// AIDEV-NOTE: CARDINALITY POSTURE (ISC-A-1). state / reason / wait_kind are
// closed-enum by construction (projection-validated; wait_kind through
// reasonWaitKind). phase comes from the projection or the PHASE_VALUES guard
// below. `step` is the only label read straight off a journal event, and it is
// CHARSET-GUARDED (STEP_NAME_RE) rather than registry-checked. That is a
// DELIBERATE allowlist choice, not a reachability limit: flow/steps.ts is in
// fact daemon-safe (its only import is `import type { Phase }`, erased at
// runtime, so the transitive closure walk in test/cost-rows-node-only.test.ts
// would accept it), but a VALUE import of it would trip the per-root DIRECT
// textual allowlist `ROOT_ALLOWLISTS['flow/state-metrics.ts']` in that same
// guard, which locked for 3.1/3.2 lists only run-state / cost-rows /
// vocabulary. We keep the closure narrower than strictly necessary because
// registry membership is ALREADY enforced at the emit boundary (subtask 1.2
// binds the prompt letters to STEP_REGISTRY and flow_submit warns on
// unregistered names); the charset guard here exists only to keep free text —
// a halt note pasted by a future writer — out of a label value (ISC-A-1).
// AIDEV-NOTE (PMR-ZV9Y fix round, P3b): an earlier revision of this note
// claimed importing steps.ts "would violate the node-only allowlist" as if it
// were unreachable. That was imprecise — it is reachable; it is simply not on
// the deliberately narrow direct allowlist, and adding it would force an edit
// to the frozen closure guard for a check the emit boundary already performs.
// AIDEV-NOTE (PMR-ZV9Y fix-round-3, deviation #3): that P3b posture is now
// SUPERSEDED — the closure guard is widened and state-metrics.ts DOES
// value-import isRegisteredStep from './steps.ts' (the widening is safe exactly
// as P3b described it: steps.ts is pure data, its lone './orchestrate.ts' edge
// is type-only and erased at runtime, so the transitive closure walk never
// loads orchestrate.ts; flow/steps.ts is registered as its own guard root).
// The `step` label is therefore now REGISTRY-CLOSED at the render boundary
// (scanStepWindows rejects any step isRegisteredStep(phase, step) is false for,
// for BOTH pi_flow_step and pi_flow_step_seconds), which is the spec's
// "Registered names only" rule (plan.md:37) and the real bounded-cardinality
// guarantee ISC-A-1 wanted. STEP_NAME_RE is kept as a cheap pre-filter that
// rejects structurally-broken values (spaces, over-length) before the registry
// lookup — NOT as the cardinality control any more. The journal + Loki line
// still carry unregistered / free-form step names (implement + feedback
// registries are empty by design); only the Prometheus LABEL surface is
// registry-closed. The paragraph above (charset-only rationale) is retained as
// history per G-1 — it is no longer the implemented contract.

import type { FlowPhase, FlowRunEvent } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import { labelString } from './cost-rows.ts'
import { isRegisteredStep } from './steps.ts'
import type { FlowReason, FlowState, WaitKind } from './vocabulary.ts'
import { FLOW_REASONS, FLOW_STATES, reasonWaitKind } from './vocabulary.ts'

/** A v2 state with the journal timestamp it began at. */
export interface V2State {
  state: FlowState
  reason: FlowReason | ''
  at: string
}

/** One in-flight (phase, step) pair. */
export interface OpenStep {
  phase: FlowPhase
  step: string
}

export interface StateWindowScan {
  /**
   * Cumulative wait seconds per (wait_kind, reason), keyed
   * `"<wait_kind>\u0000<reason>"` (the run-health composite-key convention,
   * so no separator can collide with an enum value). Insertion order is
   * first-contribution order, which is what the render path needs for a
   * byte-stable body. Buckets with no measurable seconds never appear.
   */
  seconds: Map<string, number>
}

export interface StepWindowScan {
  /**
   * Cumulative COMPLETED seconds per (phase, step), keyed
   * `"<phase>\u0000<step>"`, first-contribution order.
   */
  seconds: Map<string, number>
  /** Steps with an unmatched step-start, in first-start order. */
  open: OpenStep[]
}

/**
 * The phase vocabulary, mirrored from `FlowPhase` in run-state.ts (that
 * module keeps its own `PHASES` list private, and importing a constant from
 * flow/orchestrate.ts would drag the session-side graph into this daemon
 * closure). test/state-metrics.test.ts pins the guard by rejecting a journal
 * whose step event carries an out-of-vocabulary phase.
 */
const PHASE_VALUES: readonly FlowPhase[] = [
  'plan',
  'implement',
  'validate',
  'feedback',
]

/**
 * Structural pre-filter for a journaled step name. This is NO LONGER the
 * cardinality control on its own — the registry IS (see below). It rejects
 * structurally-broken values (spaces, over-length) cheaply BEFORE the
 * `isRegisteredStep` lookup in scanStepWindows, so a pasted free-text halt note
 * never even reaches a registry call. The registry gate is the authority now
 * (PMR-ZV9Y fix-round-3, deviation #3): this module value-imports
 * `isRegisteredStep` from './steps.ts' and scanStepWindows drops any
 * (phase, step) the registry does not list, for BOTH pi_flow_step and
 * pi_flow_step_seconds. The earlier "enforced at the emit boundary only, so
 * this module does not consult the registry" posture is RETIRED — the charset
 * alone let a well-formed-but-unregistered name (validate.bogus) become a label
 * value, which is exactly the unbounded-cardinality leak ISC-A-1 forbids.
 * './steps.ts' is now on the per-root direct allowlist
 * `ROOT_ALLOWLISTS['flow/state-metrics.ts']` in test/cost-rows-node-only.test.ts
 * and flow/steps.ts is registered as its own guard root; the widening is safe
 * because steps.ts is pure data (a const map + a predicate, no I/O, no pi
 * runtime) whose lone './orchestrate.ts' edge is type-only and erased at
 * runtime. The charset mirrors flow_submit's own validation (FLOW_VALUE_RE:
 * alphanumeric plus `. _ -`, ≤64 chars) and the registry's `<phase>.<name>`
 * naming, so a free-text value can never become a label value — ISC-A-1.
 * AIDEV-NOTE (PMR-ZV9Y fix round, P3b): corrected from the earlier "would
 * violate the node-only allowlist" wording, which overstated a reachability
 * limit that is really a narrow, deliberate allowlist choice. (Superseded by
 * fix-round-3: the choice is gone — the allowlist is widened deliberately.)
 */
const STEP_NAME_RE = /^[a-z]+\.[A-Za-z0-9._-]{1,63}$/

/** Mirror of run-health.ts's epochSeconds: unparseable or absent → undefined. */
function epochSeconds(at: string): number | undefined {
  if (typeof at !== 'string') return undefined
  const seconds = Math.floor(Date.parse(at) / 1000)
  if (!Number.isFinite(seconds)) return undefined
  return seconds
}

/**
 * Positive finite span between two journal timestamps, in seconds. `undefined`
 * covers every unusable case (non-string, unparseable, zero, negative — the
 * last two mean the journal is out of order, which must never fabricate a
 * negative gauge). Same unfloored millisecond math as the retired v1
 * scanPausedWindows.
 */
function spanSeconds(fromAt: string, toAt: string): number | undefined {
  if (typeof fromAt !== 'string' || typeof toAt !== 'string') return undefined
  const seconds = (Date.parse(toAt) - Date.parse(fromAt)) / 1000
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds
}

/** The valid 'state-change' events, in journal order. */
function stateTransitions(
  events: readonly FlowRunEvent[],
): Array<{ state: FlowState; reason: FlowReason | ''; at: string }> {
  const out: Array<{ state: FlowState; reason: FlowReason | ''; at: string }> =
    []
  for (const event of events) {
    if (event.kind !== 'state-change') continue
    // Same vocabulary rules as applyEvent (run-state.ts): out-of-vocabulary
    // transitions are evidence in the journal but never a label value.
    if (!FLOW_STATES.includes(event.state)) continue
    const reason = event.reason === undefined ? '' : event.reason
    if (typeof reason !== 'string') continue
    if (reason !== '' && !FLOW_REASONS.includes(reason as FlowReason)) continue
    if (typeof event.at !== 'string') continue
    out.push({
      state: event.state,
      reason: reason as FlowReason | '',
      at: event.at,
    })
  }
  return out
}

/**
 * The current v2 state: the projection when the journal has v2 events, else
 * the legacy loop-status mapping (ISC-6). Pure.
 */
export function deriveV2State(events: readonly FlowRunEvent[]): V2State | null {
  const projected = projectRunState(events)
  if (projected === null) return null
  const current = projected.currentState
  if (current !== undefined) {
    return { state: current.state, reason: current.reason, at: current.at }
  }
  const loop = projected.loop
  if (loop === undefined) return null
  // LoopStateRecord has no timestamp, so the state's start comes from the
  // raw event that produced the projected record (the last loop-state).
  let at = ''
  for (const event of events) {
    if (event.kind !== 'loop-state') continue
    if (typeof event.at !== 'string') continue
    at = event.at
  }
  let state: FlowState = 'done'
  if (loop.status === 'paused') state = 'waiting_human'
  else if (loop.status === 'halted') state = 'halted'
  else if (loop.status === 'running') state = 'running'
  return { state, reason: '', at }
}

/** The wait kind for a window: the reason's kind, else the state's. */
function waitKind(state: FlowState, reason: FlowReason | ''): WaitKind {
  if (reason !== '') return reasonWaitKind(reason)
  if (state === 'waiting_human') return 'human'
  return 'machine'
}

function addWait(
  seconds: Map<string, number>,
  window: { state: FlowState; reason: FlowReason | ''; at: string },
  span: number | undefined,
): void {
  if (span === undefined) return
  if (window.state !== 'waiting_human' && window.state !== 'waiting_machine') {
    return
  }
  const kind = waitKind(window.state, window.reason)
  const key = `${kind}\u0000${window.reason}`
  seconds.set(key, (seconds.get(key) ?? 0) + span)
}

/**
 * Legacy paused-window scan, mirroring run-health.ts's RETIRED
 * scanPausedWindows (PMR-ZV9Y 7.1 — this is now the only implementation of
 * that arithmetic):
 * a window opens at the first paused loop-state snapshot and closes at the
 * next event that is NOT a paused loop-state (consecutive paused snapshots do
 * not restart the clock); an unclosed window contributes nothing. Returns the
 * v2 bucket so the render path stays a single code path.
 */
function legacyWaitSeconds(
  events: readonly FlowRunEvent[],
): Map<string, number> {
  const seconds = new Map<string, number>()
  let openAt: string | null = null
  let total = 0
  for (const event of events) {
    let isPausedSnapshot = false
    if (event.kind === 'loop-state' && event.loop.status === 'paused') {
      isPausedSnapshot = true
    }
    if (openAt === null) {
      if (isPausedSnapshot) openAt = event.at
      continue
    }
    if (isPausedSnapshot) continue
    const span = spanSeconds(openAt, event.at)
    if (span !== undefined) total += span
    openAt = null
  }
  if (total > 0) seconds.set('human\u0000', total)
  return seconds
}

/**
 * Cumulative v2 wait seconds per (wait_kind, reason) — the arithmetic behind
 * `pi_flow_wait_seconds`. Reads the RAW event list, so a re-opened wait opens
 * a new window (plan PMR-ZV9Y, "Duplicate state-change events"). A journal
 * with no v2 'state-change' events falls back to the paused-window scan.
 * Pure; open windows contribute nothing.
 */
export function scanStateWindows(
  events: readonly FlowRunEvent[],
): StateWindowScan {
  const transitions = stateTransitions(events)
  if (transitions.length === 0) {
    return { seconds: legacyWaitSeconds(events) }
  }
  const seconds = new Map<string, number>()
  let open: { state: FlowState; reason: FlowReason | ''; at: string } | null =
    null
  for (const transition of transitions) {
    if (open === null) {
      open = transition
      continue
    }
    if (transition.state === open.state && transition.reason === open.reason) {
      continue
    }
    addWait(seconds, open, spanSeconds(open.at, transition.at))
    open = transition
  }
  // `open` is deliberately left unclosed at the end of the journal: the run
  // is still in that state, and pi_flow_state_start_seconds carries its age.
  return { seconds }
}

/**
 * v2 step windows: cumulative completed seconds per (phase, step) plus the
 * in-flight steps behind `pi_flow_step` / `pi_flow_step_seconds`.
 *
 * AIDEV-NOTE: pairing is per (phase, step) with LAST-START-WINS. A duplicate
 * step-start with no stop in between is the process-restart / re-ask path
 * (the loop re-journals 'step-start' when it re-enters the gate), and the
 * journaled stop is evidence of the work that JUST finished — measuring from
 * the first start would inflate the step duration with the dead time of the
 * abandoned attempt. A step-stop with no open start is ignored (a journal
 * whose head was truncated, or a stop recorded after a restart). An unclosed
 * step contributes no seconds but stays in `open`.
 */
export function scanStepWindows(
  events: readonly FlowRunEvent[],
): StepWindowScan {
  const seconds = new Map<string, number>()
  const startedAt = new Map<string, string>()
  const order: string[] = []
  const labels = new Map<string, OpenStep>()
  for (const event of events) {
    if (event.kind !== 'step-start' && event.kind !== 'step-stop') continue
    if (!PHASE_VALUES.includes(event.phase)) continue
    if (typeof event.step !== 'string') continue
    if (!STEP_NAME_RE.test(event.step)) continue
    // AIDEV-NOTE: PMR-ZV9Y fix-round-3 (deviation #3) — the registry is now
    // the label-surface authority (plan.md:37 "Registered names only"). A
    // charset-valid but UNREGISTERED name is ignored for BOTH gauges, which
    // also empties implement/feedback (free-form flow_submit names by design).
    // The journal + Loki line still carry them — only the Prometheus label
    // surface is registry-closed (bounded cardinality, ISC-A-1). Keeping
    // STEP_NAME_RE above is still load-bearing: it rejects structurally-broken
    // values (spaces, >64 chars) cheaply before the registry lookup, and
    // isRegisteredStep would otherwise index a free-text halt note.
    if (!isRegisteredStep(event.phase, event.step)) continue
    if (typeof event.at !== 'string') continue
    const key = `${event.phase}\u0000${event.step}`
    if (event.kind === 'step-start') {
      startedAt.set(key, event.at)
      labels.set(key, { phase: event.phase, step: event.step })
      if (!order.includes(key)) order.push(key)
      continue
    }
    const start = startedAt.get(key)
    if (start === undefined) continue
    startedAt.delete(key)
    const span = spanSeconds(start, event.at)
    if (span === undefined) continue
    seconds.set(key, (seconds.get(key) ?? 0) + span)
  }
  const open: OpenStep[] = []
  for (const key of order) {
    if (!startedAt.has(key)) continue
    const label = labels.get(key)
    if (label === undefined) continue
    open.push(label)
  }
  return { seconds, open }
}

/**
 * AIDEV-NOTE: PMR-ZV9Y fix round (P3a) — the terminal derived states that carry
 * NO live in-flight step: halted / done / stale. When `deriveV2State` yields
 * one of these, `renderStateMetricLines` suppresses the open-step `pi_flow_step`
 * lines (an unclosed step-start on a finished run is a phantom, see the render
 * path). `running`, `waiting_human` and `waiting_machine` are NOT terminal: a
 * genuinely open step there is real live state. A `null` derived state (no
 * projection) is treated as non-terminal here because the whole render already
 * returns no state lines in that case (contract 3), and the open-step loop
 * simply has nothing else to gate against.
 */
function isTerminalState(current: V2State | null): boolean {
  if (current === null) return false
  if (current.state === 'halted') return true
  if (current.state === 'done') return true
  return current.state === 'stale'
}

/** The current phase: the loop snapshot wins, else the projected current phase. */
function currentPhaseLabel(events: readonly FlowRunEvent[]): FlowPhase | null {
  const projected = projectRunState(events)
  if (projected === null) return null
  if (projected.loop !== undefined) return projected.loop.phase
  if (projected.currentPhase !== undefined) return projected.currentPhase
  return null
}

/**
 * Render the six v2 gauge families for one ref (plan PMR-ZV9Y's vocabulary
 * table, in that order): pi_flow_state, pi_flow_state_start_seconds,
 * pi_flow_phase, pi_flow_wait_seconds, pi_flow_step, pi_flow_step_seconds.
 *
 * AIDEV-NOTE: bare sample lines only — no `# TYPE` / `# HELP`, for the
 * tombstone round-trip reason recorded in the module header above (and the
 * same posture as the frozen run-health.ts block).
 *
 * No `mode` label: the Pushgateway group URL carries it (v1 convention).
 * Every label value comes from a closed enum or the structural step guard,
 * so a free-text halt note can never reach a label (ISC-A-1). First-seen
 * order everywhere; a bucket with nothing measured emits no line (never an
 * invented zero — the cost body takes the same posture for coverage gaps).
 */
export function renderStateMetricLines(
  ref: string,
  events: readonly FlowRunEvent[],
): string[] {
  const lines: string[] = []
  const current = deriveV2State(events)
  if (current !== null) {
    const labels = labelString({
      ref,
      state: current.state,
      reason: current.reason,
    })
    lines.push(`pi_flow_state{${labels}} 1`)
    const start = epochSeconds(current.at)
    if (start !== undefined) {
      lines.push(`pi_flow_state_start_seconds{${labels}} ${start}`)
    }
  }
  const phase = currentPhaseLabel(events)
  if (phase !== null) {
    lines.push(`pi_flow_phase{${labelString({ ref, phase })}} 1`)
  }
  for (const [key, value] of scanStateWindows(events).seconds) {
    const separator = key.indexOf('\u0000')
    lines.push(
      `pi_flow_wait_seconds{${labelString({
        ref,
        wait_kind: key.slice(0, separator),
        reason: key.slice(separator + 1),
      })}} ${value}`,
    )
  }
  const steps = scanStepWindows(events)
  // AIDEV-NOTE: PMR-ZV9Y fix round (P3a) — an open step is LIVE in-flight
  // evidence. Once the derived state is halted / done / stale the run has no
  // work in flight, so an unmatched step-start (a code-review ask aborted by
  // Escape, a deviation verdict that kept re-running until the halt, a
  // spec-approval pause on a since-closed ticket) would otherwise render
  // `pi_flow_step{…} 1` forever — the gateway merges on write (push.ts), so the
  // line persists in the stored body and surfaces on the piflow-runs
  // "Live state" row for a dead run. Suppress the open-step lines whenever the
  // derived state is halted/done/stale; running and both waiting states keep
  // them, because there a genuinely open step is real. The COMPLETED
  // `pi_flow_step_seconds` buckets stay — they are cumulative durations, not
  // in-flight evidence. This is the render-side half; the tombstone-side
  // decision is recorded in flow/reconcile.ts `tombstoneBody`.
  if (!isTerminalState(current)) {
    for (const openStep of steps.open) {
      lines.push(
        `pi_flow_step{${labelString({
          ref,
          phase: openStep.phase,
          step: openStep.step,
        })}} 1`,
      )
    }
  }
  for (const [key, value] of steps.seconds) {
    const separator = key.indexOf('\u0000')
    lines.push(
      `pi_flow_step_seconds{${labelString({
        ref,
        phase: key.slice(0, separator),
        step: key.slice(separator + 1),
      })}} ${value}`,
    )
  }
  return lines
}
