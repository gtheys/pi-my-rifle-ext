// AIDEV-NOTE (PMR-V3FN 2.1): pure translator core for /flow-diagram.
// Segments the run journal on 'run-start' events and extracts header facts
// for the selected run. Record synthesis (schema-v2 records) lands in 2.2/2.3
// via the synthesizeRecords seam — this module deliberately has NO fs and NO
// Pi runtime imports so it stays unit-testable in isolation.

import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  collectMainSessionFiles,
  collectSpawnNotes,
  type PhaseDuration,
  type PhaseWindow,
  phaseDurations,
  phaseWindows,
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
  /**
   * AIDEV-NOTE (deviation fix): omitted for lost children (no session end,
   * no assignment updatedAt) — the spec's two-step end chain yields no end,
   * so the lane carries no length claim ("lanes without ends"). hp.js reads
   * `duration_ms || 0` for layout, so absence is safe.
   */
  duration_ms?: number
  child_spend?: Spend
}

/**
 * One paired toolCall/toolResult from any context's session (main or child).
 * Per Appendix A: never uses PARENT_TOOLS names, so it renders inside the
 * lane it belongs to.
 */
export interface ToolCallRecord {
  v: 2
  harness: 'pi'
  session: string
  agent_id: string
  tool_use_id: string
  tool: string
  /** Command head (bash) or tool name, clipped. */
  name: string
  /** Clipped one-line command, bash calls only. */
  args?: string
  /** First line of the toolResult text, clipped. */
  result?: string
  duration_ms: number
  ok?: boolean
  context_tokens?: number
  /** Unpaired toolCall (no result yet) stays on the timeline as running. */
  running?: boolean
  at: string
}

/** Per-context token totals; `contextSpend()` in hp.js reads these. */
export interface SpendRecord {
  v: 2
  harness: 'pi'
  session: string
  agent_id: string
  event: 'SubagentStop'
  spend: Spend
  at: string
}

/** Vertical labeled phase marker (one per segmented phase-start). */
export interface PhaseMarkerRecord {
  v: 2
  harness: 'pi'
  session: string
  agent_id: 'main'
  event: 'PreCompact'
  trigger: string
  at: string
}

/** Inline diamond milestone (gate decision / receipt / commit). */
export interface MilestoneMarkerRecord {
  v: 2
  harness: 'pi'
  session: string
  agent_id: 'main'
  tool: 'Skill'
  tool_use_id: string
  name: string
  ok: true
  at: string
}

/**
 * AIDEV-NOTE (PMR-V392): 2.2 emits spawn records; 2.3 adds tool-call,
 * spend (SubagentStop) and marker records to this union.
 */
export type DiagramRecord =
  | SpawnCallRecord
  | ToolCallRecord
  | SpendRecord
  | PhaseMarkerRecord
  | MilestoneMarkerRecord

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

/**
 * AIDEV-NOTE (PMR-GPQJ): segment selection is exported so callers
 * (command.ts) can scope session-file reads to the SELECTED run instead of
 * reading every run's sessions journal-wide. buildDiagram consumes the same
 * selection, so both paths agree on the index/runCount math.
 */
export type SegmentSelection =
  | { kind: 'ok'; segment: FlowRunEvent[]; index: number; runCount: number }
  /** No run-start events at all — nothing segmentable in the journal. */
  | { kind: 'no-records' }
  | { kind: 'out-of-range'; runCount: number }

export function selectSegment(
  events: readonly FlowRunEvent[],
  runIndex: number | null | undefined,
): SegmentSelection {
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
  return { kind: 'ok', segment: segments[index - 1], index, runCount }
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

/**
 * AIDEV-NOTE (PMR-V392): the orchestrator's main session contains raw
 * subagent-spawn tool calls (tool name `subagent`, verified in a real pi
 * session file and docs/extensions.md). They duplicate the journal-derived
 * spawn arrows from synthesizeSpawns, so they are skipped here. Phase 5
 * smoke re-verifies against real data.
 */
export const SPAWN_TOOL_SKIP: readonly string[] = ['subagent']

/** One session lane we walk for tool calls and spend. */
interface Lane {
  agentId: string
  entries: readonly unknown[]
  /** Fallback end (assignment.updatedAt / spawn at) when entries lack timestamps. */
  fallbackEndMs: number | null
}

interface ResolvedChild {
  childId: string
  sessionFile: string | null
  fallbackEndMs: number | null
}

/** Mirrors synthesizeSpawns' sessionFile/end fallback for spend records. */
function resolveChildren(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
): ResolvedChild[] {
  const byChild = new Map<string, AssignmentRecord>()
  for (const record of ctx.assignments) {
    byChild.set(record.childId, record)
  }
  const children: ResolvedChild[] = []
  for (const note of collectSpawnNotes(segment)) {
    let sessionFile: string | null = note.sessionFile
    const assignmentRecord = byChild.get(note.childId)
    if (
      (sessionFile === null || sessionFile.length === 0) &&
      assignmentRecord !== undefined
    ) {
      sessionFile = assignmentRecord.sessionFile
    }
    let fallbackEndMs: number | null = null
    if (assignmentRecord !== undefined) {
      const parsed = Date.parse(assignmentRecord.updatedAt)
      if (Number.isFinite(parsed)) fallbackEndMs = parsed
    }
    if (fallbackEndMs === null) {
      const parsed = Date.parse(note.at)
      if (Number.isFinite(parsed)) fallbackEndMs = parsed
    }
    children.push({ childId: note.childId, sessionFile, fallbackEndMs })
  }
  return children
}

function laneEntries(
  ctx: DiagramContext,
  sessionFile: string | null,
): readonly unknown[] {
  if (sessionFile === null || sessionFile.length === 0) return []
  const entries = ctx.sessionEntriesByFile.get(sessionFile)
  if (entries === undefined) return []
  return entries
}

/**
 * AIDEV-NOTE (review blocker B2): main pi sessions RESUME across runs, so a
 * lane must only carry entries inside the selected segment's phase windows —
 * same rule as buildMainRows in flow/cost.ts. Entries outside every window
 * are pre/post-flow chat; entries without a parseable timestamp are dropped
 * (they cannot be placed on the timeline). Empty windows clip everything —
 * a run with no phase-starts has no attributable main-lane activity.
 */
function clipToWindows(
  entries: readonly unknown[],
  windows: readonly PhaseWindow[],
): readonly unknown[] {
  const clipped: unknown[] = []
  for (const entry of entries) {
    const ms = entryTimeMs(entry)
    if (ms === null) continue
    const window = windows.find((w) => ms >= w.startMs && ms < w.endMs)
    if (window === undefined) continue
    clipped.push(entry)
  }
  return clipped
}

function buildLanes(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
): Lane[] {
  const windows = phaseWindows(segment)
  const lanes: Lane[] = []
  for (const sessionFile of collectMainSessionFiles(segment)) {
    lanes.push({
      agentId: 'main',
      entries: clipToWindows(laneEntries(ctx, sessionFile), windows),
      fallbackEndMs: null,
    })
  }
  for (const child of resolveChildren(segment, ctx)) {
    lanes.push({
      agentId: child.childId,
      entries: laneEntries(ctx, child.sessionFile),
      fallbackEndMs: child.fallbackEndMs,
    })
  }
  return lanes
}

/** AIDEV-NOTE (PMR-V392): duration = toolResult ms-epoch − assistant ISO, clamped ≥ 0. */
function callDurationMs(resultMs: number, entryMs: number | null): number {
  if (entryMs === null) return 0
  const duration = resultMs - entryMs
  if (duration < 0) return 0
  return duration
}

interface ToolCallBlock {
  id: string
  name: string
  command: string | null
}

interface ToolResultInfo {
  ms: number
  isError: boolean
  text: string | null
}

function extractToolCallBlock(block: unknown): ToolCallBlock | null {
  if (block == null || typeof block !== 'object') return null
  const b = block as Record<string, unknown>
  if (b.type !== 'toolCall') return null
  if (typeof b.id !== 'string' || typeof b.name !== 'string') return null
  let command: string | null = null
  const args = b.arguments
  if (b.name === 'bash' && args != null && typeof args === 'object') {
    const cmd = (args as Record<string, unknown>).command
    if (typeof cmd === 'string' && cmd.length > 0) {
      command = cmd.split('\n')[0]
    }
  }
  return { id: b.id, name: b.name, command }
}

function extractToolResult(entry: unknown): ToolResultInfo | null {
  if (entry == null || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (e.type !== 'message') return null
  const message = e.message
  if (message == null || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.role !== 'toolResult') return null
  if (typeof m.toolCallId !== 'string') return null
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp)) {
    return null
  }
  let isError = false
  if (m.isError === true) isError = true
  let text: string | null = null
  const content = m.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block == null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      text = b.text.split('\n')[0]
      break
    }
  }
  return { ms: m.timestamp, isError, text }
}

function callName(call: ToolCallBlock): string {
  if (call.command !== null) {
    const head = call.command.trim().split(/\s+/)[0]
    if (head.length > 0) return head
  }
  return call.name
}

function synthesizeToolCalls(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
  runId: string,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = []
  for (const lane of buildLanes(segment, ctx)) {
    const resultsById = new Map<string, ToolResultInfo>()
    for (const entry of lane.entries) {
      const result = extractToolResult(entry)
      if (result === null) continue
      const key = resultKeyOf(entry)
      if (resultsById.has(key)) continue
      resultsById.set(key, result)
    }
    for (const entry of lane.entries) {
      if (entry == null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (e.type !== 'message') continue
      const message = e.message
      if (message == null || typeof message !== 'object') continue
      const m = message as Record<string, unknown>
      if (m.role !== 'assistant') continue
      const entryMs = entryTimeMs(entry)
      let contextTokens: number | undefined
      const usage = m.usage
      if (usage != null && typeof usage === 'object') {
        const total = (usage as Record<string, unknown>).totalTokens
        if (typeof total === 'number' && Number.isFinite(total)) {
          contextTokens = total
        }
      }
      const content = m.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const call = extractToolCallBlock(block)
        if (call === null) continue
        if (SPAWN_TOOL_SKIP.includes(call.name)) continue
        const result = resultsById.get(call.id)
        let at: string
        if (result === undefined) {
          if (entryMs !== null) at = new Date(entryMs).toISOString()
          else at = ''
        } else {
          at = new Date(result.ms).toISOString()
        }
        const record: ToolCallRecord = {
          v: 2,
          harness: 'pi',
          session: runId,
          agent_id: lane.agentId,
          tool_use_id: call.id,
          tool: call.name,
          name: clip(callName(call)),
          duration_ms: 0,
          at,
        }
        if (call.command !== null) record.args = clip(call.command)
        if (contextTokens !== undefined) record.context_tokens = contextTokens
        if (result === undefined) {
          record.running = true
        } else {
          record.duration_ms = callDurationMs(result.ms, entryMs)
          record.ok = !result.isError
          if (result.text !== null) record.result = clip(result.text)
        }
        records.push(record)
      }
    }
  }
  return records
}

function resultKeyOf(entry: unknown): string {
  if (entry == null || typeof entry !== 'object') return ''
  const e = entry as Record<string, unknown>
  if (e.type !== 'message') return ''
  const message = e.message
  if (message == null || typeof message !== 'object') return ''
  const toolCallId = (message as Record<string, unknown>).toolCallId
  if (typeof toolCallId === 'string') return toolCallId
  return ''
}

function synthesizeSpendRecords(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
  runId: string,
): SpendRecord[] {
  const records: SpendRecord[] = []
  for (const lane of buildLanes(segment, ctx)) {
    const spend = computeSpend(lane.entries)
    if (spend === undefined) continue
    let endMs = lastEntryMs(lane.entries)
    if (endMs === null) endMs = lane.fallbackEndMs
    if (endMs === null) continue
    records.push({
      v: 2,
      harness: 'pi',
      session: runId,
      agent_id: lane.agentId,
      event: 'SubagentStop',
      spend,
      at: new Date(endMs).toISOString(),
    })
  }
  return records
}

function synthesizePhaseMarkers(
  segment: readonly FlowRunEvent[],
  runId: string,
): PhaseMarkerRecord[] {
  const records: PhaseMarkerRecord[] = []
  for (const event of segment) {
    if (event.kind !== 'phase-start') continue
    records.push({
      v: 2,
      harness: 'pi',
      session: runId,
      agent_id: 'main',
      event: 'PreCompact',
      trigger: `phase ${event.phase}`,
      at: event.at,
    })
  }
  return records
}

function synthesizeMilestoneMarkers(
  segment: readonly FlowRunEvent[],
  runId: string,
): MilestoneMarkerRecord[] {
  const records: MilestoneMarkerRecord[] = []
  let mark = 0
  const push = (name: string, at: string): void => {
    mark += 1
    records.push({
      v: 2,
      harness: 'pi',
      session: runId,
      agent_id: 'main',
      tool: 'Skill',
      tool_use_id: `mark-${mark}`,
      name: clip(name),
      ok: true,
      at,
    })
  }
  // latest gate-decision per gate
  const latestByGate = new Map<
    string,
    Extract<FlowRunEvent, { kind: 'gate-decision' }>
  >()
  for (const event of segment) {
    if (event.kind === 'gate-decision') latestByGate.set(event.gate, event)
  }
  for (const event of latestByGate.values()) {
    push(`gate ${event.gate}: ${event.status}`, event.at)
  }
  for (const event of segment) {
    if (event.kind === 'command-receipt') {
      push(`receipt: ${event.command}`, event.at)
    } else if (event.kind === 'subtask-ranges') {
      for (const range of event.bySubtask) {
        for (const sha of range.commits) {
          push(`commit ${sha.slice(0, 7)} → ${range.subtask}`, event.at)
        }
      }
    }
  }
  return records
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
    // AIDEV-NOTE (deviation fix): the end chain is two-step per spec §2.2 —
    // last parsed session entry, else assignment updatedAt. A lost child
    // (neither present) gets NO end: the record is positioned at the spawn
    // event's own timestamp (a position, not an end claim) and omits
    // duration_ms ("lanes without ends"); no spawn-time fallback exists.
    let at: string
    let duration: number | undefined
    if (endMs !== null) {
      at = new Date(endMs).toISOString()
      if (Number.isFinite(spawnMs)) {
        duration = Math.max(0, endMs - spawnMs)
      }
    } else {
      at = note.at
    }
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
      at,
      session: runId,
      agent_id: 'main',
      tool: 'Agent',
      tool_use_id: `spawn-${note.childId}`,
      name: clip(name),
      child_agent_id: note.childId,
    }
    if (duration !== undefined) record.duration_ms = duration
    if (assignmentRecord?.agent !== undefined) {
      record.child_agent_type = assignmentRecord.agent
    }
    const spend = computeSpend(entries ?? [])
    if (spend !== undefined) record.child_spend = spend
    records.push(record)
  }
  return records
}

/**
 * AIDEV-NOTE (PMR-V392): 2.2 adds spawns; 2.3 layers toolCalls, spend
 * (SubagentStop) and marker records, then sorts the whole set by `at`.
 */
function synthesizeRecords(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
  runId: string,
): DiagramRecord[] {
  const records: DiagramRecord[] = [
    ...synthesizeSpawns(segment, ctx, runId),
    ...synthesizeToolCalls(segment, ctx, runId),
    ...synthesizeSpendRecords(segment, ctx, runId),
    ...synthesizePhaseMarkers(segment, runId),
    ...synthesizeMilestoneMarkers(segment, runId),
  ]
  records.sort((a, b) => {
    if (a.at < b.at) return -1
    if (a.at > b.at) return 1
    return 0
  })
  return records
}

export function buildDiagram(
  _ref: string,
  runIndex: number | null | undefined,
  events: readonly FlowRunEvent[],
  assignments: readonly AssignmentRecord[],
  sessionEntriesByFile: ReadonlyMap<string, readonly unknown[]>,
): DiagramResult {
  const selection = selectSegment(events, runIndex)
  if (selection.kind === 'no-records') return { kind: 'no-records' }
  if (selection.kind === 'out-of-range') {
    return { kind: 'out-of-range', runCount: selection.runCount }
  }
  const { segment, index, runCount } = selection
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
  if (records.length === 0) return { kind: 'no-records' }
  return { kind: 'ok', header, records }
}

export type { PhaseDuration, PhaseWindow } from '../flow/cost.ts'
