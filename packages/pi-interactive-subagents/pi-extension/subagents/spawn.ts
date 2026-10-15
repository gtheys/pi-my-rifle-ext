import {
  HerdrError,
  herdrRunInPane,
  herdrWaitOutput,
  runHerdr,
  runHerdrEnvelope,
} from './herdr.ts'

// AIDEV-NOTE: Tab spawn + rollback (PMR-TABUX). Spawn = background tab
// (`tab create --no-focus` — the user's focus never moves) → shell-readiness
// marker → `agent start` attaching pi/claude to the tab's root pane. Failure
// of `agent start` rolls back ONLY tabs this spawn created (asymmetric
// cleanup — herdsman's rule: never close a user's tab). Focus actions are
// separately verified via canFocusAgent before `agent focus` is sent.

// ── Tab + agent spawn verbs (PMR-TABUX) ──

export interface HerdrSpawnedTab {
  paneId: string
  tabId: string
  workspaceId: string
}

interface HerdrPaneSummary {
  pane_id?: string
  tab_id?: string
  workspace_id?: string
}

/**
 * Create a background tab: `tab create --workspace --cwd --label --env K=V
 * --no-focus`. `--no-focus` is the background guarantee — the user's focus
 * never moves. Returns the tab's root pane + tab ids for rollback bookkeeping.
 * Flag shapes verified against the installed 0.9.0 binary.
 */
export function herdrTabCreate(options: {
  workspaceId: string
  cwd: string
  label: string
  env?: Record<string, string>
}): HerdrSpawnedTab {
  const args = [
    'tab',
    'create',
    '--workspace',
    options.workspaceId,
    '--cwd',
    options.cwd,
    '--label',
    options.label,
    '--no-focus',
  ]
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`)
  }
  const result = runHerdrEnvelope<{
    root_pane?: HerdrPaneSummary
    tab?: HerdrPaneSummary
  }>(args)
  const pane = result.root_pane
  const tab = result.tab
  if (!pane?.pane_id || !tab?.tab_id) {
    throw new HerdrError(
      `herdr tab create returned no root pane/tab: ${JSON.stringify(result).slice(0, 200)}`,
      args,
    )
  }
  return {
    paneId: pane.pane_id,
    tabId: tab.tab_id,
    workspaceId: tab.workspace_id ?? options.workspaceId,
  }
}

/** Close a tab (rollback path — only ever called on tabs WE created). */
export function herdrTabClose(tabId: string): void {
  runHerdr(['tab', 'close', tabId])
}

/**
 * Start an agent in a shell-ready pane: `agent start <alias> --kind <kind>
 * --pane <id> --timeout <ms> -- <argv>`. Blocks until herdr detects the
 * agent's interactive readiness. Throws HerdrError on failure — caller owns
 * rollback of the tab it created.
 */
export function herdrAgentStart(options: {
  alias: string
  kind: 'pi' | 'claude'
  paneId: string
  argv: readonly string[]
  timeoutMs?: number
}): void {
  const args = [
    'agent',
    'start',
    options.alias,
    '--kind',
    options.kind,
    '--pane',
    options.paneId,
    '--timeout',
    // AIDEV-NOTE: keep this SHORT. herdr's readiness detection waits for an
    // idle agent, but our children go busy immediately (positional task), so
    // this timeout is a false-negative path — the caller (spawnAgentInTab)
    // treats it as soft and confirms via the child session file. A long
    // timeout blocks the subagent tool call itself (observed: 31s block made
    // the parent miss a child's ask window).
    String(options.timeoutMs ?? 10_000),
    '--',
    ...options.argv,
  ]
  runHerdr(args)
}

/**
 * Liveness probe: `pane get <id>`. True when the pane still exists. Errors
 * (herdr unreachable) fail OPEN — the caller must not misclassify a live
 * child as crashed just because a probe failed.
 */
export function herdrPaneAlive(paneId: string): boolean {
  try {
    runHerdr(['pane', 'get', paneId])
    return true
  } catch (err) {
    if (err instanceof HerdrError && err.exitCode === 1) return false
    return true
  }
}

/** List tabs in a workspace (used to verify a created tab still exists). */
export function herdrTabList(workspaceId: string): string[] {
  const result = runHerdrEnvelope<{
    tabs?: Array<{ tab_id?: string }>
  }>(['tab', 'list', '--workspace', workspaceId])
  return (result.tabs ?? [])
    .map((t) => t.tab_id)
    .filter((id): id is string => typeof id === 'string')
}

const AGENT_PANE_BUSY_RETRY_MS = 2000

/**
 * Shell-readiness marker (herdsman's spawn hardening): echo a unique marker
 * via `pane run`, then block on `pane wait-output --regex` until the fresh
 * pane's shell prints it — proving the shell is interactive before any
 * `agent start`. Retries once after ~2s on the fresh-shell busy race.
 *
 * Acceptance is regex-escaped — the marker is generated, not user input, but
 * escape defensively anyway.
 */
export async function waitShellReady(
  paneId: string,
  options?: { timeoutMs?: number },
): Promise<void> {
  const marker = `__READY_${crypto.randomUUID().replaceAll('-', '')}__`
  const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const timeoutMs = options?.timeoutMs ?? 10_000

  try {
    herdrRunInPane(paneId, ['echo', marker])
    herdrWaitOutput(paneId, `^${escaped}$`, timeoutMs)
    return
  } catch (err) {
    // Fresh-shell busy race: pane exists but its agent/shell isn't accepting
    // input yet (`agent_pane_busy`). Wait ~2s and retry once.
    if (!(err instanceof HerdrError)) throw err
    await new Promise<void>((resolve) =>
      setTimeout(resolve, AGENT_PANE_BUSY_RETRY_MS),
    )
  }

  herdrRunInPane(paneId, ['echo', marker])
  herdrWaitOutput(paneId, `^${escaped}$`, timeoutMs)
}

// ── Pure bookkeeping (unit-tested) ──

/**
 * Rollback selection: of the candidate tabs, close ONLY the ones this spawn
 * created and that still exist. Never returns a tab absent from `createdTabIds`
 * — user tabs are untouchable.
 */
export function pickRollbackTabs(
  createdTabIds: readonly string[],
  existingTabIds: readonly string[],
): string[] {
  const created = new Set(createdTabIds)
  return existingTabIds.filter((id) => created.has(id))
}

/** What a focus click needs to know about the entry it targets. */
export interface FocusTargetRecord {
  childId: string
  sessionFile: string
  paneId?: string
  tabId?: string
  workspaceId?: string
  starting?: boolean
}

/**
 * Focus verification gate (herdsman's `focusTarget` discipline — status
 * projection is never authorization): the recorded entry must be live (not
 * starting), carry a paneId, and the herdr-reported agent must still sit on
 * the same pane/tab/workspace. Any mismatch ⇒ inert.
 */
export function canFocusAgent(
  target: FocusTargetRecord,
  agent: {
    pane_id?: string
    tab_id?: string
    workspace_id?: string
  } | null,
): { ok: true; paneId: string } | { ok: false; reason: string } {
  if (!target.paneId) return { ok: false, reason: 'no pane recorded' }
  if (target.starting) return { ok: false, reason: 'still starting' }
  if (!agent) return { ok: false, reason: 'agent gone from herdr' }
  if (agent.pane_id !== target.paneId) {
    return { ok: false, reason: 'pane identity changed' }
  }
  if (target.tabId && agent.tab_id && agent.tab_id !== target.tabId) {
    return { ok: false, reason: 'tab identity changed' }
  }
  if (
    target.workspaceId &&
    agent.workspace_id &&
    agent.workspace_id !== target.workspaceId
  ) {
    return { ok: false, reason: 'workspace identity changed' }
  }
  return { ok: true, paneId: target.paneId }
}
