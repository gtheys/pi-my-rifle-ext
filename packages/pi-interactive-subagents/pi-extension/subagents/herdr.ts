import { execFileSync } from 'node:child_process'

// AIDEV-NOTE: Herdr verb layer (PMR-M48Y) — thin JSON-envelope wrappers over
// the `herdr` CLI, ported from pi-herdsman's runHerdr discipline. Every socket
// verb returns herdr's `{id, result}` envelope; raw-output verbs (pane read,
// pane send-*) return plain text. Verb/flag shapes verified against
// `herdr api schema --json` of the installed binary (0.9.0, protocol 22).
// 0.9.0 gaps noted inline; HERDR_MIN_VERSION gate protects users at runtime.
// ── Herdr verb layer ──

/** herdsman's baseline pin. Older servers fail preflight with an upgrade hint. */
export const HERDR_MIN_VERSION = '0.9.1'

/** Error from a failed herdr CLI invocation (nonzero exit or bad output). */
export class HerdrError extends Error {
  readonly args: readonly string[]
  readonly stderr: string
  /** Process exit status when the CLI itself ran and failed, else null. */
  readonly exitCode: number | null

  constructor(
    message: string,
    args: readonly string[],
    stderr = '',
    exitCode: number | null = null,
  ) {
    super(message)
    this.name = 'HerdrError'
    this.args = args
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

interface HerdrEnvelope<T> {
  id?: unknown
  result?: T
  error?: { code?: string; message?: string }
}

/**
 * Run `herdr` with the given args and return trimmed stdout. Throws HerdrError
 * on nonzero exit (stderr included) — never parses here.
 */
export function runHerdr(args: readonly string[], timeoutMs?: number): string {
  const opts: { encoding: BufferEncoding; timeout?: number } = {
    encoding: 'utf8',
  }
  if (timeoutMs !== undefined) {
    opts.timeout = timeoutMs
  }
  try {
    return execFileSync('herdr', args, opts).trim()
  } catch (err) {
    const e = err as {
      stderr?: string | Buffer
      message: string
      status?: number | null
    }
    let stderr = ''
    if (typeof e.stderr === 'string') {
      stderr = e.stderr
    } else if (e.stderr !== undefined && e.stderr !== null) {
      stderr = String(e.stderr)
    }
    throw new HerdrError(
      `herdr ${args.join(' ')} failed: ${stderr.trim() || e.message}`,
      args,
      stderr,
      typeof e.status === 'number' ? e.status : null,
    )
  }
}

/**
 * Parse herdr's `{id, result}` JSON envelope from raw stdout. Pure — exported
 * for tests. Non-JSON output fails with a clear error (fail closed).
 */
export function parseHerdrEnvelope<T>(
  args: readonly string[],
  stdout: string,
): T {
  let parsed: HerdrEnvelope<T>
  try {
    parsed = JSON.parse(stdout) as HerdrEnvelope<T>
  } catch {
    throw new HerdrError(
      `herdr ${args.join(' ')} returned non-JSON output (expected {id, result} envelope): ${stdout.slice(0, 200)}`,
      args,
    )
  }
  if (parsed.error) {
    throw new HerdrError(
      `herdr ${args.join(' ')} error ${parsed.error.code ?? ''}: ${parsed.error.message ?? 'unknown'}`,
      args,
    )
  }
  if (parsed.id === undefined || parsed.result === undefined) {
    throw new HerdrError(
      `herdr ${args.join(' ')} returned unexpected JSON (missing id/result): ${stdout.slice(0, 200)}`,
      args,
    )
  }
  return parsed.result
}

/**
 * Run a herdr verb that returns the `{id, result}` JSON envelope and return
 * `result`. Non-JSON output fails with a clear error (fail closed).
 */
export function runHerdrEnvelope<T>(
  args: readonly string[],
  timeoutMs?: number,
): T {
  return parseHerdrEnvelope<T>(args, runHerdr(args, timeoutMs))
}

/** `herdr status --json` payload (CLI-level JSON, not an envelope). */
export interface HerdrStatus {
  client?: { version?: string }
  server?: { status?: string; running?: boolean; version?: string }
}

/** Compare dotted version strings; negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Validate a raw `herdr status --json` payload and enforce the version gate.
 * Throws with an actionable message on unreachable server or version < gate.
 */
export function parseHerdrStatus(raw: string): HerdrStatus {
  let status: HerdrStatus
  try {
    status = JSON.parse(raw) as HerdrStatus
  } catch {
    throw new HerdrError(
      'herdr status returned non-JSON output — is herdr installed correctly? See https://github.com/steipete/herdr',
      ['status', '--json'],
    )
  }
  const running = status.server?.running === true
  if (!running) {
    throw new HerdrError(
      'Herdr server is not running. Start it with `herdr` (or `herdr pi`), then retry.',
      ['status', '--json'],
    )
  }
  const version = status.server?.version ?? status.client?.version
  if (!version) {
    throw new HerdrError(
      'Could not determine herdr version from `herdr status --json` — refusing to proceed.',
      ['status', '--json'],
    )
  }
  if (compareVersions(version, HERDR_MIN_VERSION) < 0) {
    throw new HerdrError(
      `herdr ${version} is too old; this extension requires >= ${HERDR_MIN_VERSION}. Upgrade with \`herdr upgrade\` (or reinstall from https://github.com/steipete/herdr) and restart the herdr server.`,
      ['status', '--json'],
    )
  }
  return status
}

/**
 * Preflight: `herdr status --json`, server reachability, >= HERDR_MIN_VERSION.
 * Call before any spawn. Throws HerdrError with an actionable message.
 */
export function herdrPreflight(): HerdrStatus {
  return parseHerdrStatus(runHerdr(['status', '--json']))
}

/** Send one Escape keypress (canonical `esc`, never raw byte 27). */
export function herdrSendEscape(paneId: string): void {
  runHerdr(['pane', 'send-keys', paneId, 'esc'])
}

/** Type text into a pane without submitting. */
export function herdrSendText(paneId: string, text: string): void {
  runHerdr(['pane', 'send-text', paneId, text])
}

/** Submit the pending input line (Enter). */
export function herdrSendReturn(paneId: string): void {
  runHerdr(['pane', 'send-keys', paneId, 'return'])
}

/**
 * Script-file execution (herdsman's sendLongCommand correction): run a
 * payload from a file instead of typing it into the pane — herdr rejects
 * oversized input lines. Sends a short `bash <file>` line and submits it.
 */
export function herdrRunScriptFile(paneId: string, scriptPath: string): void {
  herdrSendText(paneId, `bash ${scriptPath}`)
  herdrSendReturn(paneId)
}

/** Run a short command in a pane via `herdr pane run` (no shell typing). */
export function herdrRunInPane(
  paneId: string,
  command: readonly string[],
): void {
  runHerdr(['pane', 'run', paneId, ...command])
}

export type HerdrReadSource =
  | 'visible'
  | 'recent'
  | 'recent-unwrapped'
  | 'detection'

/** Read pane terminal output. Defaults to `--source recent`. */
export function herdrReadPane(
  paneId: string,
  options?: { lines?: number; source?: HerdrReadSource },
): string {
  const args = ['pane', 'read', paneId, '--source', options?.source ?? 'recent']
  if (options?.lines !== undefined) {
    args.push('--lines', String(options.lines))
  }
  return runHerdr(args)
}

/**
 * Read an agent's terminal output: `agent read <target> --source
 * recent-unwrapped --format text`. No `--lines` — avoids truncation and the
 * alternate-screen paging guard herdsman works around. Only works for
 * agent-reported panes (pane.report-agent); plain shell panes fail with
 * `agent_not_found` — verified on 0.9.0.
 */
export function herdrReadAgent(target: string): string {
  return runHerdr([
    'agent',
    'read',
    target,
    '--source',
    'recent-unwrapped',
    '--format',
    'text',
  ])
}

export interface HerdrWaitOutputResult {
  matched_line: string
  pane_id: string
}

/**
 * Block until pane output matches a regex: `pane wait-output <pane> --regex
 * <pattern> --timeout <ms>`. Throws HerdrError on timeout/nonzero exit.
 */
export function herdrWaitOutput(
  paneId: string,
  regex: string,
  timeoutMs: number,
): HerdrWaitOutputResult {
  return runHerdrEnvelope<HerdrWaitOutputResult>([
    'pane',
    'wait-output',
    '--regex',
    regex,
    paneId,
    '--timeout',
    String(timeoutMs),
  ])
}

/** Result payload of `agent list` (envelope). */
export interface HerdrAgent {
  agent: string
  agent_status?: string
  cwd?: string
  focused?: boolean
  pane_id: string
  tab_id?: string
  workspace_id?: string
  agent_session?: { value?: string }
}

/** List herdr-known agents. NOTE: `agent list --json` does NOT exist on 0.9.0; the CLI prints the envelope by default. */
export function herdrAgentList(): HerdrAgent[] {
  const result = runHerdrEnvelope<{ agents?: HerdrAgent[] }>(['agent', 'list'])
  return result.agents ?? []
}

/** Get one agent by pane id / target. Returns null when herdr reports it gone. */
export function herdrAgentGet(target: string): HerdrAgent | null {
  const result = runHerdrEnvelope<{ agent?: HerdrAgent | null }>([
    'agent',
    'get',
    target,
  ])
  return result.agent ?? null
}

/** Focus an agent's pane. */
export function herdrAgentFocus(target: string): void {
  runHerdr(['agent', 'focus', target])
}
