// AIDEV-NOTE (PMR-V3FN 2.1): pure translator core for /flow-diagram.
// Segments the run journal on 'run-start' events and extracts header facts
// for the selected run. Record synthesis (schema-v2 records) lands in 2.2/2.3
// via the synthesizeRecords seam — this module deliberately has NO fs and NO
// Pi runtime imports so it stays unit-testable in isolation.

import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import type { PhaseDuration } from '../flow/cost.ts'
import { phaseDurations } from '../flow/cost.ts'
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
 * AIDEV-NOTE: loose placeholder — 2.2/2.3 replace this with the real
 * harness-profiler schema-v2 record type as record synthesis lands.
 */
export interface DiagramRecord {
  kind: string
}

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

/** AIDEV-NOTE (PMR-V3FN 2.1): seam for 2.2/2.3 record synthesis. */
function synthesizeRecords(
  segment: readonly FlowRunEvent[],
  ctx: DiagramContext,
): DiagramRecord[] {
  void segment
  void ctx
  return []
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

  const records = synthesizeRecords(segment, {
    assignments,
    sessionEntriesByFile,
  })
  return { kind: 'ok', header, records }
}

export type { PhaseDuration, PhaseWindow } from '../flow/cost.ts'
