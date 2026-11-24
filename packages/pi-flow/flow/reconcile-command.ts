// AIDEV-NOTE (PMR-MSDJ 2.3, plan PMR-V36Y): `/flow-reconcile-push` — the
// manual face of the tombstone reconcile. This module owns the ARGUMENT
// GRAMMAR and the USER-FACING RENDERING only; every decision (which refs are
// stale, what a tombstone body is, how many warnings a pass may emit) stays in
// `flow/reconcile.ts` and every io seam stays in `flow/reconcile-deps.ts`, so
// the whole surface is testable with injected deps + a capture sink
// (test/reconcile-command.test.ts) and `index.ts` stays registration wiring.
//
// Semantics table (orchestrator decision 2026-11-24; the plan's Done-when
// manual-smoke step REQUIRES the no-URL dry-run row to list refs, and a full
// `runReconcilePass` cannot do that — its dry-run still GETs every group to
// build the body it would have posted):
//
//   | mode     | PI_FLOW_PUSHGATEWAY_URL | behaviour                              |
//   |----------|-------------------------|----------------------------------------|
//   | help     | anything                | usage line, zero io                    |
//   | real run | unset                   | one ERROR notify, zero io              |
//   | real run | set                     | runReconcilePass(deps, {dryRun:false}) |
//   | dry-run  | set                     | runReconcilePass(deps, {dryRun:true})  |
//   | dry-run  | unset                   | gateway-less candidate scan, zero POST |
//
// aven failure behaves identically in both dry-run flavors: exactly one
// warning (the engine's fail-closed line, via the injected `warn` sink) plus
// the report banner.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { FlowRunEvent } from '../run-state.ts'
import {
  AVEN_FAILED_WARNING,
  computeStaleRefs,
  livenessStatusOf,
  type ReconcileDeps,
  type ReconcileReport,
  type ReconcileStaleEntry,
  runReconcilePass,
} from './reconcile.ts'
import { reconcileSummaryLine } from './reconcile-deps.ts'

/** `/flow-reconcile-push` takes no ref: one pass covers every run journal. */
export type ParsedReconcileArgs =
  | { kind: 'run' }
  | { kind: 'dry-run' }
  | { kind: 'help' }

export function parseReconcileArgs(args: string): ParsedReconcileArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  let dryRun = false
  for (const token of tokens) {
    if (token === '--dry-run') {
      dryRun = true
      continue
    }
    // `--help`, a stray ref, anything else: show usage rather than guess.
    return { kind: 'help' }
  }
  if (dryRun) return { kind: 'dry-run' }
  return { kind: 'run' }
}

/** The notify channel: `ctx.ui.notify` in a session, an array in tests. */
export type ReconcileNotify = (
  message: string,
  level: 'info' | 'warning' | 'error',
) => void

export interface ReconcileCommandDeps {
  /**
   * The gateway-backed engine deps, or null when `PI_FLOW_PUSHGATEWAY_URL` is
   * unset — the SAME env gate the daemon timer and the cost autopush use
   * (`pushgatewayEnv`), so no surface can disagree with another about whether
   * there is a gateway. `warn` is the COMMAND's sink: engine warnings become
   * user-visible warnings here instead of `server.log` lines.
   */
  createEngineDeps(warn: (message: string) => void): ReconcileDeps | null
  /** Gateway-less scan seams: the journal + aven half only, used by `--dry-run`. */
  listJournalRefs: () => Promise<string[]>
  readRunEvents: (ref: string) => Promise<readonly FlowRunEvent[] | null>
  listTicketStatuses: () => Promise<Map<string, string> | null>
}

const RECONCILE_USAGE =
  'Usage: /flow-reconcile-push [--dry-run] — tombstone Pushgateway liveness for runs whose aven ticket is no longer active. No ref: one pass covers every run journal.'

const NO_GATEWAY_MESSAGE =
  'reconcile needs PI_FLOW_PUSHGATEWAY_URL set — nothing to push to. Export the pushgateway endpoint (and PI_FLOW_PUSHGATEWAY_TOKEN when it needs auth), then rerun /flow-reconcile-push.'

const NOT_INSPECTED_HEADER =
  'PI_FLOW_PUSHGATEWAY_URL unset — candidates only, groups not inspected'

const AVEN_FAILED_BANNER =
  'aven FAILED — ticket statuses unavailable: nothing was tombstoned (fail-closed)'

/** One pass, rendered. The handler body, ctx-free so tests drive it directly. */
export async function runReconcileCommand(
  deps: ReconcileCommandDeps,
  parsed: ParsedReconcileArgs,
  out: ReconcileNotify,
): Promise<void> {
  if (parsed.kind === 'help') {
    out(RECONCILE_USAGE, 'info')
    return
  }
  const dryRun = parsed.kind === 'dry-run'
  const warn = (message: string): void => {
    out(message, 'warning')
  }
  const engine = deps.createEngineDeps(warn)
  if (engine === null) {
    if (!dryRun) {
      out(NO_GATEWAY_MESSAGE, 'error')
      return
    }
    out(
      formatReconcileReport(await scanWithoutGateway(deps, warn), 'no-gateway'),
      'info',
    )
    return
  }
  const report = await runReconcilePass(engine, { dryRun })
  out(formatReconcileReport(report, 'gateway'), 'info')
}

/**
 * The gateway-less half of `--dry-run`: the engine's candidate filter and the
 * engine's aven gate, with no gateway call at all. It mirrors
 * `runReconcilePass`'s gates in the same order (no aven shell-out when there
 * are no candidates, one warning when the listing fails, fail-closed) and
 * shares the rules themselves (`livenessStatusOf`, `computeStaleRefs`,
 * `AVEN_FAILED_WARNING`) instead of restating them.
 *
 * `tombstoned`/`skipped` stay EMPTY BY CONSTRUCTION: nothing was fetched, so
 * no ref can claim a gateway-verified reason. That is why the rendered report
 * says "groups not inspected" rather than implying a verified body.
 */
async function scanWithoutGateway(
  deps: ReconcileCommandDeps,
  warn: (message: string) => void,
): Promise<ReconcileReport> {
  const refs = await deps.listJournalRefs()
  const journalStates = new Map<string, string>()
  for (const ref of refs) {
    const events = await deps.readRunEvents(ref)
    if (events === null) continue
    const status = livenessStatusOf(events)
    if (status === null) continue
    journalStates.set(ref, status)
  }
  const report: ReconcileReport = {
    scanned: refs.length,
    candidates: journalStates.size,
    stale: [],
    tombstoned: [],
    skipped: [],
    avenFailed: false,
    dryRun: true,
  }
  if (journalStates.size === 0) return report
  const ticketStatus = await deps.listTicketStatuses()
  if (ticketStatus === null) {
    warn(AVEN_FAILED_WARNING)
    report.avenFailed = true
    return report
  }
  const stale: ReconcileStaleEntry[] = []
  for (const ref of computeStaleRefs(journalStates, ticketStatus)) {
    const journalStatus = journalStates.get(ref)
    if (journalStatus === undefined) continue
    stale.push({ ref, journalStatus, ticketStatus: ticketStatus.get(ref) })
  }
  report.stale = stale
  return report
}

/**
 * The report as a user reads it: headers first, then the ONE summary line the
 * daemon logs too (`reconcileSummaryLine`, so the two surfaces cannot drift),
 * then one indented line per stale ref saying what happened to it. Candidates
 * that stayed live are not listed — `candidates=N` is the statement.
 */
export function formatReconcileReport(
  report: ReconcileReport,
  inspected: 'gateway' | 'no-gateway',
): string {
  const lines: string[] = []
  if (report.dryRun) lines.push('DRY RUN — nothing pushed')
  if (inspected === 'no-gateway') lines.push(NOT_INSPECTED_HEADER)
  lines.push(reconcileSummaryLine(report))
  if (report.avenFailed) lines.push(AVEN_FAILED_BANNER)
  for (const entry of report.stale) {
    lines.push(`  ${formatStaleLine(report, entry)}`)
  }
  return lines.join('\n')
}

function formatStaleLine(
  report: ReconcileReport,
  entry: ReconcileStaleEntry,
): string {
  const head = `${entry.ref} (ticket ${entry.ticketStatus ?? 'missing'}) journal=${entry.journalStatus}`
  const skipped = report.skipped.find((item) => item.ref === entry.ref)
  if (skipped !== undefined) return `${head} → skipped: ${skipped.reason}`
  if (report.tombstoned.includes(entry.ref)) return `${head} → tombstoned`
  if (report.dryRun) return `${head} → would tombstone`
  return `${head} → not tombstoned`
}

export function registerReconcileCommand(
  pi: ExtensionAPI,
  deps: ReconcileCommandDeps,
): void {
  pi.registerCommand('flow-reconcile-push', {
    description:
      'Tombstone stale run-liveness metrics (halted/paused runs whose aven ticket is no longer active). Usage: /flow-reconcile-push [--dry-run]',
    handler: async (args, ctx) => {
      await runReconcileCommand(
        deps,
        parseReconcileArgs(args),
        (message, level) => ctx.ui.notify(message, level),
      )
    },
  })
}
