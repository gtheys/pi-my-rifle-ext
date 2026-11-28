// AIDEV-NOTE (PMR-MSDJ 1.3, plan PMR-V36Y): node-only tombstone engine for
// stale run-liveness metrics. Halted/paused `pi_flow_run_status` series are
// NEVER deleted — deleting the group would also erase the cost/token rows the
// `piflow-runs` board needs (true under official Pushgateway replace
// semantics AND under the merge-on-write behavior verified live on the
// homelab build, PMR-WBC2).
// Instead a stale run's group is re-pushed with the liveness series
// TOMBSTONED. Semantics of a tombstone:
//   • `pi_flow_run_status{…status="halted"|"paused"}` becomes `status="stale"`
//     — a NEW status VALUE, metric names and label KEYS stay frozen, so the
//     dashboard's value mappings (and the alert rules' `status="halted"`)
//     simply stop matching a closed run;
//   • `pi_flow_run_halt_reason{…}` is DROPPED entirely, which is what makes
//     the "needs attention" tables stop listing dead runs (the reason series
//     only ever exists for halted runs). AIDEV-NOTE (PMR-WBC2, verified live
//     2026-11-24): the homelab gateway MERGES on write — an omitted series
//     KEEPS being served, so this drop removes halt_reason only under
//     official Pushgateway replace semantics; there it survives until
//     overwritten. Tables and alerts still clear: both gate on `status`, and
//     the status flip to `stale` lands (same-identity series are overwritten
//     in place). The drop stays — correct under either semantics;
//   • everything else is re-emitted byte-identical, so
//     `sum(pi_flow_gate_wait_seconds)` / `pi_flow_human_wait_seconds` and all
//     cost accounting are unaffected.
//
// AIDEV-NOTE (PMR-ZV9Y 7.1): the three bullets above are the PRE-retirement
// (PMR-MSDJ/PMR-WBC2) semantics and are kept as history. The v1 state
// vocabulary they describe (`pi_flow_run_status`, `pi_flow_run_halt_reason`)
// is no longer rendered by flow/run-health.ts, so `tombstoneBody` now performs
// the SAME label-VALUE-only surgery on the v2 STATE lines ONLY:
// `pi_flow_state{…}` and `pi_flow_state_start_seconds{…}` with
// `state="halted"|"waiting_human"|"waiting_machine"` become `state="stale"`.
// The candidacy filter is UNCHANGED and stays JOURNAL-keyed (`livenessStatusOf`
// reads the projected v1 loop status from the run journal, never a metric line),
// so retiring the v1 status series does not change WHICH refs are stale — only
// which lines in a fetched body are rewritten.
// AIDEV-NOTE (PMR-ZV9Y fix round 1, P3a — RETRACTS the "no line is DROPPED any
// more" sentence this note originally carried): the tombstone is NOT pure value
// surgery. `tombstoneBody` (1) VALUE-FLIPS `pi_flow_state` and
// `pi_flow_state_start_seconds` from `halted|waiting_human|waiting_machine` to
// `stale`, AND (2) DROPS the transient `pi_flow_step{…} 1` gauge entirely from
// the re-POSTed body. The drop exists because `pi_flow_step` is the only v2
// family with NO state label whose whole meaning ("a step is in flight right
// now") is definitively FALSE for a retired run — it cannot be value-flipped to
// stale, so dropping is the only lever. It fires ONLY when a state line was
// actually flipped (`rewrites > 0`), so a live run's open step is never touched,
// and it matches only `pi_flow_step{` (the `{`), never `pi_flow_step_seconds{`.
// WHY a drop is correct despite this file's own earlier note (P3a): under
// OFFICIAL Pushgateway REPLACE semantics (the contract the GET-transform-POST
// round-trip assumes) an omitted series is gone after the re-POST — which is
// exactly the phantom-in-flight-step cleanup we want for a dead run. On the
// homelab gateway that MERGES on write (PMR-WBC2) the drop degrades to a
// harmless no-op (the stored series persists until overwritten), just like the
// retired halt_reason drop; the PRIMARY anti-phantom lever is the render-side
// suppression in flow/state-metrics.ts `isTerminalState` (halted/done/stale
// emit NO open-step line), so this tombstone-side drop is the belt-and-braces
// half that also cleans an ALREADY-STORED phantom on a replace-semantic gateway.
// Every OTHER v2 family (`pi_flow_phase`, `pi_flow_wait_seconds`,
// `pi_flow_step_seconds`) is re-emitted byte-identical — only `pi_flow_step`
// is dropped. The tests in test/reconcile-tombstone-v2.test.ts PIN this drop.
// (Fix round 3 note: the README and docs/pi-flow-observability.md previously
// still said "no line is dropped any more" and listed `pi_flow_step` among the
// byte-identical re-emissions — both were corrected to this contract.)
// Consequence to accept (matches the 6.5 cutover): a stored group that predates
// the v2 render carries only v1 lines, so `tombstoneBody` reads it as "already
// clean" (null) and never re-posts it. That is harmless because every alert
// rule and board was cut to the v2 vocabulary in 6.2–6.5, so a stale v1-only
// body drives nothing anymore; the pre-existing P2-4 "stored group the journal
// no longer describes" limitation already covers this shape.
//
// AIDEV-NOTE: because a POST REPLACES THE WHOLE GROUP (official Pushgateway
// semantics; the homelab build merges on write — PMR-WBC2, see above. The
// full-body rule holds under both), the body must carry
// every line that was stored — hence the GET-transform-POST round-trip via
// `fetchGroupBody`. A body rebuilt from the journal could silently drop
// worker cost rows (assignment records live only in extension memory), which
// would permanently destroy done-run cost history. Never rebuild: transform.
//
// Dependency contract (server/daemon.ts header, daemon.ts:1-11): this module
// imports ONLY `../run-state.ts` and types from `./push.ts` and
// `../aven/status.ts`. The `TicketProbe` import is TYPE-ONLY (erased at
// runtime), so no new runtime edge is added.
// No
// `@earendil-works/pi-coding-agent`, no `@gtheys/pi-interactive-subagents`,
// no `aven/client.ts` (it imports config.ts → pi-coding-agent at runtime), no
// `flow/cost.ts` (runtime dep on pi-interactive-subagents), no `config.ts`.
// NOTE: run-state.ts itself does runtime-import pi-coding-agent today
// (getAgentDir) — a pre-existing condition found in 1.2. server/daemon.ts's
// header contract was corrected for this in 2.2: what is enforceable is that
// the reconcile modules add NO NEW runtime dependency beyond run-state.ts +
// flow/push.ts + aven/status.ts (which is what this file does).
import type { TicketProbe } from '../aven/status.ts'
import {
  type FlowRunEvent,
  type LoopRunStatus,
  projectRunState,
  runTracking,
} from '../run-state.ts'
// AIDEV-NOTE: PMR-7B8M — TYPE-ONLY import by design. `ReconcileReport.daemonStaleness`
// below is an advisory, SESSION-SIDE-ONLY field: the daemon's own reconcile
// passes can never fill it (a daemon cannot judge its staleness against a
// session checkout — it does not know one), so it stays undefined on the
// daemon path and formatReconcileReport renders nothing. flow/reconcile.ts is
// daemon-reachable and node-only per the daemon DEPENDENCY CONTRACT (file
// header), so this module must gain NO runtime edge to
// server/staleness.ts (which value-imports session-side server/lifecycle.ts).
// test/cost-rows-node-only.test.ts strips type-only edges when it walks the
// runtime graph, which is exactly why this one is safe.
import type { DaemonStaleness } from '../server/staleness.ts'
import type { GroupBodyResult, PushResult } from './push.ts'

/** Liveness statuses that a tombstone retires.
 *  AIDEV-NOTE: EXPORTED because the gateway-less `--dry-run` half of
 *  `/flow-reconcile-push` (flow/reconcile-command.ts) decides with the SAME
 *  data this engine does. Keeping it private meant two places to update when a
 *  status is ever added, i.e. a dry-run that could disagree with the real
 *  pass. `livenessStatusOf` below is the shared projection rule. */
export const LIVENESS_STATUSES = ['halted', 'paused']

/** Ticket statuses that keep a halted/paused run LIVE (see computeStaleRefs
 *  docstring for the amendment evidence). */
export const LIVE_TICKET_STATUSES = ['active', 'todo']

/** The ONE aven fail-closed warning, exported for the same reason: both entry
 *  points must say the identical thing (the manual test counts it as exactly
 *  one user-visible warning). */
export const AVEN_FAILED_WARNING =
  'reconcile: aven ticket statuses unavailable — tombstoned nothing this pass (fail-closed)'

// AIDEV-NOTE (PMR-MSDJ fix round, P2-1 — bounded confirmation of a MISSING
// ref): "missing from the merged listing ⇒ stale" is EVIDENCE of a closed
// ticket, not PROOF of an absent one — `listTicketStatuses` merges only the
// two host-pinned workspaces, so a valid-but-incomplete universe (an
// `avenWorkspace` override to a third) reads as "gone" and would tombstone a
// LIVE run. So `runReconcilePass` asks aven about each unknown candidate
// DIRECTLY (`ticketStatusOf` in aven/status.ts), which bounds aven cost by the
// CANDIDATE count, not the run population: one shell-out when the first
// universe knows the ref, at most `workspaces + 1` when it is really gone. A
// null probe fails CLOSED PER REF — one bad shell-out costs one tombstone,
// not the pass. The probe can only ever VETO (it runs solely for refs the map
// already lacks), so it never widens the stale set. `scanWithoutGateway`
// (flow/reconcile-command.ts) does NOT probe: it reports unprobed dry-run
// candidates and never pushes, so its worst case is an over-reported line.
const INCONCLUSIVE_PROBE_REASON = 'aven lookup inconclusive'
const LIVE_ON_PROBE_REASON = 'ticket live on direct lookup'

/** The tombstone status value (label-VALUE-only addition; frozen labels). */
const STALE_STATUS = 'stale'

// AIDEV-NOTE (PMR-ZV9Y 7.1): the v1 line prefixes this engine used to key on
// (`pi_flow_run_status{`, `pi_flow_run_halt_reason{`) are gone with the retired
// v1 state vocabulary, so only the v2 state families below are targets now.

// AIDEV-NOTE (PMR-ZV9Y 3.2): the v2 state families get the SAME label-VALUE-only
// surgery as the v1 status line, for the same reason: renaming a metric or a
// label KEY would break the rebuilt boards, while flipping a VALUE retires the
// series because every v2 consumer (the Waiting-on-me queue, the halted rule)
// gates on `state="…"`. ISC-8. The two prefixes are disjoint by construction —
// `pi_flow_state_start_seconds{` never matches `pi_flow_state{` because the 12th
// char is `_`, not `{` — so one family can never shadow the other.
//
// The states the retired v1 rewrite used to retire were `halted|paused`. Its v2
// counterparts are `halted` (same word) plus the two wait states v1 collapsed
// into `paused`: `waiting_human` and `waiting_machine`. `running` and `done` are
// deliberately NOT targets, mirroring v1 exactly: v1 never tombstoned
// `status="running"|"done"`, and candidacy is JOURNAL-keyed
// (`livenessStatusOf` reads the v1 loop status), so a group whose stored body
// still shows a state the journal has moved past is reported "already clean"
// rather than half-retired — the P2-4 known limitation, held identical across
// both vocabularies on purpose. `stale` is the tombstone value itself, so
// re-running the pass over an already-tombstoned body stays a no-op.
const V2_STATE_METRICS = ['pi_flow_state{', 'pi_flow_state_start_seconds{']
const V2_LIVENESS_STATES = ['halted', 'waiting_human', 'waiting_machine']

/**
 * The liveness status a journal projects, or null when the run is NOT a
 * reconcile candidate: no projection, no loop state, or a status outside
 * `LIVENESS_STATUSES` (a `running` run is never retired; an unprojectable or
 * empty journal is not either).
 *
 * Exported because `/flow-reconcile-push --dry-run` without a gateway runs
 * exactly this filter and nothing else — one rule, two surfaces.
 */
export function livenessStatusOf(
  events: readonly FlowRunEvent[],
): LoopRunStatus | null {
  const status = projectRunState(events)?.loop?.status
  if (status === undefined) return null
  if (!LIVENESS_STATUSES.includes(status)) return null
  return status
}

/**
 * Pure liveness rule (interview decision 2, AMENDED in 2.3 smoke): a
 * halted/paused journal run is LIVE while its aven ticket status is
 * `active` OR `todo`. Anything else — backlog/inbox/done/canceled, or the
 * ticket missing from the listing — makes the ref stale. `ticketStatus ===
 * null` means aven could not be consulted, which fails CLOSED: nothing is
 * tombstoned on a guess.
 *
 * AIDEV-NOTE (amendment evidence, 2026-11-24): the first live dry-run listed
 * PMR-MSDJ's OWN in-flight run as a stale candidate — its journal's last
 * loop state is `paused` (waiting at the plan-approval gate) while its
 * ticket sits in `todo`, because the flow loop never moves the ticket to
 * `active` before implement. Under active-only the daemon would tombstone
 * runs that are merely gate-waiting. The user's original criterion was
 * "done or canceled must not fire" — `todo` is neither, so todo stays live.
 * backlog/inbox stay stale: an abandoned run parked in backlog (the
 * PMR-C0WG incident) must not page.
 *
 * @param journalStates ref → projected `loop.status` (only `halted`/`paused`
 * entries are candidates; any other value is ignored defensively).
 * @returns stale refs in the journal map's iteration order.
 */
export function computeStaleRefs(
  journalStates: Map<string, string>,
  ticketStatus: Map<string, string> | null,
): string[] {
  if (ticketStatus === null) return []
  const stale: string[] = []
  for (const [ref, status] of journalStates) {
    if (!LIVENESS_STATUSES.includes(status)) continue
    if (LIVE_TICKET_STATUSES.includes(ticketStatus.get(ref) ?? '')) continue
    stale.push(ref)
  }
  return stale
}

/**
 * Pure line-wise transform of a group body read back from the gateway: rewrite
 * `state="halted"` / `state="waiting_human"` / `state="waiting_machine"` to
 * `state="stale"` on `pi_flow_state` and `pi_flow_state_start_seconds` lines and
 * keep every other byte. Returns `null` when nothing was rewritten (already
 * clean, already tombstoned, a running/done run, or the group is gone) —
 * callers skip those so a body is never re-posted unchanged.
 *
 * AIDEV-NOTE (PMR-ZV9Y 7.1): used to also rewrite `status="halted"|"paused"` on
 * `pi_flow_run_status` and DROP every `pi_flow_run_halt_reason` line. Both
 * behaviours disappeared with the v1 state vocabulary — the lines are no longer
 * rendered, and a drop is exactly what the merge-on-write homelab gateway could
 * not honour anyway (PMR-WBC2), so removing it loses nothing. `livenessStatusOf`
 * below still decides candidacy from the JOURNAL's v1 loop status, which is
 * untouched by this retirement (LoopStateRecord / LoopRunStatus stay, plan D2).
 *
 * AIDEV-NOTE (PMR-ZV9Y 3.2): since the v2 gauges render into the SAME push
 * body (flow/run-health.ts), the pass flips
 * `state="halted"|"waiting_human"|"waiting_machine"` to `state="stale"` on
 * `pi_flow_state` and `pi_flow_state_start_seconds` lines (ISC-8), so the
 * Waiting-on-me queue and the halted rule retire with a closed run instead of
 * keeping it on the board. AIDEV-NOTE (PMR-ZV9Y fix round 1, P3a — corrected
 * the earlier "every other family is byte-identical" wording, which wrongly
 * listed `pi_flow_step`): beyond the two value flips this pass DROPS the
 * transient `pi_flow_step{…}` open-step gauge (no state label, meaning
 * definitively false for a retired run — see the file header P3a note for the
 * why and the merge-vs-replace posture). Every OTHER v2 family
 * (`pi_flow_phase`, `pi_flow_wait_seconds`, `pi_flow_step_seconds`) plus all
 * counters and cost rows is re-emitted byte-identical: label VALUES move on the
 * state lines, the open-step gauge is dropped, and `pi_flow_step_seconds` (the
 * cumulative bucket) stays.
 *
 * The rewrite is minimal substring surgery inside the label section: label
 * ORDER (the gateway emits them alphabetically, e.g.
 * `{job="pi-flow",mode="work",ref="X",state="halted"}`), all sibling labels
 * and the trailing value must survive byte-identical.
 */
export function tombstoneBody(body: string): string | null {
  const out: string[] = []
  let rewrites = 0
  for (const line of body.split('\n')) {
    if (startsWithAny(line, V2_STATE_METRICS)) {
      const rewritten = swapLabelValue(line, 'state', V2_LIVENESS_STATES)
      if (rewritten !== null) {
        out.push(rewritten)
        rewrites += 1
        continue
      }
    }
    out.push(line)
  }
  if (rewrites === 0) return null
  // AIDEV-NOTE (PMR-ZV9Y fix round, P3a — tombstone-side decision): a tombstone
  // retires the run to `stale`, so the OPEN-step gauge `pi_flow_step{…} 1` — the
  // one v2 family with NO state label whose meaning ("a step is in flight
  // right now") is definitively false for a retired run — is DROPPED from the
  // re-POSTed body. It cannot be value-flipped to stale like the state pair
  // because it carries no state label; dropping is the only lever, and it runs
  // ONLY here (rewrites > 0 guarantees the same body already flips a state line
  // to stale, so the drop never happens without a tombstone). Correct under the
  // official Pushgateway Replace semantics the round-trip assumes; on the
  // merge-on-write homelab gateway (PMR-WBC2) it degrades to a harmless no-op
  // exactly like the retired halt_reason drop. The PRIMARY fix is the render-
  // side suppression in flow/state-metrics.ts `isTerminalState`; this is the
  // belt-and-braces half that also cleans an ALREADY-STORED phantom on a
  // replace-semantic gateway. The `{` is load-bearing: it matches only
  // `pi_flow_step{…}`, never `pi_flow_step_seconds{…}`, which stays.
  const dropped: string[] = []
  for (const line of out) {
    if (line.startsWith('pi_flow_step{')) continue
    dropped.push(line)
  }
  return dropped.join('\n')
}

function startsWithAny(line: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (line.startsWith(prefix)) return true
  }
  return false
}

/** Rewrite one `<key>="<retired>"` label to `<key>="stale"`. Returns null when
 *  the line carries no retired value for that key. Only label tokens are
 *  touched: a `key="…"`-shaped sequence inside another label's VALUE (the
 *  gateway escapes those as `\"`) or a longer label name ending in the same
 *  characters is left alone. */
function swapLabelValue(
  line: string,
  key: string,
  retired: readonly string[],
): string | null {
  const open = line.indexOf('{')
  const close = line.lastIndexOf('}')
  if (open < 0 || close <= open) return null
  const inner = line.slice(open + 1, close)
  const token = `${key}="`
  let labels = ''
  let i = 0
  let changed = 0
  while (i < inner.length) {
    const at = inner.indexOf(token, i)
    if (at < 0) {
      labels += inner.slice(i)
      break
    }
    // A label token starts at the beginning of the section or after a comma.
    if (at !== 0 && inner[at - 1] !== ',') {
      labels += inner.slice(i, at + token.length)
      i = at + token.length
      continue
    }
    const valueStart = at + token.length
    const valueEnd = inner.indexOf('"', valueStart)
    if (valueEnd < 0) {
      labels += inner.slice(i)
      break
    }
    const value = inner.slice(valueStart, valueEnd)
    labels += inner.slice(i, at)
    if (retired.includes(value)) {
      labels += `${key}="${STALE_STATUS}"`
      changed += 1
    } else {
      labels += inner.slice(at, valueEnd + 1)
    }
    i = valueEnd + 1
  }
  if (changed === 0) return null
  return `${line.slice(0, open + 1)}${labels}${line.slice(close)}`
}

/** Defaults for a best-effort daemon: reconcile on, every 6 hours. */
// AIDEV-NOTE: PMR-MSDJ (2.1) — these defaults are the daemon half of a
// DELIBERATE two-reader split over the same `<agentDir>/pi-flow/config.json`.
// `config.ts` PiFlowConfigSchema + resolveReconcileSettings are the typed
// extension half and must return the identical `{ enabled: true,
// intervalMinutes: 360 }` for an absent block (pinned by test/config.test.ts).
// This function stays here, not delegating to config.ts, because the daemon
// must remain node-only AND must not throw on a broken file — it warns and
// keeps retires running instead.
const DEFAULT_SETTINGS = { enabled: true, intervalMinutes: 360 }

/**
 * Parse the `reconcile` block out of RAW config file text
 * (`<agentDir>/pi-flow/config.json`). The daemon has no session cwd, so it
 * reads the global file only and cannot use `config.ts` (which imports
 * pi-coding-agent); this is the deliberately tolerant, fail-to-defaults
 * version of that boundary. Malformed JSON, wrong shapes or an unusable
 * interval fall back to the defaults AND return a `warning` the daemon logs —
 * a broken config must not silently disable retires, and must not crash the
 * daemon.
 */
export function parseReconcileSettings(raw: string | null): {
  enabled: boolean
  intervalMinutes: number
  warning?: string
} {
  if (raw === null || raw.trim().length === 0) {
    return { ...DEFAULT_SETTINGS }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return warned('reconcile: config file is not valid JSON')
  }
  if (!isRecord(parsed))
    return warned('reconcile: config file is not an object')
  if (parsed.reconcile === undefined) return { ...DEFAULT_SETTINGS }
  if (!isRecord(parsed.reconcile)) {
    return warned('reconcile: "reconcile" is not an object')
  }
  const block = parsed.reconcile
  const settings: { enabled: boolean; intervalMinutes: number } = {
    ...DEFAULT_SETTINGS,
  }
  if (block.enabled !== undefined) {
    if (typeof block.enabled !== 'boolean') {
      return warned('reconcile: "enabled" is not a boolean')
    }
    settings.enabled = block.enabled
  }
  if (block.intervalMinutes !== undefined) {
    const minutes = block.intervalMinutes
    if (
      typeof minutes !== 'number' ||
      !Number.isFinite(minutes) ||
      minutes < 1
    ) {
      return warned('reconcile: "intervalMinutes" is not a number >= 1')
    }
    settings.intervalMinutes = minutes
  }
  return settings
}

function warned(warning: string): {
  enabled: boolean
  intervalMinutes: number
  warning: string
} {
  return { ...DEFAULT_SETTINGS, warning }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Injected IO for one reconcile pass. Everything impure lives here so the
 *  engine stays node-only and testable with fakes. */
export interface ReconcileDeps {
  /** Refs (journal basenames) to scan — the daemon readdir's `runsDir`. */
  listJournalRefs(): Promise<string[]>
  /** Journal events for a ref, or null when the journal is unreadable. */
  readRunEvents(ref: string): Promise<readonly FlowRunEvent[] | null>
  /** ref → aven ticket status, or null when aven is unreachable (fail-closed:
   *  the engine then tombstones nothing and warns once). */
  listTicketStatuses(): Promise<Map<string, string> | null>
  /** Direct answer about ONE ref the merged listing does not know (P2-1).
   *  Null (aven unreachable/anomalous) fails CLOSED for that ref: skip with
   *  'aven lookup inconclusive' rather than tombstone a ticket we cannot see. */
  ticketStatusOf(ref: string): Promise<TicketProbe | null>
  /** Read one stored Pushgateway group back (full-dump GET + filter). */
  fetchGroupBody(
    trackRef: string,
    mode: 'work' | 'personal',
  ): Promise<GroupBodyResult>
  /** Replace a group with the tombstoned body (POST to the same group URL). */
  pushTombstone(
    trackRef: string,
    mode: 'work' | 'personal',
    body: string,
  ): Promise<PushResult>
  warn(message: string): void
}

export interface ReconcileStaleEntry {
  ref: string
  journalStatus: string
  ticketStatus: string | undefined
}

export interface ReconcileSkipEntry {
  ref: string
  reason: string
}

export interface ReconcileReport {
  /** Journals examined (refs from `listJournalRefs`). */
  scanned: number
  /** Journals projecting a halted/paused loop status. */
  candidates: number
  /** Refs judged stale (ticket no longer active). In dry-run this is the
   *  whole answer — `tombstoned` stays empty. */
  stale: ReconcileStaleEntry[]
  /** Refs whose group was replaced with the tombstoned body. */
  tombstoned: string[]
  /** Refs deliberately not tombstoned, with the reason. */
  skipped: ReconcileSkipEntry[]
  /** aven could not be consulted ⇒ zero tombstones this pass. */
  avenFailed: boolean
  /** Echo of the dry-run flag (so callers can render one message shape). */
  dryRun: boolean
  /**
   * Daemon staleness verdict — filled ONLY by the session-side command
   * (`/flow-reconcile-push`, PMR-7B8M), NEVER by `runReconcilePass`: the
   * daemon cannot judge its own staleness (no session checkout to compare
   * against), so on the daemon path this stays undefined and
   * `formatReconcileReport` renders no line. Session-side only — see the
   * type-only import of `DaemonStaleness` at the top of this file.
   */
  daemonStaleness?: DaemonStaleness
}

/**
 * One reconcile pass. IO-free decisions are the exported pure functions
 * above; this orchestrates them and keeps warnings bounded (at most
 * `stale.length + 1` lines plus one per ref whose direct lookup came back
 * inconclusive, and aven failure short-circuits before any gateway call).
 */
export async function runReconcilePass(
  deps: ReconcileDeps,
  opts?: { dryRun?: boolean },
): Promise<ReconcileReport> {
  const dryRun = opts?.dryRun === true
  const report: ReconcileReport = {
    scanned: 0,
    candidates: 0,
    stale: [],
    tombstoned: [],
    skipped: [],
    avenFailed: false,
    dryRun,
  }
  const refs = await deps.listJournalRefs()
  report.scanned = refs.length
  const journalStates = new Map<string, string>()
  const eventsByRef = new Map<string, readonly FlowRunEvent[]>()
  for (const ref of refs) {
    const events = await deps.readRunEvents(ref)
    if (events === null) continue
    const status = livenessStatusOf(events)
    if (status === null) continue
    // AIDEV-NOTE: PMR-MSDJ 2.2 — the candidate filter is deliberately
    // MODE-AGNOSTIC; this closes the TODO 2.1 left for the orchestrator, whose
    // decision is recorded here (do not "fix" it by adding `mode === 'work'`).
    // Plan PMR-V36Y decision 6's OPERATIVE rule is the one 1.3 implemented and
    // the plan text was patched to before approval (interview Q2): a ref is a
    // candidate when ITS JOURNAL projects a halted/paused loop state — in ANY
    // mode — and liveness is then decided solely by the aven ticket map, where
    // a MISSING ticket is stale. Consequences, both user-approved:
    //  • TP-* personal runs carry no loop-state journal at all (the loop only
    //    snapshots for flow-driven runs), so they never reach this filter and
    //    ISC-5 ("personal runs never tombstoned") holds in practice;
    //  • a personal-mode run that DOES have a halted/paused journal but no
    //    aven ticket tombstones under the missing-ticket rule — that is the
    //    approved behaviour, and test/reconcile.test.ts
    //    ("personal-mode stale run uses the personal group") pins it
    //    deliberately. `mode` plays no part in the decision; `runTracking`
    //    below uses it only to pick the group URL suffix (work adds
    //    /mode/work), so the tombstone replaces the RIGHT group.
    // AIDEV-NOTE (PMR-MSDJ review P2-4, KNOWN LIMITATION — documented, not
    // fixed): journal-keyed candidacy can NEVER retire a Pushgateway group the
    // journal no longer names — e.g. a work group exporting
    // `ref="DP-253",mode="work"` at status="paused" whose journal now projects
    // `running` under another ref (AA-SG9T), or a resumed run that keeps its
    // `paused` series until the NEXT terminal transition. A gateway-side sweep
    // (decide from the dump's halted/paused groups instead) is out of scope: a
    // stored group carries no journal identity beyond its `ref` label, so
    // sweeping means guessing the journal, and a ref-less sweep reaches adhoc
    // runs and other jobs' groups. README's Reconcile section says the same.
    journalStates.set(ref, status)
    eventsByRef.set(ref, events)
  }
  report.candidates = journalStates.size
  if (report.candidates === 0) return report

  const ticketStatus = await deps.listTicketStatuses()
  if (ticketStatus === null) {
    deps.warn(AVEN_FAILED_WARNING)
    report.avenFailed = true
    return report
  }

  for (const ref of computeStaleRefs(journalStates, ticketStatus)) {
    const journalStatus = journalStates.get(ref)
    const events = eventsByRef.get(ref)
    if (journalStatus === undefined || events === undefined) continue
    let ticketStatusOfRef = ticketStatus.get(ref)
    if (ticketStatusOfRef === undefined) {
      // P2-1: one direct question to aven before a listing gap costs a live
      // run its metrics.
      const probe = await deps.ticketStatusOf(ref)
      if (probe === null) {
        report.skipped.push({ ref, reason: INCONCLUSIVE_PROBE_REASON })
        deps.warn(
          `reconcile ${ref}: ${INCONCLUSIVE_PROBE_REASON} — skipped fail-closed`,
        )
        continue
      }
      if (probe.kind === 'ticket') {
        if (LIVE_TICKET_STATUSES.includes(probe.status)) {
          report.skipped.push({ ref, reason: LIVE_ON_PROBE_REASON })
          continue
        }
        ticketStatusOfRef = probe.status
      }
    }
    report.stale.push({ ref, journalStatus, ticketStatus: ticketStatusOfRef })
    // The group identity comes from the journal (same derivation as cost
    // pushes), so the tombstone REPLACES the right group instead of creating
    // a duplicate personal one.
    const tracking = runTracking(events, ref)
    const fetched = await deps.fetchGroupBody(tracking.trackRef, tracking.mode)
    if (fetched.ok === false) {
      report.skipped.push({ ref, reason: fetched.error })
      deps.warn(`reconcile ${ref}: reading the group failed: ${fetched.error}`)
      continue
    }
    const tombstone = tombstoneBody(fetched.body)
    if (tombstone === null) {
      report.skipped.push({ ref, reason: 'already clean' })
      continue
    }
    if (dryRun) continue
    const pushed = await deps.pushTombstone(
      tracking.trackRef,
      tracking.mode,
      tombstone,
    )
    if (pushed.ok === true) {
      report.tombstoned.push(ref)
      continue
    }
    const reason = pushed.error ?? 'pushgateway POST failed'
    report.skipped.push({ ref, reason })
    deps.warn(`reconcile ${ref}: tombstone push failed: ${reason}`)
  }
  return report
}
