// AIDEV-NOTE (PMR-MSDJ 1.4, plan PMR-V36Y decision 2): daemon-safe aven
// ticket STATUS map — the liveness rule for the pushgateway reconcile. A
// halted/paused journal run counts as LIVE only while its aven ticket status
// is `active`; everything else (inbox/backlog/todo/done/canceled, or the ref
// missing from the map) is stale and gets tombstoned.
//
// This file deliberately MIRROWS aven/client.ts's conventions (the
// `AvenRunner` contract, `avenExec`'s execFile + 5s timeout, and the
// fail-closed classify discipline of classifyListHead/classifyOpenTicketRefs
// — ISC-13) WITHOUT importing it: client.ts imports config.ts, which
// runtime-imports `@earendil-works/pi-coding-agent`. server/daemon.ts's
// header contract forbids that on the daemon path, so everything reachable
// from the reconcile engine stays node-built-ins-only. `AvenRunner` is
// re-declared here (structurally identical to client.ts's, so session-side
// callers can pass `avenExec` straight in); spec-review/aven-spec.ts is also
// NOT reused for the same reason — the `/^(Error:|error\s)/` text check is
// duplicated instead.
//
// Fail-closed semantics (same as classifyOpenTicketRefs, PMR-384R): aven
// exits 0 on its own errors, so NOTHING here trusts the exit code. ANY
// anomaly — error text on stdout or stderr, non-JSON, non-array schema drift,
// or an entry lacking a usable `ref`/`status` — returns null, never a partial
// Map. A partial Map would be read as "this ticket is gone" and wrongly
// tombstone a live run's metrics, which is the exact failure mode decision 2
// guards against. An empty Map at the PARSE level comes only from a
// successfully parsed empty array, but an empty MERGED universe is treated as
// an anomaly (null) — see the P2-2 guard in listTicketStatuses. null carries
// no reason string: the engine warns once per pass on null (see
// flow/reconcile.ts), so no client.ts-style recordAvenFailure store is
// mirrored here.
//
// Consumer: flow/reconcile.ts runReconcilePass — ONE listTicketStatuses()
// call per pass (which is TWO aven shell-outs), injected as
// ReconcileDeps.listTicketStatuses, PLUS one bounded ticketStatusOf() probe
// per candidate the listing does not know (see P2-1 below).
//
// Pinned against the real CLI (aven 0.1.54, output captured 2026-11-24):
// `aven list --all-projects … --json` prints a JSON ARRAY of ticket objects
// whose fields are `ref` (string, e.g. "PMR-62EN") and `status` (string,
// one of inbox|backlog|todo|active|done|canceled). DONE AND CANCELED TICKETS
// DO APPEAR in the listing (live measurement: 809 entries — 702 done, 27
// canceled, 59 backlog, 15 inbox, 4 todo, 2 active), so the map carries
// closed statuses and computeStaleRefs reads them directly. Active tickets
// always appear (verified). A ref the listing omits is only a STALE candidate
// — `ticketStatusOf` below is what turns that evidence into a decision.
//
// AIDEV-NOTE (PMR-MSDJ 1.4, workspace pinning — the fix for the cwd-routing
// hazard first measured here): `aven list` is WORKSPACE-ROUTE DEPENDENT even
// with
// `--all-projects`, because aven resolves the workspace from process.cwd()
// through ~/.config/aven/config.yaml `workspace.routes`. Measured live: cwd
// `<home>/Code/personal` → workspace "projects" (809 tickets), but a herdr
// worktree under `~/.herdr/worktrees` is UNROUTED and falls back to the
// "default" workspace (1 ticket). The unrouted listing is perfectly valid
// JSON, so fail-closed null CANNOT catch it — every real ref would read as
// "missing ⇒ stale" and the reconcile would tombstone LIVE runs, the one
// thing decision 2 forbids. A daemon's cwd is wherever pi happened to start,
// so this module never relies on cwd routing: it pins `--workspace` and
// shells out ONCE PER KNOWN WORKSPACE (see AVEN_TICKET_WORKSPACES), merging
// the results. Flow refs live in both: PMR-* personal tickets in "projects",
// Jira-pulled local epics in "salaryhero".
//
// Consequences of the pin, all deliberate:
//   • TWO shell-outs per pass, so the worst-case stall is 2 x timeout
//     (10s at 5s each) — irrelevant for a 6h timer and a manual command;
//   • ANY failure in EITHER call fails the WHOLE map closed to null (no
//     partial merge — a half universe produces exactly the false-stale the
//     pin exists to prevent);
//   • therefore a machine that lacks one of these workspaces tombstones
//     nothing and warns once per pass: `aven list --workspace nosuchws` exits
//     1 with `Error: … unknown-workspace …` on stderr, which rejects
//     execFileAsync ⇒ null. That is the safe direction, but it DOES mean the
//     workspace list below is host-assumed — adjust the const (or have 2.2/2.3
//     pass a configured list) rather than adding a cwd fallback.
//
// AIDEV-NOTE (PMR-MSDJ fix round, P2-1 — the hole this closes): an
// `avenWorkspace` config override to a THIRD workspace does NOT reject: both
// pinned listings succeed, the merge is a valid Map that simply lacks the
// run's ref, and the old "missing ⇒ stale" rule tombstoned a LIVE run. That
// is why the engine no longer treats a missing entry as sufficient evidence:
// `ticketStatusOf` below is a bounded, per-candidate confirmation with VETO
// authority only (it is consulted for refs the map already lacks, so it can
// remove a tombstone, never add one — verified against the real CLI: a live
// `todo` ticket in `projects` reads back as `ticket`, an absent ref as
// `missing`, a prefix-matched one as inconclusive null). It is
// workspace-EXPLICIT for the SAME reason the listing is: measured here, an
// un-pinned `aven show PMR-MSDJ --json` from a herdr worktree answers
// `unknown-ref` on a LIVE ticket (the cwd falls back to the 1-ticket
// `default` workspace), so one un-pinned shell-out would have made the veto a
// silent no-op. RESIDUAL: a workspace that is neither pinned nor reachable
// from the daemon's cwd stays invisible to BOTH calls, so such a ref still
// reads as missing — the structural fix is threading the configured
// `avenWorkspace` into AVEN_TICKET_WORKSPACES, which needs a session-side
// `loadConfig` read that the node-only daemon contract forbids (see
// flow/reconcile-deps.ts's P2-1 note).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Same ceiling as aven/client.ts's AVEN_TIMEOUT_MS (client.ts:20). */
const AVEN_TIMEOUT_MS = 5_000

// AIDEV-NOTE: 16 MiB execFile buffer, not the 1 MiB default. The full
// `--all-projects --json` dump measured 698 KB / 809 tickets on 2026-11-24;
// at the default ceiling the list would soon start failing with ENOBUFS,
// which classifies as null and silently disables tombstoning forever.
const AVEN_LIST_MAX_BUFFER = 16 * 1024 * 1024

// AIDEV-NOTE: the workspaces that can hold a flow ref, in merge order (LAST
// WINS on a ref collision — see listTicketStatuses). Measured 2026-11-24 the
// two universes are disjoint (809 `projects` refs, 88 `salaryhero` refs, 0
// shared), so the tie-break is defensive only; `salaryhero` comes last so a
// collision resolves to the WORK-mode status, which is what a work-mode run's
// liveness must key on.
const AVEN_TICKET_WORKSPACES = ['projects', 'salaryhero']

/**
 * Local mirror of aven/client.ts's `AvenRunner` contract (client.ts:22-24),
 * re-declared so the daemon path stays node-only. Structurally identical:
 * `avenExec` from client.ts satisfies it.
 */
export type AvenRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

/** The production runner: one `aven <args>` shell-out, used by both the
 *  pinned `list` calls and the single-ref `show` probe. */
export const avenListExec: AvenRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('aven', [...args], {
    timeout: AVEN_TIMEOUT_MS,
    maxBuffer: AVEN_LIST_MAX_BUFFER,
  })
  return { stdout, stderr }
}

/** aven's unknown-ref marker (flow/aven-resolve.ts isUnknownRef): seen on
 *  stderr as `error unknown-ref input=<ref>`, exit 1 — and, like every aven
 *  error, sometimes with exit 0. */
const UNKNOWN_REF_MARKER = 'unknown-ref'

/**
 * Classify one `aven list … --json` output as a ref → status map. Returns
 * null on ANY anomaly (see the file header for the fail-closed contract);
 * an empty Map means aven really has no tickets in that workspace.
 */
export function classifyTicketStatuses(
  stdout: string,
  stderr: string,
): Map<string, string> | null {
  // avenErrorText pattern (spec-review/aven-spec.ts:37-44), inlined: aven
  // prints domain errors WITH EXIT 0, so classify by text on either stream.
  const lines = [...stdout.split('\n'), ...stderr.split('\n')]
  if (lines.some((line) => /^(Error:|error\s)/.test(line.trim()))) {
    return null
  }
  // aven's own CLI errors print lowercase `error: …` on stderr, which the
  // pattern above does not match (`error` + `:`). Trim first (PMR-NPFR): an
  // indented error line evaded both checks once and silently passed through.
  if (stderr.split('\n').some((line) => /^error\b/.test(line.trim()))) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const statuses = new Map<string, string>()
  for (const entry of parsed) {
    // Unlike extractListRefs (client.ts:493-501), which SKIPS entries with no
    // usable ref, every anomaly here fails the WHOLE map closed: a dropped
    // entry looks exactly like a closed ticket to computeStaleRefs, and that
    // guess would tombstone a live run.
    if (typeof entry !== 'object' || entry === null) return null
    const { ref, status } = entry as { ref?: unknown; status?: unknown }
    if (typeof ref !== 'string' || ref.length === 0) return null
    if (typeof status !== 'string' || status.length === 0) return null
    statuses.set(ref, status)
  }
  return statuses
}

/**
 * One workspace's ref → status map, or null when that workspace could not be
 * listed or its output is anomalous.
 */
async function listWorkspaceTicketStatuses(
  runner: AvenRunner,
  workspace: string,
): Promise<Map<string, string> | null> {
  try {
    const out = await runner([
      'list',
      '--all-projects',
      '--workspace',
      workspace,
      '--json',
    ])
    return classifyTicketStatuses(out.stdout, out.stderr)
  } catch {
    // execFileAsync rejects on spawn failure, non-zero exit (an unknown
    // workspace exits 1 with `Error: … unknown-workspace …`), and timeout —
    // all the same answer: the status universe is unverifiable.
    return null
  }
}

/**
 * Ref → aven ticket status over EVERY workspace a flow ref can live in, or
 * null when aven is unreachable / anomalous in any of them (fail-closed —
 * the reconcile tombstones nothing on a null and warns once per pass).
 * Workspace-EXPLICIT by design: `--all-projects` alone still routes by
 * process.cwd(), which a daemon cannot trust (see the header AIDEV-NOTE).
 * Two shell-outs per call; neither is merged until both succeed.
 *
 * @param runner injectable for tests; defaults to {@link avenListExec}.
 */
export async function listTicketStatuses(
  runner: AvenRunner = avenListExec,
): Promise<Map<string, string> | null> {
  const listings: Map<string, string>[] = []
  for (const workspace of AVEN_TICKET_WORKSPACES) {
    const listing = await listWorkspaceTicketStatuses(runner, workspace)
    if (listing === null) return null
    listings.push(listing)
  }
  const merged = new Map<string, string>()
  for (const listing of listings) {
    for (const [ref, status] of listing) merged.set(ref, status)
  }
  // AIDEV-NOTE (PMR-MSDJ fix round, P2-2 — mass false-stale guard): every
  // workspace answering ZERO tickets is not a real "no tickets" answer on a
  // host that holds ~900 — it is aven failing in a way that still parses
  // (this file's own threat model is "aven exits 0 on its own errors"). An
  // empty Map reads to computeStaleRefs as "every ticket is gone", so one
  // such pass would tombstone EVERY halted/paused run at once. Fail closed
  // instead: null ⇒ the engine tombstones nothing and warns once.
  // One EMPTY workspace alongside a populated one stays a real answer.
  if (merged.size === 0) return null
  return merged
}

/**
 * Outcome of the bounded single-ref confirmation (P2-1): either aven knows
 * the ticket (`ticket`, with its status) or it definitively does not
 * (`missing`, aven's own `unknown-ref`). `null` is NOT an answer — it is an
 * inconclusive lookup (spawn/timeout/other error text, non-JSON, schema
 * drift, or a prefix-matched ref that belongs to a DIFFERENT ticket), and the
 * engine must not tombstone on it.
 */
export type TicketProbe =
  | { readonly kind: 'ticket'; readonly status: string }
  | { readonly kind: 'missing' }

/** Text of an execFile rejection: aven's error rides on stderr (or the
 *  message, which promisify prefixes with the command plus both streams). */
function rejectionText(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string' && stderr.length > 0) return stderr
  return error instanceof Error ? error.message : `${error}`
}

/**
 * Ask aven DIRECTLY about one ref: `aven show <ref> --json`, workspace-EXPLICIT
 * like {@link listTicketStatuses} and for the same measured reason — an
 * unpinned `show` is cwd-route dependent, and the probe was verified against
 * the real CLI to answer `unknown-ref` for LIVE tickets from an unrouted cwd
 * (a herdr worktree falls back to the 1-ticket `default` workspace). Since
 * "missing" is the answer that costs a tombstone, the probe consults the same
 * universes the listing does PLUS aven's own cwd-routed default (which is how
 * an `avenWorkspace` override reaches its tickets), and only calls a ref
 * `missing` when EVERY universe answered `unknown-ref`. First exact hit wins,
 * so a normally-placed ref costs ONE shell-out; the worst case is
 * `AVEN_TICKET_WORKSPACES.length + 1` per missing candidate, still bounded by
 * the candidate count and irrelevant for a 6 h timer or a manual pass.
 *
 * This exists to VETO false stales, never to create them: it is consulted
 * only for refs the merged map already lacks, so every answer is at worst the
 * pre-P2-1 behaviour and at best a live run keeps its metrics.
 *
 * Fail-closed discipline, identical to classifyTicketStatuses: only a parsed
 * ticket whose ref matches the request EXACTLY (case-insensitively; PMR-F8HB:
 * aven prefix-matches, so `aven show PMR-TPN` happily returns `PMR-TPN7`, and
 * another ticket's status is not an answer about this one) with a non-empty
 * string `status` counts as an answer, and only aven's own `unknown-ref`
 * marker counts as `missing`. EVERYTHING else — spawn/timeout, other error
 * text, non-JSON, schema drift, a fuzzy-matched ref — returns null, and a
 * null on ANY universe makes the whole probe inconclusive rather than
 * silently narrowing the evidence.
 *
 * @param runner injectable for tests; defaults to {@link avenListExec}.
 */
export async function ticketStatusOf(
  ref: string,
  runner: AvenRunner = avenListExec,
): Promise<TicketProbe | null> {
  const universes: (string | undefined)[] = [...AVEN_TICKET_WORKSPACES]
  // The cwd-routed default LAST: it is the only universe that can see an
  // `avenWorkspace` override, and a hit anywhere else already answers.
  universes.push(undefined)
  let sawUnknownRef = false
  for (const workspace of universes) {
    const probe = await showTicketStatus(runner, ref, workspace)
    if (probe === null) return null
    if (probe.kind === 'ticket') return probe
    sawUnknownRef = true
  }
  return sawUnknownRef ? { kind: 'missing' } : null
}

/** One `aven show <ref> --json` against one workspace universe (undefined =
 *  let aven resolve it from cwd). */
async function showTicketStatus(
  runner: AvenRunner,
  ref: string,
  workspace: string | undefined,
): Promise<TicketProbe | null> {
  const args = ['show', ref, '--json']
  if (workspace !== undefined) args.push('--workspace', workspace)
  let stdout = ''
  let stderr = ''
  try {
    const out = await runner(args)
    stdout = out.stdout
    stderr = out.stderr
  } catch (error) {
    // execFileAsync rejects on spawn failure, timeout and aven's exit 1.
    // Only the unknown-ref marker is a real "there is no such ticket" answer.
    return rejectionText(error).includes(UNKNOWN_REF_MARKER)
      ? { kind: 'missing' }
      : null
  }
  // aven prints errors with exit 0, so classify the TEXT before trusting the
  // payload (ISC-13): unknown-ref => missing, any other error text => null.
  if (
    stderr.includes(UNKNOWN_REF_MARKER) ||
    stdout.includes(UNKNOWN_REF_MARKER)
  ) {
    return { kind: 'missing' }
  }
  if (avenErrorText(stdout, stderr)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as { ref?: unknown; status?: unknown }
  if (typeof record.ref !== 'string' || record.ref.length === 0) return null
  if (record.ref.toUpperCase() !== ref.toUpperCase()) return null
  if (typeof record.status !== 'string' || record.status.length === 0) {
    return null
  }
  return { kind: 'ticket', status: record.status }
}

// AIDEV-NOTE (PMR-STDK): avenErrorText and classifyTicketStatuses each carry
// the fail-closed error-text rule, and they are DELIBERATELY not the same
// predicate. Do NOT consolidate them into one shared helper: it is
// correctness/security-critical (a missed error line reads as a live ticket
// and skips a tombstone, or the inverse), and unifying two slightly different
// strictness levels is riskier than keeping two local copies.
//
// HOW the in-file copy differs from classifyTicketStatuses's inline rule:
//   • classifyTicketStatuses checks `^(Error:|error\s)` across BOTH streams but
//     the `^error\b` anchor on STDERR ONLY (stdout is the JSON payload, so a
//     bare `error:` token there is tolerated until the JSON.parse fails closed).
//   • avenErrorText applies `^(Error:|error\s)` AND `^error\b` to BOTH streams,
//     so it is the STRICTER superset — a stdout line like `error: ...` trips it
//     but not classifyTicketStatuses. Its caller (showTicketStatus, line ~343)
//     reads a single-ticket show payload where the error can ride on either
//     stream, hence the wider net.
// WHAT MUST STAY IN SYNC: the two core `^(Error:|error\s)` patterns and the
// "any error text on either stream => fail closed, never trust the exit code"
// contract (aven exits 0 on its own errors). If one caller's `Error:` /
// `error ` shape changes, audit the other in the same edit; the `^error\b`
// stream scope is the ONLY intended divergence.
/** The aven error-text rule (`Error:` / `error ` / indented `error:`) that
 *  classifyTicketStatuses applies inline, in one pass: returns the offending
 *  line, or null when neither stream carries one. NOT shared with
 *  spec-review/aven-spec.ts for the reason the file header gives — that
 *  module imports aven/client.ts, which runtime-imports pi-coding-agent. */
function avenErrorText(stdout: string, stderr: string): string | null {
  for (const line of [...stdout.split('\n'), ...stderr.split('\n')]) {
    const trimmed = line.trim()
    if (/^(Error:|error\s)/.test(trimmed)) return trimmed
    if (/^error\b/.test(trimmed)) return trimmed
  }
  return null
}
