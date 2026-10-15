import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  herdrReadPane,
  herdrSendEscape,
  herdrSendReturn,
  herdrSendText,
  runHerdr,
} from './herdr.ts'
import { herdrPaneAlive } from './spawn.ts'

// AIDEV-NOTE: herdr-only surface layer (PMR-TABUX). The cmux/tmux/zellij/
// wezterm backends and the PI_SUBAGENT_MUX override were deleted; every
// surface operation goes through the herdr verb layer. Kept public names:
// isMuxAvailable/muxSetupHint (pi-test-runner, pi-review) and the text-send /
// screen-read helpers the still-alive WXG0 answer path uses until Phase 5
// replaces pane typing with the mailbox pump.

export type MuxBackend = 'herdr'

const commandAvailability = new Map<string, boolean>()

function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command)
  if (cached !== undefined) return cached
  let available = false
  try {
    runHerdr(['--version'])
    available = true
  } catch {
    available = false
  }
  commandAvailability.set(command, available)
  return available
}

export function getMuxBackend(): MuxBackend | null {
  return hasCommand('herdr') ? 'herdr' : null
}

/**
 * Herdr availability = binary present + server reachable (status preflight,
 * which also enforces the >= HERDR_MIN_VERSION gate at spawn time).
 */
export function isMuxAvailable(): boolean {
  if (!hasCommand('herdr')) return false
  try {
    runHerdr(['status', '--json'])
    return true
  } catch {
    return false
  }
}

export function muxSetupHint(): string {
  return (
    'Install herdr (https://github.com/steipete/herdr), start it with `herdr`, ' +
    'and run pi inside it (`herdr pi`). If it is already installed, upgrade ' +
    'with `herdr upgrade` — this extension needs herdr >= 0.9.1.'
  )
}

/** Close a herdr pane; when the caller knows the owning tab, close it too. */
export function closeSurface(surface: string, tabId?: string): void {
  try {
    runHerdr(['pane', 'close', surface])
  } catch {
    // Already gone.
  }
  if (tabId) {
    try {
      runHerdr(['tab', 'close', tabId])
    } catch {
      // Already gone.
    }
  }
}

/** Send one Escape keypress (canonical `esc`, never raw byte 27). */
export function sendEscape(surface: string): void {
  herdrSendEscape(surface)
}

/** Type text into a pane and submit it (Enter). */
export function sendCommand(surface: string, command: string): void {
  herdrSendText(surface, command)
  herdrSendReturn(surface)
}

/**
 * Send a long command via a script file + short `bash <file>` line (herdr
 * rejects oversized input lines). Kept for the WXG0 answer path; Phase 5
 * deletes the last pane-typing dependency. Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      'pi-subagent-scripts',
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    )
  mkdirSync(dirname(scriptPath), { recursive: true })

  const scriptParts = ['#!/bin/bash']
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd())
  }
  scriptParts.push(command)

  writeFileSync(scriptPath, `${scriptParts.join('\n')}\n`, { mode: 0o755 })
  sendCommand(surface, `bash ${scriptPath}`)
  return scriptPath
}

function tailLines(text: string, lines: number): string {
  const split = text.split('\n')
  if (split.length <= lines) return text
  return split.slice(-lines).join('\n')
}

/** Read pane terminal output (recent-unwrapped: stable logical lines). */
export function readScreen(surface: string, lines = 50): string {
  return tailLines(
    herdrReadPane(surface, { lines, source: 'recent-unwrapped' }),
    lines,
  )
}

/** Read pane terminal output (async wrapper). */
export async function readScreenAsync(
  surface: string,
  lines = 50,
): Promise<string> {
  return readScreen(surface, lines)
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export interface PollResult {
  /** How the subagent exited */
  reason: 'done' | 'ping' | 'sentinel' | 'error'
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string }
  /** Error message if reason is "error" (auto-retry exhausted, crash, etc.) */
  errorMessage?: string
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === 'ping') {
    return {
      reason: 'ping',
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    }
  }
  if (data?.type === 'error') {
    const errorMessage =
      typeof data.errorMessage === 'string' && data.errorMessage.trim() !== ''
        ? data.errorMessage
        : 'Subagent exited with stopReason=error (no errorMessage in sidecar).'
    return { reason: 'error', exitCode: 1, errorMessage }
  }
  return { reason: 'done', exitCode: 0 }
}

export const __pollForExitTest__ = { interpretExitSidecar }

/**
 * Poll check order for one pollForExit tick. Exported for tests — the order is
 * load-bearing: `.ask` (blocked-but-alive, PMR-WXG0) must be observed BEFORE
 * the liveness probe, or a blocked child gets misclassified as crashed.
 *
 * AIDEV-NOTE (PMR-TABUX): the screen-sentinel scrape and the wrapper-shell
 * `.code` crash file are gone — `agent start` runs pi directly in the pane, so
 * there is no wrapper shell to capture the exit code. Crash inference is now
 * herdr liveness: pane definitively gone + no `.exit` ⇒ crashed, fail-closed
 * (surfaced as an error result, never guessed success). Probe errors fail OPEN
 * (treated alive) so a herdr hiccup can't kill a live watcher.
 */
export type PollCheckPhase = 'exit' | 'ask' | 'liveness'
export const POLL_CHECK_ORDER: readonly PollCheckPhase[] = [
  'exit',
  'ask',
  'liveness',
]

/** Wait one poll interval; rejects on abort. */
function waitPollInterval(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function readExitSidecar(sessionFile: string): PollResult | null {
  try {
    const exitFile = `${sessionFile}.exit`
    if (!existsSync(exitFile)) return null
    const data = JSON.parse(readFileSync(exitFile, 'utf8'))
    rmSync(exitFile, { force: true })
    return interpretExitSidecar(data)
  } catch {
    return null
  }
}

/**
 * Poll until the subagent exits. Primary completion signal = the `.exit`
 * sidecar (written by subagent_done / caller_ping). A blocked `.ask` keeps
 * the poll alive. Crash inference: when the herdr pane is definitively gone
 * and no `.exit` ever appeared, return a fail-closed error result.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number
    sessionFile?: string
    sentinelFile?: string
    onTick?: (elapsed: number) => void
    /** Called each tick while a `.ask` sidecar is present (blocked child). */
    onAsk?: () => void
    /**
     * Called when a VERIFIED completion signal is observed (the `.exit`
     * sidecar or the claude sentinel file) — as opposed to crash inference
     * from liveness. Assignment cleanup (PMR-Z5KR) gates record removal on
     * this distinction.
     */
    onVerifiedExit?: () => void
    /** Liveness probe; defaults to herdr pane liveness. Injectable for tests. */
    isAlive?: (paneId: string) => boolean
  },
): Promise<PollResult> {
  const start = Date.now()
  const isAlive = options.isAlive ?? herdrPaneAlive

  for (;;) {
    if (signal.aborted) {
      throw new Error('Aborted while waiting for subagent to finish')
    }

    // Primary path: `.exit` sidecar (subagent_done / caller_ping).
    if (options.sessionFile) {
      const exit = readExitSidecar(options.sessionFile)
      if (exit) {
        options.onVerifiedExit?.()
        return exit
      }
    }

    // Claude sentinel file (written by the plugin Stop hook).
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          options.onVerifiedExit?.()
          return { reason: 'sentinel', exitCode: 0 }
        }
      } catch {}
    }

    // Blocked-ask observation (PMR-WXG0): `.ask` sidecar present ⇒ the child
    // is blocked-asking and ALIVE. Checked BEFORE the liveness probe. The poll
    // deliberately does NOT resolve — the watcher keeps waiting for `.exit`.
    if (options.sessionFile) {
      try {
        if (existsSync(`${options.sessionFile}.ask`)) {
          options.onAsk?.()
          options.onTick?.(Math.floor((Date.now() - start) / 1000))
          await waitPollInterval(signal, options.interval)
          continue
        }
      } catch {}
    }

    // Crash inference (PMR-TABUX): pane gone + no `.exit` ⇒ crashed or killed.
    // Fail closed as an error result — never guess success. A probe that
    // itself throws fails OPEN (treated alive) so a herdr hiccup can't kill
    // a live watcher.
    if (options.sessionFile) {
      let alive = true
      try {
        alive = isAlive(surface)
      } catch {}
      if (!alive) {
        return {
          reason: 'error',
          exitCode: 1,
          errorMessage:
            'Subagent pane disappeared without an exit sidecar (crashed or killed).',
        }
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000)
    options.onTick?.(elapsed)

    await waitPollInterval(signal, options.interval)
  }
}
