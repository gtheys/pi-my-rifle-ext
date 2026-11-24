// AIDEV-NOTE (PMR-MSDJ 2.2, plan PMR-V36Y decision 4a): node-only io wiring for
// the tombstone reconcile — the single place where the daemon's world (agent
// dir + process env) is turned into the engine's injected `ReconcileDeps`, plus
// the tolerant global-config reader the timer re-reads every pass.
//
// Home justification: this is flow-feature code, not daemon policy. The daemon
// half of the reconcile (timer posture, keepalive, scan-queue independence)
// lives in server/daemon.ts `createReconcileLoop`; everything here is
// reconcile-domain io that the manual `/flow-reconcile-push` command (2.3,
// in-session, `ctx.ui.notify` warn channel) can reuse by passing its own warn
// sink — which is why no function here reads `process.env` directly (the env is
// always a parameter, defaulting to `process.env` only at the boundary).
//
// Dependency contract (mirrors server/daemon.ts's header): node built-ins +
// ./reconcile.ts + ./push.ts + ../aven/status.ts + ../run-state.ts only. No
// config.ts: its `readConfigFile` THROWS on a malformed file (AGENTS.md
// boundary rule for the session side) and its loader pulls
// `@earendil-works/pi-coding-agent`; the daemon must degrade to defaults +
// warning instead. run-state.ts already runtime-imports pi-coding-agent for
// getAgentDir (run-state.ts:10) — a pre-existing condition the daemon accepts;
// nothing here adds a new one.
//
// AIDEV-NOTE: journal enumeration is the SAME rule the daemon's 1s scan uses
// (`journalRefsFromEntries`, which server/daemon.ts scanRuns also calls) — the
// reconcile must never see a different run set than the projections do. The
// runs dir is derived from the agent dir the spawner handed us
// (PI_FLOW_AGENT_DIR, server/lifecycle.ts), never from getAgentDir().
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { listTicketStatuses as avenListTicketStatuses } from '../aven/status.ts'
import { readRunEvents, runsDir } from '../run-state.ts'
import {
  fetchGroupBody,
  type GroupBodyResult,
  type PushResult,
  pushToGateway,
} from './push.ts'
import {
  parseReconcileSettings,
  type ReconcileDeps,
  type ReconcileReport,
  runReconcilePass,
} from './reconcile.ts'

/** Daemon-side settings shape (`warning` is ours, not the engine's: a file
 *  that exists but cannot be read is defaults + warning, same discipline as
 *  `parseReconcileSettings` applying to malformed CONTENT). */
export interface ReconcileSettings {
  enabled: boolean
  intervalMinutes: number
  warning?: string
}

/** The single fetch shape both pushgateway calls need: `flow/push.ts`'s
 *  `GroupFetch` (GET, wants `text()`) and `PushFetch` (POST, wants status) are
 *  both structurally satisfied by this one, so wiring injects exactly one
 *  seam for tests. */
export type ReconcileFetch = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
  },
) => Promise<{
  status: number
  statusText: string
  text: () => Promise<string>
}>

const JOURNAL_SUFFIX = '.journal.jsonl'

const defaultReadFile = (file: string): Promise<string> =>
  fsp.readFile(file, 'utf8')

/** global config the daemon can locate without pi-coding-agent:
 *  `<agentDir>/pi-flow/config.json` — the same file `config.ts` treats as its
 *  global layer (config.ts:331), reached through the agent dir the spawner
 *  passed instead of `getAgentDir()`. Project overrides are invisible here BY
 *  DESIGN (a daemon has no session cwd; 2.1 note in config.ts). */
export function globalConfigPath(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', 'config.json')
}

/** `*.journal.jsonl` basenames from a runs-dir listing — the scanRuns rule. */
export function journalRefsFromEntries(entries: readonly string[]): string[] {
  const refs: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(JOURNAL_SUFFIX)) continue
    refs.push(entry.slice(0, -JOURNAL_SUFFIX.length))
  }
  return refs
}

/** Refs with journals under `runsDir(agentDir)`. A missing runs dir is an
 *  empty list, not an error: the daemon starts before the first journal write
 *  (see the KEEPALIVE RULE in server/daemon.ts). */
export async function listJournalRefs(
  agentDir: string,
  readdir: (dir: string) => Promise<string[]> = (dir) => fsp.readdir(dir),
): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(runsDir(agentDir))
  } catch {
    return []
  }
  return journalRefsFromEntries(entries)
}

interface PushgatewayEnv {
  url: string
  token: string | undefined
}

/** The pushgateway env gate — the same rule as the cost autopush
 *  (`flow/cost-autopush.ts` `enabled`): no URL means nothing happens, not even
 *  a journal read. The token is optional (a gateway behind mTLS/none). */
export function pushgatewayEnv(
  env: NodeJS.ProcessEnv = process.env,
): PushgatewayEnv | null {
  const url = env.PI_FLOW_PUSHGATEWAY_URL
  if (url === undefined || url.length === 0) return null
  const token = env.PI_FLOW_PUSHGATEWAY_TOKEN
  if (token === undefined || token.length === 0)
    return { url, token: undefined }
  return { url, token }
}

export interface ReconcileDepsOptions {
  /** agent dir from PI_FLOW_AGENT_DIR (the daemon) or getAgentDir() (command) */
  agentDir: string
  /** the daemon's log channel / the command's notify — engine warnings land here */
  warn: (message: string) => void
  env?: NodeJS.ProcessEnv
  fetchImpl?: ReconcileFetch
  listTicketStatuses?: () => Promise<Map<string, string> | null>
  readdir?: (dir: string) => Promise<string[]>
}

/** Wire the engine's io. Returns null when the pushgateway env gate is closed
 *  — callers skip the pass silently (it is logged once, by the timer). */
export function createReconcileDeps(
  options: ReconcileDepsOptions,
): ReconcileDeps | null {
  const gateway = pushgatewayEnv(options.env ?? process.env)
  if (gateway === null) return null
  const fetchImpl: ReconcileFetch = options.fetchImpl ?? defaultReconcileFetch
  const listStatuses = options.listTicketStatuses ?? avenListTicketStatuses
  const readdir = options.readdir ?? ((dir: string) => fsp.readdir(dir))
  const { agentDir, warn } = options
  return {
    listJournalRefs: () => listJournalRefs(agentDir, readdir),
    readRunEvents: (ref: string) => readRunEvents(agentDir, ref),
    listTicketStatuses: () => listStatuses(),
    fetchGroupBody: (trackRef: string, mode: 'work' | 'personal') =>
      fetchGroupBodyOrError(gateway, trackRef, mode, fetchImpl),
    pushTombstone: (
      trackRef: string,
      mode: 'work' | 'personal',
      body: string,
    ) => pushTombstoneOrError(gateway, trackRef, mode, body, fetchImpl),
    warn,
  }
}

async function defaultReconcileFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{
  status: number
  statusText: string
  text: () => Promise<string>
}> {
  const response = await fetch(url, init)
  return {
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  }
}

// AIDEV-NOTE: the engine's `ReconcileDeps` contract is `{ok:false,error}` or a
// PushResult, never a throw — but `flow/push.ts` only guarantees that for its
// own io. These wrappers keep the promise for the whole call (a frozen DNS
// cache throwing synchronously inside `fetch` must cost one skip entry, not
// the daemon's pass): unexpected throws become ordinary failure results.
async function fetchGroupBodyOrError(
  gateway: PushgatewayEnv,
  trackRef: string,
  mode: 'work' | 'personal',
  fetchImpl: ReconcileFetch,
): Promise<GroupBodyResult> {
  try {
    return await fetchGroupBody(
      gateway.url,
      trackRef,
      mode,
      gateway.token,
      fetchImpl,
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${err}` }
  }
}

async function pushTombstoneOrError(
  gateway: PushgatewayEnv,
  trackRef: string,
  mode: 'work' | 'personal',
  body: string,
  fetchImpl: ReconcileFetch,
): Promise<PushResult> {
  try {
    return await pushToGateway(
      gateway.url,
      trackRef,
      body,
      fetchImpl,
      gateway.token,
      mode,
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${err}` }
  }
}

/** The raw global config text, re-read on every cycle so `intervalMinutes` and
 *  `enabled` changes apply without a daemon restart (plan PMR-V36Y 2.2).
 *  ENOENT is the normal "no config yet" answer (defaults, no warning); any
 *  other read failure degrades the same way but says so. */
export async function readReconcileSettings(
  agentDir: string,
  readFile: (file: string) => Promise<string> = defaultReadFile,
): Promise<ReconcileSettings> {
  const file = globalConfigPath(agentDir)
  let raw: string | null = null
  let warning: string | undefined
  try {
    raw = await readFile(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      warning = `could not read ${file}: ${err instanceof Error ? err.message : `${err}`}`
    }
    raw = null
  }
  const settings = parseReconcileSettings(raw)
  if (warning !== undefined) return { ...settings, warning }
  return settings
}

/** One stable line per pass — the daemon logs it, and subtask 2.3's command
 *  notify reuses the same shape (plan PMR-V36Y behavior step 6). */
export function reconcileSummaryLine(report: ReconcileReport): string {
  const parts = [
    `reconcile pass: scanned=${report.scanned}`,
    `candidates=${report.candidates}`,
    `stale=${report.stale.length}`,
    `tombstoned=${report.tombstoned.length}`,
    `skipped=${report.skipped.length}`,
  ]
  if (report.dryRun) parts.push('dry-run')
  if (report.avenFailed) parts.push('aven=failed')
  return parts.join(' ')
}

export interface ReconcilePassOnceOptions extends ReconcileDepsOptions {
  dryRun?: boolean
  /** engine seam (tests assert the wired deps reach it; default real engine) */
  engine?: (
    deps: ReconcileDeps,
    opts: { dryRun: boolean },
  ) => Promise<ReconcileReport>
}

/** One pass with wired deps. Returns null when the pushgateway env gate is
 *  closed, so the caller can distinguish "nothing to do" from a real report. */
export async function runReconcilePassOnce(
  options: ReconcilePassOnceOptions,
): Promise<ReconcileReport | null> {
  const deps = createReconcileDeps(options)
  if (deps === null) return null
  const dryRun = options.dryRun === true
  const engine = options.engine ?? runReconcilePass
  return engine(deps, { dryRun })
}
