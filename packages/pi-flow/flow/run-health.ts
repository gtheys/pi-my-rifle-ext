// AIDEV-NOTE: run-lifecycle health metrics for the Pushgateway push body.
// These series are JOURNAL-PROJECTION-ONLY: every value is derived from the
// run journal events (projectRunState + raw event scans), never from session
// jsonl files — so they appear even when session coverage gaps exist, and
// they keep working if cost attribution changes shape. Dashboards
// `piflow-health/runs` consume these exact metric names/labels (frozen —
// renaming a metric or label is a dashboard-breaking change).
import type { FlowRunEvent } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import { labelString } from './cost.ts'

/**
 * Render the Prometheus exposition lines for run health (status gauge, halt
 * reason, gate decision counts, human wait seconds, retry/blocker counters,
 * worktree-sweep counts). Pure: same journal events in, same lines out.
 * Metric order is fixed; within a grouped metric lines follow first-seen
 * event order so pushes stay byte-stable for the Pushgateway group.
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
  // 4 — human wait: paused windows scanned over the RAW ordered events.
  // A window opens at the first paused loop-state and closes at the next
  // event that is NOT a paused loop-state (consecutive paused snapshots do
  // not restart the clock). An unclosed window contributes nothing.
  let openAt: string | null = null
  let waitSeconds = 0
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
    const seconds = (Date.parse(event.at) - Date.parse(openAt)) / 1000
    if (Number.isFinite(seconds) && seconds > 0) waitSeconds += seconds
    openAt = null
  }
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
  return lines
}
