// AIDEV-NOTE: run-lifecycle health metrics for the Pushgateway push body.
// These series are JOURNAL-PROJECTION-ONLY: every value is derived from the
// run journal events (projectRunState + raw event scans), never from session
// jsonl files — so they appear even when session coverage gaps exist, and
// they keep working if cost attribution changes shape. Dashboards
// `piflow-health/runs` consume these exact metric names/labels (frozen —
// renaming a metric or label is a dashboard-breaking change).
// AIDEV-NOTE (PMR-ZV9Y 7.1): the FROZEN SET below is now — after the v1
// state-vocabulary retirement — {gate decisions, retry attempts, blocker
// retries, worktree sweep, run start}, followed by the v2 state-machine
// gauges. The four v1 state-vocabulary lines `pi_flow_run_status`,
// `pi_flow_run_halt_reason`, `pi_flow_human_wait_seconds` and
// `pi_flow_gate_wait_seconds` were retired here (their blocks and the
// scanPausedWindows path that fed them are gone) because phases 6.2–6.5 cut
// every dashboard and alert rule over to the v2 state vocabulary
// (`pi_flow_state` …, rendered by flow/state-metrics.ts). The halt reason is
// now ONLY the closed v2 reason enum on `pi_flow_state`/`pi_flow_wait_seconds`
// — the free-text halt-note derivation that block 2 used to scrape onto a
// label value is deleted (plan gotcha 8). Nothing outside the frozen set may
// move, rename or reorder; the v2 blocks are appended after the frozen block
// in the plan's table order (see the append site below).
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
// AIDEV-NOTE (PMR-ZV9Y 7.1): this cutover has now LANDED — the four v1
// state-vocabulary blocks are removed and the v2 gauges above are the only
// state vocabulary this module renders. See the header 7.1 note for the new
// frozen set; the FROZEN-UNTIL-CUTOVER framing above is kept as history.
// AIDEV-NOTE (PMR-9DZ0 2.1): the run-title block below is an ADDITIVE
// AMENDMENT to that frozen shape, not a change to it: `pi_flow_run_title_info`
// is a new family appended AFTER the frozen set and AFTER the v2 state
// families (block 7), so nothing existing moved, renamed or reordered and the
// frozen-prefix pins stay byte-for-byte. It is journal-derived only (the LAST
// run-start carrying a title wins), renders through the existing
// labelString/escapeLabelValue seam above, and adds NO import — the node-only
// closure guarded by test/cost-rows-node-only.test.ts is untouched. Dashboards
// join it as `* on (ref) group_left (title)`. flow/push.ts prunes this family
// from re-posted group bodies. That prune only ever runs on a DEAD run (it is
// reachable only through fetchGroupBody → the reconcile tombstone, which fires
// once a state line flips to `stale`), and its real effect is NOT to protect
// the join: under OFFICIAL Pushgateway REPLACE semantics omitting the line
// DELETES the run's CURRENT title on tombstone — cost/history panels lose their
// `group_left (title)` join and fall back to the bare ref — while on the
// homelab gateway, which MERGES on write (PMR-WBC2), omitting the line cannot
// delete an already-stored series, so it is a NO-OP and a title change can
// leave the old series served until a fresh push overwrites it or it is removed
// by hand (accepted residual; see the push.ts PMR-9DZ0 2.2 / PMR-2CPZ note).
// The drop is kept anyway as the conservative choice: a retired run has no live
// title to advertise under replace semantics, and under merge it costs nothing.
import type { FlowRunEvent } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import { labelString } from './cost-rows.ts'
import { renderStateMetricLines } from './state-metrics.ts'

// `at` is a raw journal string (readRunEvents casts JSON.parse output), so an
// unparseable timestamp is possible in practice: treat it as "absent" instead
// of letting NaN reach the exposition body. (The retired v1 wait windows kept
// their own unfloored millisecond math — flooring there would have changed
// existing values; the surviving v2 window math lives in
// flow/state-metrics.ts.)
function epochSeconds(at: string): number | undefined {
  const seconds = Math.floor(Date.parse(at) / 1000)
  if (!Number.isFinite(seconds)) return undefined
  return seconds
}

// AIDEV-NOTE: pi_flow_run_start_seconds is ADDITIVE — it joined the frozen
// series without renaming or reordering any existing line.
// AIDEV-NOTE (PMR-ZV9Y 7.1): this note said "it is no longer literally the last
// line" because the additive pi_flow_gate_wait_seconds series followed it; that
// series is retired, so run start is the last line of the frozen set again and
// only the v2 state gauges come after it.
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

// AIDEV-NOTE (PMR-9DZ0 2.1): pi_flow_run_title_info is derived from the LAST
// run-start carrying a title — deliberately the OPPOSITE of runStartSeconds'
// first-wins rule. A resume re-journals run-start with a fresh ticket title,
// and the newest title is the one the dashboard should show; a resume whose
// lookup failed journals no `title` key at all, so title-less run-start events
// are skipped rather than clearing an earlier title. Sanitized at journal-write
// time by run-title.ts (single line, capped, control chars stripped), so the
// render only needs the exposition escaping that labelString already applies.
// An empty title never reaches the render: the writer omits the key, and an
// empty-title series would fan out the dashboard group_left(title) join.
function runTitle(events: readonly FlowRunEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    if (event.kind !== 'run-start') continue
    if (event.title === undefined || event.title === '') continue
    title = event.title
  }
  return title
}

/**
 * Render the Prometheus exposition lines for run health (gate decision counts,
 * retry/blocker counters, worktree-sweep counts, run start epoch seconds,
 * then the v2 state-machine gauges, then the additive run-title tail block).
 * Pure: same journal events in, same lines out. Metric order is fixed; within a
 * grouped metric lines follow first-seen event order so pushes stay byte-stable
 * for the Pushgateway group. The FROZEN block (gate decisions … run start)
 * never moves; the v2 state gauges are appended after it (see the append site
 * below), and the title block after those (see the header PMR-9DZ0 note).
 *
 * AIDEV-NOTE (PMR-ZV9Y 7.1): the v1 state-vocabulary lines this used to render
 * (`pi_flow_run_status`, `pi_flow_run_halt_reason`, `pi_flow_human_wait_seconds`,
 * `pi_flow_gate_wait_seconds`) are retired — the v2 `pi_flow_state` /
 * `pi_flow_state_start_seconds` / `pi_flow_wait_seconds` families in
 * flow/state-metrics.ts supersede them, and every dashboard/alert consumer was
 * cut over in 6.2–6.5. The paused-window scan that fed the two wait lines is
 * gone with them (flow/state-metrics.ts keeps its own mirror for the ISC-6
 * legacy fallback).
 */
export function renderRunHealthLines(
  ref: string,
  events: readonly FlowRunEvent[],
): string[] {
  const state = projectRunState(events)
  if (state === null) return []
  const lines: string[] = []
  // 1 — gate decisions: RAW gate-answer events grouped by (gate, choice).
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
  // 2 — retry attempts (flow_run_attempt budget; 'passed' resets to 0).
  let attempts = 0
  if (state.attempts !== undefined) attempts = state.attempts
  lines.push(`pi_flow_retry_attempts{${labelString({ ref })}} ${attempts}`)
  // 3 — blocker retries from the loop record.
  let blockerRetries = 0
  if (state.loop !== undefined) blockerRetries = state.loop.blockerRetries
  lines.push(
    `pi_flow_blocker_retries{${labelString({ ref })}} ${blockerRetries}`,
  )
  // 4 — worktree sweep outcomes (evidence-only in the projection, so the
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
  // 5 — run start epoch seconds (see the AIDEV-NOTE above runStartSeconds).
  // AIDEV-NOTE (PMR-ZV9Y 7.1): this was additive block 8; the retirement of
  // blocks 1+2, 4 and 9 moved it to the tail of the frozen set, which is now
  // {gate decisions, retry attempts, blocker retries, worktree sweep, run
  // start}. Its position relative to every kept line is unchanged.
  const startSeconds = runStartSeconds(events)
  if (startSeconds !== undefined) {
    lines.push(
      `pi_flow_run_start_seconds{${labelString({ ref })}} ${startSeconds}`,
    )
  }
  // 6+ — the v2 state-machine gauges (flow/state-metrics.ts), the successor of
  // the v1 state vocabulary retired above.
  // AIDEV-NOTE (PMR-ZV9Y 3.2): the v2 blocks were ADDITIVE when they landed —
  // every family was appended AFTER every pre-existing line, in the plan's
  // table order (state, state start, phase, wait, step, step seconds), so
  // nothing existing moved, renamed or reordered while the live alert rules and
  // the `piflow-*` boards still read the v1 series.
  // AIDEV-NOTE (PMR-ZV9Y 7.1): with the v1 state-vocabulary lines now retired,
  // that table order IS the state-vocabulary order; the families after the
  // frozen set are frozen too (see the header 7.1 note).
  // The render is the single shared seam for BOTH push paths — the terminal
  // autopush and the daemon liveness pass call the same buildPushBody →
  // renderRunHealthLines chain (the PMR-8MQH invariant) — which is why the v2
  // math lives in a pure module reached from here rather than session-side.
  // `renderStateMetricLines` returns no lines when nothing derives (no
  // projection, or a projection with neither a v1 loop record nor a v2
  // 'state-change'), so for those journals it contributes nothing.
  for (const line of renderStateMetricLines(ref, events)) {
    lines.push(line)
  }
  // 7 — run title info (PMR-9DZ0). ADDITIVE TAIL BLOCK appended AFTER the v2
  // state families; the frozen set and the v2 families are untouched — see the
  // header amendment note. Journal-derived only: LAST run-start with a title wins.
  // One series per ref; dashboards join `* on (ref) group_left (title)` with an
  // `or … unless on (ref)` fallback so title-less runs stay visible.
  const title = runTitle(events)
  if (title !== undefined) {
    lines.push(`pi_flow_run_title_info{${labelString({ ref, title })}} 1`)
  }
  return lines
}
