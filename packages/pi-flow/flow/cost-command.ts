// AIDEV-NOTE (PMR-EA8X): /flow-cost command registration. All data access
// is injected so tests exercise the command purely; the offline ground-truth
// rollup lives in flow/cost.ts. `--push` forwards aggregates to the
// Pushgateway (optional backend): push failures surface as warnings and
// never fail the report — the session files stay the authority.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import { isValidRef } from '../herdr/viewer.ts'
import type { FlowRunEvent } from '../run-state.ts'
import {
  buildMainRows,
  buildPushBody,
  buildWorkerRows,
  collectMainSessionFiles,
  collectSpawnNotes,
  formatCostReport,
  type PhaseDuration,
  type PushResult,
  parseSessionEntries,
  phaseDurations,
  type WorkerRow,
} from './cost.ts'

export interface FlowCostDeps {
  /** Journal events for a ref; null when no journal exists. */
  readRunEvents: (ref: string) => Promise<FlowRunEvent[] | null>
  /** Durable assignment records (subagents data dir). */
  listAssignmentRecords: () => AssignmentRecord[]
  /** Raw session jsonl body, or null when unreadable (coverage gap). */
  readSessionFile: (file: string) => string | null
  /** Push exposition body to the gateway; ok=false is a warning, not fatal. */
  push: (ref: string, body: string) => Promise<PushResult>
}

type ParsedCostArgs =
  | { kind: 'ok'; ref: string; push: boolean }
  | { kind: 'help' }

export function parseCostArgs(args: string): ParsedCostArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  let ref: string | null = null
  let push = false
  for (const token of tokens) {
    if (token === '--push') {
      push = true
      continue
    }
    if (ref === null) {
      ref = token
      continue
    }
    return { kind: 'help' }
  }
  if (ref === null) return { kind: 'help' }
  return { kind: 'ok', ref, push }
}

export type CostRollup =
  | { kind: 'no-journal' }
  | { kind: 'empty' }
  | { kind: 'ok'; rows: WorkerRow[]; durations: PhaseDuration[] }

/**
 * Journal + session files -> cost rows. Shared by `/flow-cost` and the
 * automatic push at run end, so both always agree. 'empty' = the journal has
 * neither worker spawn notes nor a main-session record (pre-attribution run).
 */
export async function computeCostRollup(
  ref: string,
  deps: Pick<
    FlowCostDeps,
    'readRunEvents' | 'listAssignmentRecords' | 'readSessionFile'
  >,
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
  return { kind: 'ok', rows, durations: phaseDurations(events) }
}

export function registerFlowCostCommand(
  pi: ExtensionAPI,
  deps: FlowCostDeps,
): void {
  pi.registerCommand('flow-cost', {
    description:
      'Per-ticket cost rollup from session files (offline ground truth). Usage: /flow-cost <ref> [--push]',
    handler: async (args, ctx) => {
      const parsed = parseCostArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /flow-cost <ref> [--push] — cost per worker/subtask/phase from the run journal + session files.',
          'info',
        )
        return
      }
      if (!isValidRef(parsed.ref)) {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: invalid ref (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}) — aborting.`,
          'warning',
        )
        return
      }
      const rollup = await computeCostRollup(parsed.ref, deps)
      if (rollup.kind === 'no-journal') {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: no run journal found — nothing to roll up.`,
          'warning',
        )
        return
      }
      if (rollup.kind === 'empty') {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: journal has no subagent spawn notes (pre-attribution run?) — nothing to roll up.`,
          'info',
        )
        return
      }
      const { rows, durations } = rollup
      ctx.ui.notify(formatCostReport(parsed.ref, rows, durations), 'info')
      if (parsed.push) {
        const result = await deps.push(
          parsed.ref,
          buildPushBody(parsed.ref, rows, durations),
        )
        if (result.ok) {
          ctx.ui.notify(
            `/flow-cost ${parsed.ref}: pushed aggregates to the pushgateway.`,
            'info',
          )
        } else {
          ctx.ui.notify(
            `/flow-cost ${parsed.ref}: pushgateway push FAILED (${result.error ?? 'unknown error'}) — report above is still the ground truth.`,
            'warning',
          )
        }
      }
    },
  })
}
