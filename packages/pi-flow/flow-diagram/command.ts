// AIDEV-NOTE (PMR-PVT5 4.1): /flow-diagram command registration, mirroring
// flow/cost-command.ts. All data access is injected (FlowDiagramDeps) so the
// handler is testable purely; index.ts (4.2) owns the real dep wiring and
// filename/open side effects. Every degradation step aborts with a single
// warning notify — the written file path is always the deliverable.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  collectMainSessionFiles,
  collectSpawnNotes,
  parseSessionEntries,
} from '../flow/cost.ts'
import { parseRefKind } from '../flow/ref-kind.ts'
import { isValidRef } from '../herdr/viewer.ts'
import type { FlowRunEvent } from '../run-state.ts'
import { renderDiagramHtml } from './assemble.ts'
import { buildDiagram, selectSegment } from './translate.ts'
import type { HpRenderer } from './vendor/harness-profiler/load.ts'

export interface FlowDiagramDeps {
  /** Journal events for a ref; null when no journal exists. */
  readRunEvents: (ref: string) => Promise<FlowRunEvent[] | null>
  /** Durable assignment records (subagents data dir). */
  listAssignmentRecords: () => AssignmentRecord[]
  /** Raw session jsonl body, or null when unreadable (counted, not fatal). */
  readSessionFile: (file: string) => string | null
  /** Vendored renderer; null aborts the command (fail-graceful load). */
  loadRenderer: () => HpRenderer | null
  /**
   * Write the self-contained HTML as
   * `pi-flow/diagrams/<ref>.run<k>.<YYYYMMDD-HHmmss>.html` under the agent
   * dir; resolves the written file path.
   */
  writeDiagram: (ref: string, runIndex: number, html: string) => Promise<string>
  /** Best-effort open (xdg-open/open fallback); false = user opens by hand. */
  openDiagram: (path: string) => Promise<boolean>
}

export type ParsedDiagramArgs =
  | { kind: 'ok'; ref: string; run: number | null }
  | { kind: 'help' }

/**
 * Filename stamp for diagram files: local-time `YYYYMMDD-HHmmss`. Pure so
 * index.ts can reuse it in the writeDiagram wiring and tests can pin it.
 */
export function diagramStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${date}-${time}`
}

/**
 * First token = ref (aven:/jira: prefix stripped via parseRefKind), optional
 * second token = 1-based positive-integer run selector; anything else = help.
 */
export function parseDiagramArgs(args: string): ParsedDiagramArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0 || tokens.length > 2) return { kind: 'help' }
  const kinded = parseRefKind(tokens[0] as string)
  let ref: string
  if (kinded.kind === 'jira') {
    ref = kinded.jiraId
  } else {
    ref = kinded.ref
  }
  if (tokens.length === 1) {
    return { kind: 'ok', ref, run: null }
  }
  const runToken = tokens[1] as string
  if (!/^\d+$/.test(runToken)) return { kind: 'help' }
  const run = Number.parseInt(runToken, 10)
  if (run < 1) return { kind: 'help' }
  return { kind: 'ok', ref, run }
}

/**
 * AIDEV-NOTE (PMR-PVT5): degradation seam. Ordering — help, invalid ref,
 * renderer, journal, session reads, translate, write, open. Session files
 * that fail to read are counted and summarized in ONE info notify (never one
 * per file); a missing session only means that lane lacks token totals.
 * AIDEV-NOTE (PMR-GPQJ): `events` is the SELECTED run segment, not the whole
 * journal — reads and the unreadable count stay scoped to that run.
 */
async function collectSessionEntries(
  ref: string,
  segment: readonly FlowRunEvent[],
  deps: FlowDiagramDeps,
  notify: (message: string, level: 'info' | 'warning') => void,
): Promise<Map<string, readonly unknown[]>> {
  const wanted = new Set<string>()
  for (const file of collectMainSessionFiles(segment)) wanted.add(file)
  const notes = collectSpawnNotes(segment)
  for (const note of notes) {
    if (note.sessionFile !== null) wanted.add(note.sessionFile)
  }
  const byChild = new Map<string, AssignmentRecord>()
  for (const record of deps.listAssignmentRecords()) {
    byChild.set(record.childId, record)
  }
  for (const note of notes) {
    if (note.sessionFile !== null) continue
    const record = byChild.get(note.childId)
    if (record !== undefined && record.sessionFile.length > 0) {
      wanted.add(record.sessionFile)
    }
  }
  const entries = new Map<string, readonly unknown[]>()
  let misses = 0
  for (const file of wanted) {
    const raw = deps.readSessionFile(file)
    if (raw === null) {
      misses += 1
      continue
    }
    entries.set(file, parseSessionEntries(raw))
  }
  if (misses > 0) {
    notify(
      `/flow-diagram ${ref}: ${misses} session files unreadable — lanes may lack token totals.`,
      'info',
    )
  }
  return entries
}

export async function runFlowDiagram(
  ref: string,
  run: number | null,
  deps: FlowDiagramDeps,
  notify: (message: string, level: 'info' | 'warning') => void,
): Promise<void> {
  const renderer = deps.loadRenderer()
  if (renderer === null) {
    notify(
      `/flow-diagram ${ref}: harness-profiler renderer failed to load — aborting.`,
      'warning',
    )
    return
  }
  const events = await deps.readRunEvents(ref)
  if (events === null) {
    notify(
      `/flow-diagram ${ref}: no run journal found — nothing to diagram.`,
      'warning',
    )
    return
  }
  // AIDEV-NOTE (PMR-GPQJ): select the run segment BEFORE collecting session
  // entries so only the selected run's session files are read and the
  // unreadable summary counts that subset (multi-run journals previously
  // read every run's files journal-wide).
  const selection = selectSegment(events, run)
  if (selection.kind === 'out-of-range') {
    notify(
      `/flow-diagram ${ref}: run ${run} out of range — journal has ${selection.runCount} run(s).`,
      'warning',
    )
    return
  }
  if (selection.kind === 'no-records') {
    notify(
      `/flow-diagram ${ref}: nothing to diagram — no run segments or records in the journal.`,
      'warning',
    )
    return
  }
  const sessionEntriesByFile = await collectSessionEntries(
    ref,
    selection.segment,
    deps,
    notify,
  )
  const result = buildDiagram(
    ref,
    run,
    events,
    deps.listAssignmentRecords(),
    sessionEntriesByFile,
  )
  if (result.kind === 'out-of-range') {
    notify(
      `/flow-diagram ${ref}: run ${run} out of range — journal has ${result.runCount} run(s).`,
      'warning',
    )
    return
  }
  if (result.kind === 'no-records') {
    notify(
      `/flow-diagram ${ref}: nothing to diagram — no run segments or records in the journal.`,
      'warning',
    )
    return
  }
  // AIDEV-NOTE (PMR-9CHQ): skipped-record degradation is ONE summary
  // warning (same style as the unreadable-session seam), never a throw.
  if (result.warnings.length > 0) {
    notify(
      `/flow-diagram ${ref}: ${result.warnings.length} record(s) skipped — unparseable or missing timestamps.`,
      'warning',
    )
  }
  const html = renderDiagramHtml(
    renderer,
    result.header,
    result.records,
    `${ref} run ${result.header.runIndex}`,
  )
  const path = await deps.writeDiagram(ref, result.header.runIndex, html)
  const opened = await deps.openDiagram(path)
  if (opened) {
    notify(`/flow-diagram ${ref}: diagram written to ${path}`, 'info')
  } else {
    notify(`/flow-diagram ${ref}: open failed — diagram at ${path}`, 'warning')
  }
}

export function registerFlowDiagramCommand(
  pi: ExtensionAPI,
  deps: FlowDiagramDeps,
): void {
  pi.registerCommand('flow-diagram', {
    description:
      'Render the per-ticket flow timeline as a self-contained HTML sequence diagram. Usage: /flow-diagram <ref> [run]',
    handler: async (args, ctx) => {
      const parsed = parseDiagramArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /flow-diagram <ref> [run] — render the per-ticket flow timeline as a self-contained HTML sequence diagram.',
          'info',
        )
        return
      }
      if (!isValidRef(parsed.ref)) {
        ctx.ui.notify(
          `/flow-diagram ${parsed.ref}: invalid ref (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}) — aborting.`,
          'warning',
        )
        return
      }
      await runFlowDiagram(parsed.ref, parsed.run, deps, (message, level) => {
        ctx.ui.notify(message, level)
      })
    },
  })
}
