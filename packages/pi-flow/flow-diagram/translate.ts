// AIDEV-NOTE (PMR-V3FN 2.1): pure translator core for /flow-diagram.
// Segments the run journal on 'run-start' events and extracts header facts
// for the selected run. Record synthesis (schema-v2 records) lands in 2.2/2.3
// via the synthesizeRecords seam — this module deliberately has NO fs and NO
// Pi runtime imports so it stays unit-testable in isolation.

import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  collectSpawnNotes,
  type PhaseDuration,
  phaseDurations,
} from '../flow/cost.ts'
import type { FlowRunEvent } from '../run-state.ts'

export interface DiagramHeader {
  /** Ref from the segment's run-start event. */
  ref: string
  /** 1-based index of the selected run within the journal. */
  runIndex: number
  /** Total number of run-start events in the journal. */
  runCount: number
  mode: 'work' | 'personal'
  /** Ref the run is tracked by (Jira key in work mode); absent when same as ref. */
  trackRef?: string
  /** Per-phase wall-clock durations (seconds) for the selected segment. */
  phases: PhaseDuration[]
  /** Subtask → commit shas from the segment's subtask-ranges event. */
  commitsBySubtask: Array<{ subtask: string; commits: string[] }>
  unattributed: string[]
  /** PR url from the last step-output in the segment that carries one. */
  prUrl?: string
}

/**
 * AIDEV-NOTE (PMR-V392): token spend in harness-profiler schema-v2 shape.
 * Mapping from pi session `usage` blocks (camelCase): new = input + cacheWrite,
 * cached = cacheRead, out = output; calls = distinct assistant message ids
 * (dedup by entry id). 2.3 reuses this mapping for standalone spend records.
 */
export interface Spend {
  new: number
  cached: number
  out: number
  calls: number
}

/**
 * A synthetic `tool: 'Agent'` call record for one journaled spawn. This is
 * what makes `hp.js` `contextsOf()` (PARENT_TOOLS = ['Skill','Agent']) create
 * the child lane + spawn arrow.
 *
 * AIDEV-NOTE (PMR-V392) synthetic-id scheme: contexts are keyed by the
 * journaled childId (stable across the run); the main context is 'main'
 * (hp.js MAIN). tool_use_id = 'spawn-<childId>' is dedup-safe — repeated
 * spawn/resume/reattach records for one child collapse onto one lane.
 */
export interface SpawnCallRecord {
  v: 2
  harness: 'pi'
  /** End of the child's work — the record's position on the timeline. */
  at: string
  /** '<ref> run <k>' — shared by all records of the selected run. */
  session: string
  agent_id: string
  tool: 'Agent'
  tool_use_id: string
  name: string
  child_agent_id: string
  child_agent_type?: string
  duration_ms: number
  child_spend?: Spend
}

/**
 * AIDEV-NOTE (PMR-V392): 2.2 emits spawn records; 2.3 adds tool-call,
 * spend (SubagentStop) and marker records to this union.
 */
export type DiagramRecord = SpawnCallRecord

export type DiagramResult =
  | { kind: 'ok'; header: DiagramHeader; records: DiagramRecord[] }
  /** No run-start events at all — nothing segmentable in the journal. */
  | { kind: 'no-records' }
  /**
   * AIDEV-NOTE (PMR-V3FN): runIndex beyond runCount; runCount travels so
   * the caller can say "journal has N runs".
   */
  | { kind: 'out-of-range'; runCount: number }

export interface DiagramContext {
  assignments: readonly AssignmentRecord[]
  /** Parsed session entries keyed by session file path. */
  sessionEntriesByFile: ReadonlyMap<string, readonly unknown[]>
}

/**
 * AIDEV-NOTE: run-start events delimit runs; the segment INCLUDES its
 * run-start event and events before the first run-start belong to run 1.
 * runIndex is 1-based; null/undefined selects the latest run.
 */
export function segmentRuns(events: readonly FlowRunEvent[]): FlowRunEvent[][] {
  const segments: FlowRunEvent[][] = []
  // pre-run-start events are buffered until the first run-start opens run 1
  let current: FlowRunEvent[] = []
  let open = false
  for (const event of events) {
    if (event.kind === 'run-start') {
      if (open) {
        segments.push(current)
        current = [event]
      } else {
        // events before the first run-start belong to run 1
        current = [event, ...current]
        open = true
      }
    } else {
      current.push(event)
    }
  }
  if (open) segments.push(current)
  return segments
}

const NAME_LIMIT = 60

function clip(text: string): string {
  if (text.length <= NAME_LIMIT) return text
  return text.slice(0, NAME_LIMIT)
}

function entryTimeMs(entry: unknown): number | null {
  if (entry == null || typeof entry !== 'object') return null
  const raw = (entry as Record<string, unknown>).timestamp
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return ms
}

/** Last parsed entry timestamp (ms), null when no timestamped entries. */
function lastEntryMs(entries: readonly unknown[]): number | null {
  let last: number | null = null
  for (const entry of entries) {
    const ms = entryTimeMs(entry)
    if (ms === null) continue
    if (last === null || ms > last) last = ms
  }
  return last
}

/** AIDEV-NOTE (PMR-V392): see Spend — dedup by entry id, camelCase usage. */
function computeSpend(entries: readonly unknown[]): Spend | undefined {
  const seen = new Set<string>()
  const spend: Spend = { new: 0, cached: 0, out: 0, calls: 0 }
  for (const entry of entries) {
    if (entry == null || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'message') continue
    const message = e.message
    if (message == null || typeof message !== 'object') continue
    const m = message as Record<string, unknown>
    if (m.role !== 'assistant') continue
    let id = ''
    if (typeof e.id === 'string') {
      id = e.id
    }
    if (id.length > 0) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    const usage = m.usage
    if (usage == null || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    const num = (value: unknown): number => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      return 0
    }
    spend.new += num(u.input) + num(u.cacheWrite)
    spend.cached += num(u.cacheRead)
    spend.out += num(u.output)
    spend.calls += 1
  }
  if (spend.calls === 0) return undefined
  return spend
}

function synthesizeSpawns(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
  runId: string,
): SpawnCallRecord[] {
  const notes = collectSpawnNotes(segment)
  const byChild = new Map<string, AssignmentRecord>()
  for (const record of ctx.assignments) {
    byChild.set(record.childId, record)
  }
  const records: SpawnCallRecord[] = []
  for (const note of notes) {
    // Mirrors computeCostRollup's byChild fallback (flow/cost-command.ts):
    // when the spawn note lacks a sessionFile, the assignment record supplies
    // sessionFile / agent type / subtask / end timestamp.
    let sessionFile: string | null = note.sessionFile
    const assignmentRecord = byChild.get(note.childId)
    if (
      (sessionFile === null || sessionFile.length === 0) &&
      assignmentRecord !== undefined
    ) {
      sessionFile = assignmentRecord.sessionFile
    }
    let entries: readonly unknown[] | undefined
    if (sessionFile !== null && sessionFile.length > 0) {
      entries = ctx.sessionEntriesByFile.get(sessionFile)
    }
    const spawnMs = Date.parse(note.at)
    let endMs = lastEntryMs(entries ?? [])
    if (endMs === null && assignmentRecord !== undefined) {
      const parsed = Date.parse(assignmentRecord.updatedAt)
      if (Number.isFinite(parsed)) endMs = parsed
    }
    if (endMs === null) endMs = spawnMs
    let duration = 0
    if (Number.isFinite(spawnMs)) duration = Math.max(0, endMs - spawnMs)
    let display = note.name
    if (display.length === 0 && assignmentRecord !== undefined) {
      display = assignmentRecord.name
    }
    if (display.length === 0) display = note.childId
    if (assignmentRecord?.agent !== undefined) display = assignmentRecord.agent
    let name = display
    const subtask = note.subtask ?? assignmentRecord?.subtask
    if (subtask !== null && subtask !== undefined)
      name = `${display} · ${subtask}`
    const record: SpawnCallRecord = {
      v: 2,
      harness: 'pi',
      at: new Date(endMs).toISOString(),
      session: runId,
      agent_id: 'main',
      tool: 'Agent',
      tool_use_id: `spawn-${note.childId}`,
      name: clip(name),
      child_agent_id: note.childId,
      duration_ms: duration,
    }
    if (assignmentRecord?.agent !== undefined) {
      record.child_agent_type = assignmentRecord.agent
    }
    const spend = computeSpend(entries ?? [])
    if (spend !== undefined) record.child_spend = spend
    records.push(record)
  }
  return records
}

/** AIDEV-NOTE (PMR-V392): 2.2 adds spawns; 2.3 layers toolCalls/spend/markers here. */
function synthesizeRecords(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
  runId: string,
): DiagramRecord[] {
  return synthesizeSpawns(segment, ctx, runId)
}

export function buildDiagram(
  _ref: string,
  runIndex: number | null | undefined,
  events: readonly FlowRunEvent[],
  assignments: readonly AssignmentRecord[],
  sessionEntriesByFile: ReadonlyMap<string, readonly unknown[]>,
): DiagramResult {
  const segments = segmentRuns(events)
  const runCount = segments.length
  let index: number
  if (runIndex === null || runIndex === undefined) {
    index = runCount
  } else {
    index = runIndex
  }
  if (runCount === 0) return { kind: 'no-records' }
  if (index < 1 || index > runCount) return { kind: 'out-of-range', runCount }

  const segment = segments[index - 1]
  const runStart = segment.find((event) => event.kind === 'run-start')
  if (runStart === undefined || runStart.kind !== 'run-start') {
    return { kind: 'no-records' }
  }

  const header: DiagramHeader = {
    ref: runStart.ref,
    runIndex: index,
    runCount,
    mode: runStart.mode,
    phases: phaseDurations(segment),
    commitsBySubtask: [],
    unattributed: [],
  }
  if (runStart.trackRef !== undefined) {
    header.trackRef = runStart.trackRef
  }

  for (const event of segment) {
    if (event.kind === 'subtask-ranges') {
      header.commitsBySubtask = [...event.bySubtask]
      header.unattributed = [...event.unattributed]
    } else if (event.kind === 'step-output' && event.prUrl !== undefined) {
      header.prUrl = event.prUrl
    }
  }

  const runId = `${runStart.ref} run ${index}`
  const records = synthesizeRecords(
    segment,
    {
      assignments,
      sessionEntriesByFile,
    },
    runId,
  )
  return { kind: 'ok', header, records }
}

export type { PhaseDuration, PhaseWindow } from '../flow/cost.ts'
