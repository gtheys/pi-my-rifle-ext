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
// guards against. An empty Map comes only from a successfully parsed empty
// array (a real zero-ticket answer). null carries no reason string: the
// engine warns once per pass on null (see flow/reconcile.ts), so no
// client.ts-style recordAvenFailure store is mirrored here.
//
// Consumer: flow/reconcile.ts runReconcilePass — ONE listTicketStatuses()
// call per pass (which is TWO aven shell-outs), injected as
// ReconcileDeps.listTicketStatuses.
//
// Pinned against the real CLI (aven 0.1.54, output captured 2026-11-24):
// `aven list --all-projects … --json` prints a JSON ARRAY of ticket objects
// whose fields are `ref` (string, e.g. "PMR-62EN") and `status` (string,
// one of inbox|backlog|todo|active|done|canceled). DONE AND CANCELED TICKETS
// DO APPEAR in the listing (live measurement: 809 entries — 702 done, 27
// canceled, 59 backlog, 15 inbox, 4 todo, 2 active), so the map carries
// closed statuses and computeStaleRefs reads them directly; the "missing
// from map ⇒ stale" branch stays as the safety net for refs the listing
// genuinely omits. Active tickets always appear (verified).
//
// AIDEV-NOTE (PMR-MSDJ 1.4, workspace pinning — the fix for the cwd-routing
// hazard first measured here): `aven list` is WORKSPACE-ROUTE DEPENDENT even
// with
// `--all-projects`, because aven resolves the workspace from process.cwd()
// through ~/.config/aven/config.yaml `workspace.routes`. Measured live: cwd
// /home/geert/Code/personal → workspace "projects" (809 tickets), but a herdr
// worktree under ~/.herdr/worktrees is UNROUTED and falls back to the
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
//   • therefore a machine that lacks one of these workspaces (or an
//     `avenWorkspace` config override to another name) tombstones nothing and
//     warns once per pass: `aven list --workspace nosuchws` exits 1 with
//     `Error: … unknown-workspace …` on stderr, which rejects execFileAsync
//     ⇒ null. That is the safe direction, but it DOES mean the workspace
//     list below is host-assumed — adjust the const (or have 2.2/2.3 pass a
//     configured list) rather than adding a cwd fallback.
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

/** The production runner: one `aven list … --json` shell-out. */
export const avenListExec: AvenRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('aven', [...args], {
    timeout: AVEN_TIMEOUT_MS,
    maxBuffer: AVEN_LIST_MAX_BUFFER,
  })
  return { stdout, stderr }
}

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
  return merged
}
