// AIDEV-NOTE: run-lifecycle health metrics for the Pushgateway push body.
// These series are JOURNAL-PROJECTION-ONLY: every value is derived from the
// run journal events (projectRunState + raw event scans), never from session
// jsonl files — so they appear even when session coverage gaps exist, and
// they keep working if cost attribution changes shape. Dashboards
// `piflow-health/runs` consume these exact metric names/labels (frozen —
// renaming a metric or label is a dashboard-breaking change).
// AIDEV-NOTE (PMR-8MQH 4.2): WHO PUSHES these lines changed, WHAT they say
// did not. `pi_flow_run_status` used to reach the gateway only from the
// session-side terminal autopush; since PMR-8MQH the daemon's periodic
// liveness pass (flow/liveness.ts) also pushes this same render for refs
// whose journal projects `running`, so a `running` value now refreshes while
// a run is in flight. No metric name, label key, label value or line ORDER
// changed — the frozen rule above still holds, and both producers render
// through the identical buildPushBody path.
// AIDEV-NOTE (PMR-8MQH 1.2): labelString is imported from './cost-rows.ts',
// NOT './cost.ts' — cost.ts value-imports the pi-interactive-subagents root
// (heavy extension graph), so an edge there would silently drag the session-
// side runtime into this daemon-reachable module's closure. The OLD
// cost.ts <-> run-health.ts cycle is gone; the NEW one here (cost-rows <->
// run-health) is deliberate and ESM-safe: both sides export only hoisted
// function declarations consumed at call time, never at module init. The
// closure guard in test/cost-rows-node-only.test.ts keeps cost.ts out of it.
// AIDEV-NOTE (PMR-ZV9Y 3.2): the frozen block below is FROZEN-UNTIL-CUTOVER,
// not frozen-forever. Subtask 3.2 appended the v2 state-machine gauges as
// blocks 10+ (see renderStateMetricLines below), so this module now renders
// BOTH vocabularies at once — deliberately, because the live alert rules and
// the `piflow-*` boards still read the v1 series and the cutover is one
// deliberate move in 6.5. The retirement of the v1 state-vocabulary lines
// (run status, halt reason, human wait, gate waits) belongs to phase 7 ONLY,
// and nothing before 6.5 may move, rename or drop an existing line. The
// additive rule and the reason the v1 lines cannot be dropped early are both
// recorded at the append site below and in flow/state-metrics.ts.
import type { FlowRunEvent } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import { labelString } from './cost-rows.ts'
import { renderStateMetricLines } from './state-metrics.ts'

// `at` is a raw journal string (readRunEvents casts JSON.parse output), so an
// unparseable timestamp is possible in practice: treat it as "absent" instead
// of letting NaN reach the exposition body. The human-wait window scan keeps
// its own millisecond math — flooring there would change existing values.
function epochSeconds(at: string): number | undefined {
  const seconds = Math.floor(Date.parse(at) / 1000)
  if (!Number.isFinite(seconds)) return undefined
  return seconds
}

// AIDEV-NOTE: pi_flow_run_start_seconds is ADDITIVE — it joins the frozen
// series above without renaming or reordering any existing line. It is no
// longer literally the last line: additive metrics go after the frozen block
// in order of introduction, so newer additive series
// (pi_flow_gate_wait_seconds below) are appended AFTER this one.
// Consumers: the homelab `piflow-runs` dashboard ("Started"
// column and the run timeline panel), which needs an absolute epoch timestamp
// per ref; gauge values alone only say "this ref exists", not when it began.
// Derived from the journal: the FIRST 'run-start' event wins (a restart
// re-records run-start, but the run's start stays the original one), falling
// back to the earliest event timestamp when no run-start carries a parseable
// `at`. No usable timestamp means no line at all.
function runStartSeconds(events: readonly FlowRunEvent[]): number | undefined {
  for (const event of events) {
    if (event.kind !== 'run-start') continue
    const seconds = epochSeconds(event.at)
    if (seconds !== undefined) return seconds
  }
  let earliest: number | undefined
  for (const event of events) {
    const seconds = epochSeconds(event.at)
    if (seconds === undefined) continue
    if (earliest === undefined || seconds < earliest) earliest = seconds
  }
  return earliest
}

/**
 * Render the Prometheus exposition lines for run health (status gauge, halt
 * reason, gate decision counts, human wait seconds, retry/blocker counters,
 * worktree-sweep counts, run start epoch seconds, per-gate wait seconds).
 * Pure: same journal events in, same lines out.
 * Metric order is fixed; within a grouped metric lines follow first-seen
 * event order so pushes stay byte-stable for the Pushgateway group. The
 * FROZEN block (run status … worktree sweep) never moves; additive series are
 * appended after it in order of introduction (run start, then gate waits,
 * then the v2 state-machine gauges — see the AIDEV-NOTE at the append site).
 */
export function renderRunHealthLines(
  ref: string,
  events: readonly FlowRunEvent[],
): string[] {
  const state = projectRunState(events)
  if (state === null) return []
  const lines: string[] = []
  // 1+2 — run status gauge and the halt reason (last journaled note).
  if (state.loop !== undefined) {
    lines.push(
      `pi_flow_run_status{${labelString({ ref, status: state.loop.status })}} 1`,
    )
    if (state.loop.status === 'halted') {
      let reason = ''
      const lastNote = state.notes[state.notes.length - 1]
      if (lastNote !== undefined) reason = lastNote.text
      lines.push(`pi_flow_run_halt_reason{${labelString({ ref, reason })}} 1`)
    }
  }
  // 3 — gate decisions: RAW gate-answer events grouped by (gate, choice).
  // The projection deliberately keeps only the latest answer per gate, so
  // counting it would erase the reject→approve retry churn this measures.
  const gateCounts = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'gate-answer') continue
    const key = `${event.gate}\u0000${event.choice}`
    gateCounts.set(key, (gateCounts.get(key) ?? 0) + 1)
  }
  for (const [key, count] of gateCounts) {
    const separator = key.indexOf('\u0000')
    lines.push(
      `pi_flow_gate_decisions_total{${labelString({
        ref,
        gate: key.slice(0, separator),
        choice: key.slice(separator + 1),
      })}} ${count}`,
    )
  }
  // 4 — human wait: paused windows scanned over the RAW ordered events (see
  // scanPausedWindows). The same scan feeds pi_flow_gate_wait_seconds below.
  const windows = scanPausedWindows(events)
  const waitSeconds = windows.waitSeconds
  if (waitSeconds > 0) {
    lines.push(
      `pi_flow_human_wait_seconds{${labelString({ ref })}} ${waitSeconds}`,
    )
  }
  // 5 — retry attempts (flow_run_attempt budget; 'passed' resets to 0).
  let attempts = 0
  if (state.attempts !== undefined) attempts = state.attempts
  lines.push(`pi_flow_retry_attempts{${labelString({ ref })}} ${attempts}`)
  // 6 — blocker retries from the loop record.
  let blockerRetries = 0
  if (state.loop !== undefined) blockerRetries = state.loop.blockerRetries
  lines.push(
    `pi_flow_blocker_retries{${labelString({ ref })}} ${blockerRetries}`,
  )
  // 7 — worktree sweep outcomes (evidence-only in the projection, so the
  // RAW events carry the counts).
  const sweepCounts = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'worktree-sweep') continue
    sweepCounts.set(event.outcome, (sweepCounts.get(event.outcome) ?? 0) + 1)
  }
  for (const [outcome, count] of sweepCounts) {
    lines.push(
      `pi_flow_worktree_sweep_total{${labelString({ ref, outcome })}} ${count}`,
    )
  }
  // 8 — run start epoch seconds (additive; see the AIDEV-NOTE
  // above runStartSeconds). Appending here — after the frozen block and
  // before the newer additive series below — keeps every existing line
  // byte-identical and in its original position.
  const startSeconds = runStartSeconds(events)
  if (startSeconds !== undefined) {
    lines.push(
      `pi_flow_run_start_seconds{${labelString({ ref })}} ${startSeconds}`,
    )
  }
  // 9 — per-gate human wait (see the AIDEV-NOTE below the loop).
  // AIDEV-NOTE: pi_flow_gate_wait_seconds is ADDITIVE — one line per
  // 'gate-answer' event, in journal order, appended after every pre-existing
  // series (nothing existing moves). Consumer: the homelab `piflow-runs`
  // board, "Human wait per approve step" table — it wants the wait of an
  // INDIVIDUAL approve step, which pi_flow_human_wait_seconds (total paused
  // time per run) cannot answer.
  // Value = seconds of the paused window THIS gate-answer closed, 0 when it
  // closed none (the answer arrived while the run was still 'running', or the
  // window was already closed by some other event). 0-occurrences are never
  // skipped: n must stay gapless per (ref, gate) so a reject→approve retry
  // reads n=1 then n=2, and the board can honestly show "this approve step
  // blocked nothing". Because label sets must be unique inside one push body,
  // n is part of the identity — two answers with the same (gate, choice) would
  // otherwise collide.
  // RELATIONSHIP to pi_flow_human_wait_seconds: sum(gate waits) <= total human
  // wait. The asymmetry is intentional — a pause closed by a NON-gate-answer
  // event (a note, a running loop-state snapshot, a re-spawned worker) keeps
  // its seconds in the aggregate only, and the gate-answer that eventually
  // arrives for that same step reports 0 rather than double-counting it.
  const occurrences = new Map<string, number>()
  events.forEach((event, index) => {
    if (event.kind !== 'gate-answer') return
    const seen = (occurrences.get(event.gate) ?? 0) + 1
    occurrences.set(event.gate, seen)
    lines.push(
      `pi_flow_gate_wait_seconds{${labelString({
        ref,
        gate: event.gate,
        choice: event.choice,
        n: String(seen),
      })}} ${windows.closedBy.get(index) ?? 0}`,
    )
  })
  // 10+ — the v2 state-machine gauges (flow/state-metrics.ts).
  // AIDEV-NOTE (PMR-ZV9Y 3.2): the v2 blocks are ADDITIVE, the same posture as
  // the block 8 and block 9 notes above — every family is appended AFTER every
  // pre-existing line, in the plan's table order (state, state start, phase,
  // wait, step, step seconds), so nothing existing moves, renames or
  // reorders. That is load-bearing twice over: the live alert rules and the
  // `piflow-*` boards read the v1 series until the 6.5 cutover, and
  // test/run-health.test.ts pins the v1 body byte-for-byte (ISC-A-4).
  // The render is the single shared seam for BOTH push paths — the terminal
  // autopush and the daemon liveness pass call the same buildPushBody →
  // renderRunHealthLines chain (the PMR-8MQH invariant) — which is why the v2
  // math lives in a pure module reached from here rather than session-side.
  // `renderStateMetricLines` returns no lines when nothing derives (no
  // projection, or a projection with neither a v1 loop record nor a v2
  // 'state-change'), so for those journals the body is the v1 body exactly.
  for (const line of renderStateMetricLines(ref, events)) {
    lines.push(line)
  }
  return lines
}

interface PausedWindowScan {
  /** Total paused seconds — the value behind pi_flow_human_wait_seconds. */
  waitSeconds: number
  /**
   * Seconds per CLOSING event index (only for windows that measured a
   * positive finite span), so per-gate callers can ask "which window did
   * THIS event close?". An index that is absent from the map either is not
   * a window closer or closed a window that measured 0 — both render as 0.
   */
  closedBy: Map<number, number>
}

/**
 * Scan the RAW ordered events for paused windows. A window opens at the first
 * paused loop-state snapshot and closes at the next event that is NOT a
 * paused loop-state (consecutive paused snapshots do not restart the clock).
 * An unclosed window contributes nothing.
 *
 * AIDEV-NOTE: single source of truth for BOTH the aggregate
 * pi_flow_human_wait_seconds and the per-gate pi_flow_gate_wait_seconds — the
 * arithmetic here is the arithmetic the frozen aggregate always used
 * (unfloored millisecond math, only positive finite spans summed), so moving
 * it out of renderRunHealthLines could not shift an existing value.
 */
function scanPausedWindows(events: readonly FlowRunEvent[]): PausedWindowScan {
  let openAt: string | null = null
  let waitSeconds = 0
  const closedBy = new Map<number, number>()
  events.forEach((event, index) => {
    let isPausedSnapshot = false
    if (event.kind === 'loop-state' && event.loop.status === 'paused') {
      isPausedSnapshot = true
    }
    if (openAt === null) {
      if (isPausedSnapshot) openAt = event.at
      return
    }
    if (isPausedSnapshot) return
    const seconds = (Date.parse(event.at) - Date.parse(openAt)) / 1000
    if (Number.isFinite(seconds) && seconds > 0) {
      waitSeconds += seconds
      closedBy.set(index, seconds)
    }
    openAt = null
  })
  return { waitSeconds, closedBy }
}
