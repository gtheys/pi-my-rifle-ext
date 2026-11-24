// AIDEV-NOTE (PMR-EA8X): the human cost report for flow runs. The node-only
// rollup and the Pushgateway body builder moved to flow/cost-rows.ts in
// PMR-8MQH 1.2 (daemon reachability); everything moved is re-exported below,
// so existing importers (index.ts, flow/cost-command.ts, flow/cost-autopush.ts,
// flow-diagram/*, adhoc/tracker.ts, test/*) resolve the same symbols unchanged.
// What stays HERE is the session-side report path: it is the only place that
// imports the package ROOT for `totalTokens`, which is why the daemon contract
// forbids reaching this file (server/daemon.ts:15-18). See cost-rows.ts for
// the node-only contract — the moved half does not import back here (its
// run-health seam takes `labelString` from cost-rows.ts), so nothing in the
// daemon's closure reaches this file.

import { totalTokens } from '@gtheys/pi-interactive-subagents'
import type { PhaseDuration, PhaseStepSummary, WorkerRow } from './cost-rows.ts'

function groupThousands(value: number): string {
  const rounded = Math.round(value)
  const digits = `${Math.abs(rounded)}`
  let grouped = ''
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ','
    grouped += digits[i]
  }
  let sign = ''
  if (rounded < 0) sign = '-'
  return `${sign}${grouped}`
}

function padCell(value: string, width: number): string {
  let padded = value
  while (padded.length < width) padded += ' '
  return padded
}

/**
 * Render the human report: per-worker table, per-phase subtotals, run
 * total, and coverage-gap flags. Pure string building.
 */
export function formatCostReport(
  ref: string,
  rows: readonly WorkerRow[],
  durations: readonly PhaseDuration[],
  steps: readonly PhaseStepSummary[] = [],
): string {
  const header = ['worker', 'subtask', 'phase', 'tokens', 'cost', 'coverage']
  const table: string[][] = []
  for (const row of rows) {
    let subtaskCell = '-'
    if (row.subtask !== null) subtaskCell = row.subtask
    let phaseCell = '-'
    if (row.phase !== null) phaseCell = row.phase
    let tokensCell = '-'
    let costCell = '-'
    if (row.sessionAvailable) {
      tokensCell = groupThousands(totalTokens(row.summary.totals))
      costCell = `$${row.summary.totals.cost.toFixed(4)}`
    }
    let coverage = 'ok'
    if (!row.sessionAvailable) coverage = 'NO SESSION'
    else if (!row.summary.sawUsage) coverage = 'NO USAGE DATA'
    table.push([
      row.name,
      subtaskCell,
      phaseCell,
      tokensCell,
      costCell,
      coverage,
    ])
  }
  const widths = header.map((cell, index) => {
    let width = cell.length
    for (const row of table) {
      width = Math.max(width, row[index].length)
    }
    return width
  })
  const lines: string[] = []
  lines.push(`flow-cost ${ref} — ${rows.length} worker session(s)`)
  lines.push(
    header
      .map((cell, i) => padCell(cell, widths[i]))
      .join('  ')
      .trimEnd(),
  )
  for (const row of table) {
    lines.push(
      row
        .map((cell, i) => padCell(cell, widths[i]))
        .join('  ')
        .trimEnd(),
    )
  }
  // run total counts only rows that actually carried usage — never zeros
  let totalTokensSum = 0
  let totalCost = 0
  let coveredRows = 0
  for (const row of rows) {
    if (row.summary.sawUsage) {
      totalTokensSum += totalTokens(row.summary.totals)
      totalCost += row.summary.totals.cost
      coveredRows += 1
    }
  }
  let coverageNote = 'no session reported usage'
  if (coveredRows > 0) {
    coverageNote = `${coveredRows}/${rows.length} session(s) reported usage`
  }
  lines.push(
    `TOTAL ${groupThousands(totalTokensSum)} tokens  $${totalCost.toFixed(4)}  (${coverageNote})`,
  )
  if (durations.length > 0) {
    lines.push('phase durations (journal wall-clock):')
    for (const duration of durations) {
      lines.push(`  ${duration.phase}: ${duration.seconds.toFixed(0)}s`)
    }
  }
  if (steps.length > 0) {
    lines.push('step outputs (advisory, never blocking):')
    for (const step of steps) {
      lines.push(
        `  ${step.phase}: ${step.total} step output(s) (${step.ok} ok, ${step.failed} failed)`,
      )
    }
  }
  return lines.join('\n')
}

// AIDEV-NOTE (PMR-8MQH 1.2): the row/body half of the rollup + push-body
// code lives in flow/cost-rows.ts (node-only by its own import list — see its
// header for the import contract; its closure-edge AIDEV-QUESTION is
// RESOLVED and recorded there: run-health.ts now imports `labelString` from
// cost-rows.ts, so no session-side package-ROOT edge remains in the daemon's
// closure). Re-exported here so every existing importer keeps working
// unchanged; nothing was edited on the importing side.
// AIDEV-NOTE (PMR-8MQH 1.3): `computeCostRollup` + `CostRollup` /
// `CostRollupDeps` ALSO live in flow/cost-rows.ts (moved out of
// flow/cost-command.ts), but they are deliberately re-exported from THERE,
// not from this file — `flow/cost-autopush.ts` keeps its `./cost-command.ts`
// import, and this file stays off the daemon's allowlist because of the ROOT
// `totalTokens` import above.
export {
  buildMainRows,
  buildPushBody,
  buildWorkerRows,
  collectMainSessionFiles,
  collectSpawnNotes,
  countToolCalls,
  escapeLabelValue,
  labelString,
  type PhaseDuration,
  type PhaseStepSummary,
  type PhaseWindow,
  parseSessionEntries,
  parseSpawnNote,
  phaseDurations,
  phaseWindows,
  type SpawnNote,
  summarizeStepOutputs,
  type ToolCallCount,
  type WorkerRow,
} from './cost-rows.ts'

// AIDEV-NOTE (PMR-XR43 1.1): the Pushgateway transport lives in flow/push.ts
// (node-only, daemon-reachable — see its header for the import contract). It is
// re-exported here so existing importers (index.ts, flow/cost-command.ts,
// test/cost.test.ts, test/work-mode-tracking.test.ts) keep working unchanged.
export {
  groupSuffix,
  type PushFetch,
  type PushResult,
  pushToGateway,
} from './push.ts'
