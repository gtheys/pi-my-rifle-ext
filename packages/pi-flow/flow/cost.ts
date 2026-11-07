// AIDEV-NOTE (PMR-EA8X): offline ground-truth cost rollup for flow runs.
// The session jsonl files stay the authority — this module only aggregates
// what Pi already recorded. COVERAGE DISCIPLINE (same rule as usage.ts):
// when a session's usage is unavailable (unreadable file, no usage blocks,
// no resolvable session path) the row carries a coverage flag, never an
// invented zero. Attribution rule: cost follows the assignment recorded at
// spawn time (subtask from the note, else the durable assignment record);
// a takeover (resume/reattach) re-attributes the session to whoever now
// owns the work, matching the journal's reassignment notes.

import type {
  AssignmentRecord,
  UsageSummary,
} from '@gtheys/pi-interactive-subagents'
import {
  createUsageSummary,
  summarizeEntriesUsage,
  totalTokens,
} from '@gtheys/pi-interactive-subagents'
import type { FlowPhase, FlowRunEvent } from '../run-state.ts'

/** One parsed attribution note from the run journal. */
export interface SpawnNote {
  childId: string
  name: string
  kind: 'spawn' | 'resume' | 'reattach'
  subtask: string | null
  sessionFile: string | null
  at: string
  /** Phase active when the spawn happened (null = between phases). */
  phase: FlowPhase | null
}

/** Per-worker cost row. `sessionAvailable=false` means a coverage gap. */
export interface WorkerRow {
  childId: string
  name: string
  subtask: string | null
  phase: FlowPhase | null
  sessionFile: string | null
  summary: UsageSummary
  sessionAvailable: boolean
  toolCalls: ToolCallCount[]
}

export interface ToolCallCount {
  tool: string
  status: 'ok' | 'error'
  count: number
}

export interface PhaseDuration {
  phase: FlowPhase
  /** Seconds from phase-start to phase-complete (or the last journal event). */
  seconds: number
}

const SPAWN_NOTE_RE =
  /^subagent (\S+) \("([^"]*)"\) (spawn|resume|reattach)(?: for subtask (\S+))? — attribution env stamped(?:, session="([^"]*)")?$/

/** Parse one journal note text into a SpawnNote (null when not a spawn note). */
export function parseSpawnNote(
  text: string,
  phase: FlowPhase | null,
): SpawnNote | null {
  const match = SPAWN_NOTE_RE.exec(text)
  if (match === null) return null
  let subtask: string | null = null
  if (match[4] !== undefined) subtask = match[4]
  let sessionFile: string | null = null
  if (match[5] !== undefined) sessionFile = match[5]
  return {
    childId: match[1],
    name: match[2],
    kind: match[3] as SpawnNote['kind'],
    subtask,
    sessionFile,
    at: '',
    phase,
  }
}

/**
 * Extract spawn notes from ordered journal events, annotating each with the
 * phase that was active at that point in the event stream. Notes written
 * before the first phase-start (or between phases) get null.
 */
export function collectSpawnNotes(
  events: readonly FlowRunEvent[],
): SpawnNote[] {
  const notes: SpawnNote[] = []
  let phase: FlowPhase | null = null
  for (const event of events) {
    if (event.kind === 'run-start') {
      phase = null
      continue
    }
    if (event.kind === 'phase-start') {
      phase = event.phase
      continue
    }
    if (event.kind === 'phase-complete') {
      phase = null
      continue
    }
    if (event.kind === 'note') {
      const note = parseSpawnNote(event.text, phase)
      if (note !== null) {
        note.at = event.at
        notes.push(note)
      }
    }
  }
  return notes
}

/** Parse a session jsonl file body into entries (torn tail lines skipped). */
export function parseSessionEntries(text: string): unknown[] {
  const entries: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // torn tail line — skip
    }
  }
  return entries
}

/** Count toolResult entries per tool/status (session-jsonl shape). Pure. */
export function countToolCalls(entries: readonly unknown[]): ToolCallCount[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'message') continue
    const message = e.message
    if (message == null || typeof message !== 'object') continue
    const m = message as Record<string, unknown>
    if (m.role !== 'toolResult') continue
    let tool = 'unknown'
    if (typeof m.toolName === 'string' && m.toolName.length > 0) {
      tool = m.toolName
    }
    const status: 'ok' | 'error' = m.isError === true ? 'error' : 'ok'
    const key = `${status}\u0000${tool}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: ToolCallCount[] = []
  for (const [key, count] of counts) {
    const separator = key.indexOf('\u0000')
    out.push({
      status: key.slice(0, separator) as 'ok' | 'error',
      tool: key.slice(separator + 1),
      count,
    })
  }
  out.sort((a, b) => {
    if (a.tool !== b.tool) return a.tool.localeCompare(b.tool)
    if (a.status !== b.status) return a.status.localeCompare(b.status)
    return 0
  })
  return out
}

/**
 * Build one row per unique session file. Dedup rule: a file referenced by
 * several notes (spawn then resume/reattach takeover) is attributed to the
 * LAST note — cost follows whoever actually owns the work now. Notes with
 * no resolvable session path become coverage-gap rows.
 */
export function buildWorkerRows(
  notes: readonly SpawnNote[],
  assignments: readonly AssignmentRecord[],
  sessions: ReadonlyMap<string, readonly unknown[]>,
): WorkerRow[] {
  const assignmentByChild = new Map<string, AssignmentRecord>()
  for (const record of assignments) {
    assignmentByChild.set(record.childId, record)
  }
  // Keyed by session file; null-session notes get synthetic unique keys.
  const byFile = new Map<string, SpawnNote>()
  let nullKeySeq = 0
  for (const note of notes) {
    let file = note.sessionFile
    if (file === null) {
      const record = assignmentByChild.get(note.childId)
      if (record !== undefined && record.sessionFile.length > 0) {
        file = record.sessionFile
      }
    }
    let key: string
    if (file === null) {
      key = `\u0000null-${nullKeySeq}`
      nullKeySeq += 1
    } else {
      key = file
    }
    byFile.set(key, { ...note, sessionFile: file })
  }
  const rows: WorkerRow[] = []
  for (const note of byFile.values()) {
    let subtask = note.subtask
    if (subtask === null) {
      const record = assignmentByChild.get(note.childId)
      if (record !== undefined && record.subtask !== undefined) {
        subtask = record.subtask
      }
    }
    let summary = createUsageSummary()
    let toolCalls: ToolCallCount[] = []
    let sessionAvailable = false
    if (note.sessionFile !== null) {
      const entries = sessions.get(note.sessionFile)
      if (entries !== undefined) {
        summary = summarizeEntriesUsage(entries)
        toolCalls = countToolCalls(entries)
        sessionAvailable = true
      }
    }
    rows.push({
      childId: note.childId,
      name: note.name,
      subtask,
      phase: note.phase,
      sessionFile: note.sessionFile,
      summary,
      sessionAvailable,
      toolCalls,
    })
  }
  rows.sort((a, b) => {
    if (a.phase !== b.phase) {
      if (a.phase === null) return 1
      if (b.phase === null) return -1
      return a.phase.localeCompare(b.phase)
    }
    return a.name.localeCompare(b.name)
  })
  return rows
}

/** Per-phase wall-clock durations from journal events. Pure. */
export function phaseDurations(
  events: readonly FlowRunEvent[],
): PhaseDuration[] {
  const lastAt = events.length > 0 ? events[events.length - 1].at : null
  const out = new Map<FlowPhase, number>()
  const startAt = new Map<FlowPhase, string>()
  for (const event of events) {
    if (event.kind === 'phase-start') {
      startAt.set(event.phase, event.at)
    } else if (event.kind === 'phase-complete') {
      const started = startAt.get(event.phase)
      if (started !== undefined) {
        const seconds = (Date.parse(event.at) - Date.parse(started)) / 1000
        if (Number.isFinite(seconds) && seconds >= 0) {
          out.set(event.phase, (out.get(event.phase) ?? 0) + seconds)
        }
        startAt.delete(event.phase)
      }
    }
  }
  // still-open phases run to the last journal event we have
  if (lastAt !== null) {
    for (const [phase, started] of startAt) {
      const seconds = (Date.parse(lastAt) - Date.parse(started)) / 1000
      if (Number.isFinite(seconds) && seconds >= 0) {
        out.set(phase, (out.get(phase) ?? 0) + seconds)
      }
    }
  }
  const durations: PhaseDuration[] = []
  for (const [phase, seconds] of out) {
    durations.push({ phase, seconds })
  }
  durations.sort((a, b) => a.phase.localeCompare(b.phase))
  return durations
}

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
  return lines.join('\n')
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labelString(labels: Record<string, string>): string {
  const parts: string[] = []
  for (const key of Object.keys(labels)) {
    parts.push(`${key}="${escapeLabelValue(labels[key])}"`)
  }
  return parts.join(',')
}

/**
 * Render the Prometheus text exposition for the Pushgateway (PMR-EA8X
 * `--push`). Only sessions that actually reported usage contribute — a
 * coverage gap contributes nothing rather than an invented zero.
 */
export function buildPushBody(
  ref: string,
  rows: readonly WorkerRow[],
  durations: readonly PhaseDuration[],
): string {
  const lines: string[] = []
  for (const row of rows) {
    if (!row.summary.sawUsage) continue
    let phase = ''
    if (row.phase !== null) phase = row.phase
    let subtask = ''
    if (row.subtask !== null) subtask = row.subtask
    lines.push(
      `pi_flow_run_cost_usd{${labelString({ ref, phase, agent: row.name, subtask })}} ${row.summary.totals.cost}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'input' })}} ${row.summary.totals.input}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'output' })}} ${row.summary.totals.output}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'cacheRead' })}} ${row.summary.totals.cacheRead}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'cacheWrite' })}} ${row.summary.totals.cacheWrite}`,
    )
    for (const call of row.toolCalls) {
      lines.push(
        `pi_flow_tool_calls_total{${labelString({
          ref,
          phase,
          agent: row.name,
          tool: call.tool,
          status: call.status,
        })}} ${call.count}`,
      )
    }
  }
  for (const duration of durations) {
    lines.push(
      `pi_flow_run_duration_seconds{${labelString({ ref, phase: duration.phase })}} ${duration.seconds}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export interface PushResult {
  ok: boolean
  /** Present only when ok=false — the caller shows a warning, never fails. */
  error?: string
}

export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; statusText: string }>

/**
 * Push the exposition body to a Pushgateway. Grouping keys put ref in the
 * URL path so separate runs keep separate metric groups; the bearer token
 * (when configured) rides the Authorization header. Failures return
 * {ok:false} — /flow-cost treats them as warnings, never fatal.
 */
export async function pushToGateway(
  url: string,
  ref: string,
  body: string,
  fetchImpl: PushFetch,
  token?: string,
): Promise<PushResult> {
  const base = url.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'content-type': 'text/plain',
  }
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`
  }
  try {
    const response = await fetchImpl(
      `${base}/metrics/job/pi-flow/ref/${encodeURIComponent(ref)}`,
      { method: 'POST', headers, body },
    )
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: `pushgateway responded ${response.status} ${response.statusText}`,
      }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    return { ok: false, error: message }
  }
}
