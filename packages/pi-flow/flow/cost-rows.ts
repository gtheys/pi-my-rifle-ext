// AIDEV-NOTE (PMR-8MQH 1.2): node-only cost-row rollup for flow runs, moved
// out of flow/cost.ts so the daemon (server/daemon.ts) and flow/reconcile.ts
// can reach the rollup and the Pushgateway body builder. MODULE CONTRACT —
// three properties, all load-bearing:
//   1. NODE-ONLY. This file may import ONLY node built-ins, '../run-state.ts'
//      (types), './agent-role.ts', './run-health.ts', './push.ts',
//      './reconcile-deps.ts', and the package subpaths
//      '@gtheys/pi-interactive-subagents/usage' and '/assignments' — NEVER the
//      package root, and never '@earendil-works/pi-coding-agent' (no pi
//      extension runtime in the daemon process). Locked textually by
//      test/cost-rows-node-only.test.ts; the daemon dependency contract is
//      server/daemon.ts:8-19.
//   2. DAEMON-REACHABLE. Nothing here touches fs, env, timers, or the network.
//      Every function is a pure projection of its arguments, so the daemon can
//      rebuild identical rows/bodies from a journal dump without the pi
//      runtime that produced them.
//      AIDEV-NOTE (PMR-8MQH 1.2, RESOLVED): this property originally held for
//      THIS file's own imports but not for its transitive closure: run-health
//      imported labelString from './cost.ts', and cost.ts value-imports the
//      package ROOT, so the real graph was cost-rows.ts -> run-health.ts ->
//      cost.ts -> ROOT (proven by tracing `module.registerHooks` resolve
//      parents while bare-node importing this file, not inferred). Decision
//      (flow human, subtask 1.2): repoint run-health.ts at './cost-rows.ts',
//      where labelString now lives — the ROOT drops out of the closure and the
//      old cost.ts <-> run-health.ts cycle is gone (the remaining
//      cost-rows <-> run-health seam is a pure function-declaration cycle,
//      ESM-safe, both sides daemon-allowed). The closure guard in
//      test/cost-rows-node-only.test.ts locks it so a re-introduced
//      './cost.ts' or './cost-command.ts' edge fails in CI.
//   3. BYTE-STABLE BODY (ISC-7 of PMR-V36Y). buildPushBody's output is a
//      consumed Prometheus exposition: the homelab dashboards key on the exact
//      metric names, label sets, and line ORDER. Changing a moved body here is
//      a dashboard-breaking change, so the moved code is character-for-character
//      what flow/cost.ts used to hold, and flow/cost.ts re-exports it so every
//      existing importer keeps resolving the same functions.
//
// AIDEV-NOTE (PMR-8MQH 1.3): computeCostRollup + the CostRollup type moved
// here from flow/cost-command.ts so the daemon can reach the rollup too, and
// cost-command.ts re-exports them (no caller changed). Its dependencies are
// narrowed to CostRollupDeps (journal + assignments + session files) instead
// of Pick<FlowCostDeps, ...> — the push member stays session-side.
//
// AIDEV-NOTE (PMR-EA8X): offline ground-truth cost rollup for flow runs.
// The session jsonl files stay the authority — this module only aggregates
// what Pi already recorded. COVERAGE DISCIPLINE (same rule as usage.ts):
// when a session's usage is unavailable (unreadable file, no usage blocks,
// no resolvable session path) the row carries a coverage flag, never an
// invented zero. Attribution rule: cost follows the assignment recorded at
// spawn time (subtask from the note, else the durable assignment record);
// a takeover (resume/reattach) re-attributes the session to whoever now
// owns the work, matching the journal's reassignment notes.

import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents/assignments'
import {
  createUsageSummary,
  summarizeEntriesUsage,
  type UsageSummary,
} from '@gtheys/pi-interactive-subagents/usage'
import type { FlowPhase, FlowRunEvent } from '../run-state.ts'
import { runTracking } from '../run-state.ts'
import { agentRole, ORCHESTRATOR_ROLE } from './agent-role.ts'
import { renderRunHealthLines } from './run-health.ts'

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
  /** groupable role (agent type, else name prefix); see flow/agent-role.ts */
  role?: string
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

// AIDEV-NOTE: legacy reader only — writer retired note emission in PMR-C998;
// do not re-add. Kept so old note-only journals still parse.
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
    if (event.kind === 'spawn-record') {
      let subtask: string | null = null
      if (event.subtask !== undefined) subtask = event.subtask
      let sessionFile: string | null = null
      if (event.sessionFile !== undefined) sessionFile = event.sessionFile
      notes.push({
        childId: event.childId,
        name: event.name,
        kind: event.spawnKind,
        subtask,
        sessionFile,
        at: event.at,
        phase,
      })
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
    const record = assignmentByChild.get(note.childId)
    rows.push({
      childId: note.childId,
      name: note.name,
      role: agentRole(record?.agent, note.name),
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

/** Distinct main-session files journaled for a run, in first-seen order. */
export function collectMainSessionFiles(
  events: readonly FlowRunEvent[],
): string[] {
  const files: string[] = []
  for (const event of events) {
    if (event.kind !== 'main-session') continue
    if (!files.includes(event.sessionFile)) files.push(event.sessionFile)
  }
  return files
}

export interface PhaseWindow {
  phase: FlowPhase
  startMs: number
  /** exclusive */
  endMs: number
}

/**
 * Phase time windows from the journal. A phase runs from its phase-start
 * until the NEXT phase-start (so the model's reply right after
 * flow_phase_complete still counts for the phase it finished); the last
 * phase ends at its phase-complete, else at the last journal event.
 * Repeated phase-starts for one phase (route-back) yield several windows.
 */
export function phaseWindows(events: readonly FlowRunEvent[]): PhaseWindow[] {
  const starts: Array<{ phase: FlowPhase; ms: number }> = []
  for (const event of events) {
    if (event.kind !== 'phase-start') continue
    const ms = Date.parse(event.at)
    if (Number.isFinite(ms)) starts.push({ phase: event.phase, ms })
  }
  if (starts.length === 0) return []
  let lastMs = starts[starts.length - 1].ms
  const last = starts[starts.length - 1]
  for (const event of events) {
    const ms = Date.parse(event.at)
    if (!Number.isFinite(ms) || ms < last.ms) continue
    if (event.kind === 'phase-complete' && event.phase === last.phase) {
      lastMs = ms
      break
    }
    if (ms > lastMs) lastMs = ms
  }
  const windows: PhaseWindow[] = []
  for (let i = 0; i < starts.length; i += 1) {
    let endMs = lastMs
    if (i + 1 < starts.length) endMs = starts[i + 1].ms
    windows.push({ phase: starts[i].phase, startMs: starts[i].ms, endMs })
  }
  return windows
}

function entryTimeMs(entry: unknown): number | null {
  if (entry == null || typeof entry !== 'object') return null
  const raw = (entry as Record<string, unknown>).timestamp
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return ms
}

/**
 * Cost rows for the MAIN pi session(s): each session file's entries are split
 * across the journal's phase windows by entry timestamp, one row per
 * (session file, phase). Before this existed the rollup only counted spawned
 * workers, so plan/implement (which run in the main session) had no cost at
 * all. Rows are named "main" and carry no subtask. An unreadable session file
 * yields ONE coverage-gap row (sessionAvailable=false), never an invented
 * zero. Entries outside every window (chat before/after the flow) are
 * ignored.
 */
export function buildMainRows(
  events: readonly FlowRunEvent[],
  sessions: ReadonlyMap<string, readonly unknown[]>,
): WorkerRow[] {
  const files = collectMainSessionFiles(events)
  const windows = phaseWindows(events)
  const rows: WorkerRow[] = []
  for (const file of files) {
    const childId = `main-${sessionFileId(file)}`
    const entries = sessions.get(file)
    if (entries === undefined) {
      rows.push({
        childId,
        name: 'main',
        role: ORCHESTRATOR_ROLE,
        subtask: null,
        phase: null,
        sessionFile: file,
        summary: createUsageSummary(),
        sessionAvailable: false,
        toolCalls: [],
      })
      continue
    }
    const byPhase = new Map<FlowPhase, unknown[]>()
    for (const entry of entries) {
      const ms = entryTimeMs(entry)
      if (ms === null) continue
      const window = windows.find((w) => ms >= w.startMs && ms < w.endMs)
      if (window === undefined) continue
      const list = byPhase.get(window.phase) ?? []
      list.push(entry)
      byPhase.set(window.phase, list)
    }
    for (const [phase, phaseEntries] of byPhase) {
      const summary = summarizeEntriesUsage(phaseEntries)
      if (!summary.sawUsage) continue
      rows.push({
        childId,
        name: 'main',
        role: ORCHESTRATOR_ROLE,
        subtask: null,
        phase,
        sessionFile: file,
        summary,
        sessionAvailable: true,
        toolCalls: countToolCalls(phaseEntries),
      })
    }
  }
  rows.sort((a, b) => {
    if (a.phase !== b.phase) {
      if (a.phase === null) return 1
      if (b.phase === null) return -1
      return a.phase.localeCompare(b.phase)
    }
    return a.childId.localeCompare(b.childId)
  })
  return rows
}

/** Short stable id for a session file (basename without extension, last uuid part). */
function sessionFileId(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '')
  const underscore = base.lastIndexOf('_')
  let id = base
  if (underscore >= 0) id = base.slice(underscore + 1)
  return id.slice(0, 8)
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

/** Per-phase step-output submission counts (advisory evidence only). */
export interface PhaseStepSummary {
  phase: FlowPhase
  /** All step-output events for the phase (submissions are never deduped). */
  total: number
  /** Submissions with ok === true. */
  ok: number
  /** Submissions with ok === false. */
  failed: number
}

// AIDEV-NOTE (PMR-C998): sums journal 'step-output' submissions per phase.
// Counting is order-insensitive per PMR-5HTN (single pass, unknown kinds are
// ignored by the event union itself). Advisory evidence only — a failed step
// never blocks anything and submissions without `ok` count only in `total`.
export function summarizeStepOutputs(
  events: readonly FlowRunEvent[],
): PhaseStepSummary[] {
  const totals = new Map<FlowPhase, PhaseStepSummary>()
  for (const event of events) {
    if (event.kind !== 'step-output') continue
    const summary = totals.get(event.phase) ?? {
      phase: event.phase,
      total: 0,
      ok: 0,
      failed: 0,
    }
    summary.total += 1
    if (event.ok === true) summary.ok += 1
    if (event.ok === false) summary.failed += 1
    totals.set(event.phase, summary)
  }
  const out: PhaseStepSummary[] = []
  for (const summary of totals.values()) {
    out.push(summary)
  }
  // AIDEV-NOTE (PMR-C998): canonical FlowPhase order (plan, implement,
  // validate, feedback) — NOT alphabetical, so the report reads like the
  // run actually progressed.
  const phaseOrder: FlowPhase[] = ['plan', 'implement', 'validate', 'feedback']
  out.sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase))
  return out
}

// AIDEV-NOTE: exported so flow/run-health.ts reuses the exact escaping
// instead of duplicating it (Prometheus text exposition rules).
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

export function labelString(labels: Record<string, string>): string {
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
 *
 * AIDEV-NOTE: the optional 4th `events` parameter appends the journal-derived
 * run-health lines (flow/run-health.ts) after the cost/duration lines. When
 * omitted the body is byte-identical to the historical output — existing
 * push consumers rely on that.
 */
export function buildPushBody(
  ref: string,
  rows: readonly WorkerRow[],
  durations: readonly PhaseDuration[],
  events?: readonly FlowRunEvent[],
): string {
  const lines: string[] = []
  const roleSeen = new Set<string>()
  for (const row of rows) {
    if (!row.summary.sawUsage) continue
    // AIDEV-NOTE: role rides on its own info series (one per ref+session) so
    // the existing metric label sets stay untouched; dashboards join it with
    // `* on (ref, session) group_left (role) pi_flow_run_role_info`.
    if (!roleSeen.has(row.childId)) {
      roleSeen.add(row.childId)
      lines.push(
        `pi_flow_run_role_info{${labelString({ ref, session: row.childId, role: row.role ?? agentRole(null, row.name) })}} 1`,
      )
    }
    let phase = ''
    if (row.phase !== null) phase = row.phase
    let subtask = ''
    if (row.subtask !== null) subtask = row.subtask
    lines.push(
      `pi_flow_run_cost_usd{${labelString({ ref, phase, agent: row.name, subtask, session: row.childId })}} ${row.summary.totals.cost}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'input', session: row.childId })}} ${row.summary.totals.input}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'output', session: row.childId })}} ${row.summary.totals.output}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'cacheRead', session: row.childId })}} ${row.summary.totals.cacheRead}`,
    )
    lines.push(
      `pi_flow_tokens_total{${labelString({ ref, phase, agent: row.name, kind: 'cacheWrite', session: row.childId })}} ${row.summary.totals.cacheWrite}`,
    )
    for (const call of row.toolCalls) {
      lines.push(
        `pi_flow_tool_calls_total{${labelString({
          ref,
          phase,
          agent: row.name,
          tool: call.tool,
          status: call.status,
          session: row.childId,
        })}} ${call.count}`,
      )
    }
  }
  for (const duration of durations) {
    lines.push(
      `pi_flow_run_duration_seconds{${labelString({ ref, phase: duration.phase })}} ${duration.seconds}`,
    )
  }
  if (events !== undefined) {
    for (const line of renderRunHealthLines(ref, events)) {
      lines.push(line)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * What computeCostRollup reads: the run journal, the durable assignment
 * records, and the raw session jsonl bodies. All reads — the push transport is
 * session-side (flow/cost-command.ts's FlowCostDeps adds it), which is why the
 * rollup takes this narrower interface instead of FlowCostDeps itself.
 */
export interface CostRollupDeps {
  /** Journal events for a ref; null when no journal exists. */
  readRunEvents: (ref: string) => Promise<FlowRunEvent[] | null>
  /** Durable assignment records (subagents data dir). */
  listAssignmentRecords: () => readonly AssignmentRecord[]
  /** Raw session jsonl body, or null when unreadable (coverage gap). */
  readSessionFile: (file: string) => string | null
}

export type CostRollup =
  | { kind: 'no-journal' }
  | { kind: 'empty' }
  | {
      kind: 'ok'
      rows: WorkerRow[]
      durations: PhaseDuration[]
      /** Per-phase step-output submission counts (advisory evidence). */
      steps?: PhaseStepSummary[]
      /** ref the run is tracked by (Jira key in work mode); the metric `ref` label */
      trackRef: string
      mode: 'work' | 'personal'
      /**
       * AIDEV-NOTE: the raw journal events the rollup was computed from —
       * the push call sites forward them to buildPushBody so the run-health
       * metrics ride the same push (optional for back-compat with rollups
       * built by older code or tests).
       */
      events?: readonly FlowRunEvent[]
    }

/**
 * Journal + session files -> cost rows. Shared by `/flow-cost` and the
 * automatic push at run end, so both always agree. 'empty' = the journal has
 * neither worker spawn notes nor a main-session record (pre-attribution run).
 */
export async function computeCostRollup(
  ref: string,
  deps: CostRollupDeps,
): Promise<CostRollup> {
  const events = await deps.readRunEvents(ref)
  if (events === null) return { kind: 'no-journal' }
  const notes = collectSpawnNotes(events)
  const mainFiles = collectMainSessionFiles(events)
  if (notes.length === 0 && mainFiles.length === 0) return { kind: 'empty' }
  const assignments = deps.listAssignmentRecords()
  // read every distinct session file once (coverage gaps become flags)
  const wanted = new Set<string>()
  for (const note of notes) {
    if (note.sessionFile !== null) wanted.add(note.sessionFile)
  }
  for (const file of mainFiles) wanted.add(file)
  const byChild = new Map<string, AssignmentRecord>()
  for (const record of assignments) {
    byChild.set(record.childId, record)
  }
  for (const note of notes) {
    if (note.sessionFile !== null) continue
    const record = byChild.get(note.childId)
    if (record !== undefined && record.sessionFile.length > 0) {
      wanted.add(record.sessionFile)
    }
  }
  const sessions = new Map<string, readonly unknown[]>()
  for (const file of wanted) {
    const raw = deps.readSessionFile(file)
    if (raw === null) continue
    sessions.set(file, parseSessionEntries(raw))
  }
  const rows = [
    ...buildMainRows(events, sessions),
    ...buildWorkerRows(notes, assignments, sessions),
  ]
  // AIDEV-NOTE: work/personal separation — the pushed `ref` label (and the
  // Pushgateway group) is the run's TRACKING ref (Jira key in work mode),
  // from the last run-start event; runs journaled before this existed fall
  // back to the aven ref and personal mode. The derivation itself lives in
  // run-state.ts's runTracking (PMR-MSDJ 1.2) so pushes and the PMR-05MQ
  // tombstone group URL cannot drift apart.
  const { trackRef, mode } = runTracking(events, ref)
  // AIDEV-NOTE (PMR-C998): steps are advisory evidence from journal
  // 'step-output' submissions; optional on the rollup for back-compat and
  // omitted (not empty) so report consumers skip the section cleanly.
  const steps = summarizeStepOutputs(events)
  const okRollup: CostRollup & { steps?: PhaseStepSummary[] } = {
    kind: 'ok' as const,
    rows,
    durations: phaseDurations(events),
    trackRef,
    events,
    mode,
  }
  if (steps.length > 0) okRollup.steps = steps
  return okRollup
}
