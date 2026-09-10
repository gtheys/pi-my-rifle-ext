/**
 * pi-sudo — Pi extension
 *
 * Registers a `sudo_run` tool. Before execution the user sees one overlay
 * with two stages:
 *
 *   Stage 1 — confirm
 *     Shows command + AI-supplied reason. y = Allow, n / Esc = Deny.
 *     Auto-denies after 60s of inactivity (dead-man's switch).
 *
 *   Stage 2 — password
 *     Inline masked input (● per char). Enter submits, Esc cancels.
 *
 * Security notes:
 *   - Password never leaves JS memory; never written to disk; never
 *     included in tool result content/details.
 *   - Every command requires explicit per-call confirmation.
 *   - No PAM ticket caching — every call re-prompts for a password (unlike
 *     pix-sudo). No retry loop — a wrong password fails the call once; the
 *     agent can just call the tool again.
 *   - Only runs when a real terminal (`ctx.mode === 'tui'`) is driving the
 *     session, since masked password entry needs `ctx.ui.custom()`.
 *   - Output truncated to 50 KB / 2000 lines.
 */

import { spawn } from 'node:child_process'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import {
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { Type } from '@sinclair/typebox'

const ROOT_PROMPT_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES = 50 * 1024
export const MAX_OUTPUT_LINES = 2000

// ── Pure helpers (exported for index.test.ts) ────────────────────────────────

export function truncate(
  text: string,
  maxLines = MAX_OUTPUT_LINES,
  maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  const byteLen = Buffer.byteLength(text, 'utf8')
  if (lines.length <= maxLines && byteLen <= maxBytes) {
    return { text, truncated: false }
  }
  const kept = lines.slice(0, maxLines)
  let result = kept.join('\n')
  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = Buffer.from(result, 'utf8').subarray(0, maxBytes).toString('utf8')
  }
  return { text: result, truncated: true }
}

export function filterSudoPrompt(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !/^\[sudo\] password/i.test(l))
    .join('\n')
}

export function detectAuthFailure(code: number, stderr: string): boolean {
  if (code === 0) return false
  const lower = stderr.toLowerCase()
  return (
    lower.includes('incorrect password') ||
    lower.includes('authentication failure') ||
    lower.includes('sorry,')
  )
}

// AIDEV-NOTE: see runWithSudo — the /dev/null stdin redirect is what stops an
// unconsumed password line (cached sudo creds) leaking into the command.
export function buildSudoShellCommand(command: string): string {
  return `exec </dev/null; ${command}`
}

// ── sudo runner ───────────────────────────────────────────────────────────────

interface SudoResult {
  stdout: string
  stderr: string
  code: number
}

function runWithSudo(
  command: string,
  password: string,
  signal?: AbortSignal,
): Promise<SudoResult> {
  return new Promise((resolve, reject) => {
    // AIDEV-NOTE: password and command share one stdin pipe. If sudo skips
    // its prompt (cached timestamp / NOPASSWD), the unconsumed password line
    // would be inherited by the command — a prompt like pacman's Y/n would
    // read (and echo!) it into stdout → tool result → model context. The
    // redirect gives the command its own stdin so pipe content can never
    // reach it. No regression: stdin was already EOF for the command (we end
    // it right after writing the password).
    const proc = spawn(
      'sudo',
      ['-S', '--', 'sh', '-c', buildSudoShellCommand(command)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const filtered = filterSudoPrompt(chunk.toString())
      if (filtered) stderr += filtered
    })
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }))
    proc.stdin.write(`${password}\n`)
    proc.stdin.end()
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          proc.kill('SIGTERM')
          reject(new Error('Cancelled'))
        },
        { once: true },
      )
    }
  })
}

// ── Result shape ──────────────────────────────────────────────────────────────

type SudoOutcome =
  | 'awaiting-approval'
  | 'running'
  | 'success'
  | 'denied'
  | 'timed-out'
  | 'cancelled'
  | 'error'
type SudoErrorKind = 'no-ui' | 'authentication' | 'execution'

interface SudoResultDetails {
  _type: 'sudoResult'
  command: string
  reason?: string
  outcome: SudoOutcome
  exitCode?: number
  errorKind?: SudoErrorKind
}

function makeDetails(
  command: string,
  reason: string | undefined,
  fields: Omit<SudoResultDetails, '_type' | 'command' | 'reason'>,
): SudoResultDetails {
  return {
    _type: 'sudoResult',
    command,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    ...fields,
  }
}

// ── Shared UI mutex ───────────────────────────────────────────────────────────
// AIDEV-NOTE: same globalThis key as @gtheys/pi-ask-user-question so any
// popup-style tool (ask_user_question, sudo_run, ...) serializes against the
// others without a cross-package dependency.
interface SharedUiLock {
  withLock<T>(fn: () => T | Promise<T>): Promise<T>
}
const SHARED_UI_LOCK_KEY = '__piSharedUiLock'
type GlobalWithUiLock = typeof globalThis & { __piSharedUiLock?: SharedUiLock }

function getSharedUiLock(): SharedUiLock {
  const g = globalThis as GlobalWithUiLock
  if (!g[SHARED_UI_LOCK_KEY]) {
    let chain: Promise<void> = Promise.resolve()
    g[SHARED_UI_LOCK_KEY] = {
      withLock<T>(fn: () => T | Promise<T>): Promise<T> {
        const prev = chain
        let release: () => void = () => {}
        chain = new Promise<void>((resolve) => {
          release = resolve
        })
        return prev.then(fn).finally(() => release())
      },
    }
  }
  return g[SHARED_UI_LOCK_KEY]
}

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
  return getSharedUiLock().withLock(fn)
}

// ── Confirm + masked password overlay ────────────────────────────────────────

interface SudoPromptResult {
  action: 'approved' | 'denied' | 'timeout'
  password?: string
}

function addWrapped(lines: string[], text: string, width: number): void {
  for (const row of wrapTextWithAnsi(text, width))
    lines.push(truncateToWidth(row, width))
}

function showSudoPrompt(
  ctx: ExtensionContext,
  command: string,
  reason: string | undefined,
): Promise<SudoPromptResult> {
  return ctx.ui.custom<SudoPromptResult>((tui, theme, _kb, done) => {
    let stage: 'confirm' | 'password' = 'confirm'
    let password = ''
    let cachedLines: string[] | undefined
    let cachedWidth = -1
    let timer: ReturnType<typeof setTimeout> | undefined

    function finish(result: SudoPromptResult) {
      if (timer) clearTimeout(timer)
      done(result)
    }

    function armTimeout() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => finish({ action: 'timeout' }),
        ROOT_PROMPT_TIMEOUT_MS,
      )
    }
    armTimeout()

    function refresh() {
      cachedLines = undefined
      tui.requestRender()
    }

    function handleInput(data: string) {
      armTimeout()
      if (stage === 'confirm') {
        if (data === 'y' || data === 'Y') {
          stage = 'password'
          refresh()
          return
        }
        if (data === 'n' || data === 'N' || matchesKey(data, Key.escape)) {
          finish({ action: 'denied' })
        }
        return
      }
      if (matchesKey(data, Key.escape)) {
        finish({ action: 'denied' })
        return
      }
      if (matchesKey(data, Key.enter)) {
        finish({ action: 'approved', password })
        return
      }
      if (matchesKey(data, Key.backspace)) {
        password = password.slice(0, -1)
        refresh()
        return
      }
      if (data.length === 1 && data >= ' ' && data !== '\x7f') {
        password += data
        refresh()
      }
    }

    function render(width: number): string[] {
      // AIDEV-NOTE: cache keyed on width — pi-tui can re-render on terminal
      // resize without calling invalidate(), so stale wider lines would trip
      // the width guard and crash the process.
      if (cachedLines && cachedWidth === width) return cachedLines
      const lines: string[] = []
      const add = (t: string) => lines.push(truncateToWidth(t, width))

      add(theme.fg('error', '─'.repeat(width)))
      add(theme.fg('error', theme.bold(' 🔐 ROOT COMMAND REQUEST')))
      lines.push('')
      addWrapped(
        lines,
        theme.fg(
          'muted',
          reason?.trim()
            ? ` Intent: ${reason.trim()}`
            : ' No reason provided by AI',
        ),
        width,
      )
      for (const line of command.split('\n')) {
        addWrapped(lines, theme.fg('accent', ` Command: ${line}`), width)
      }
      lines.push('')

      if (stage === 'confirm') {
        add(theme.fg('text', ' Allow this command to run as root?'))
        add(theme.fg('dim', ' y = Allow · n / Esc = Deny'))
      } else {
        add(theme.fg('text', ` Password: ${'●'.repeat(password.length)}`))
        add(theme.fg('dim', ' Enter = confirm · Esc = cancel'))
      }
      add(theme.fg('error', '─'.repeat(width)))
      cachedLines = lines
      cachedWidth = width
      return lines
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined
      },
      handleInput,
    }
  })
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'sudo_run',
    label: 'Run as root',
    description:
      'Execute a shell command with root (sudo) privileges. ' +
      'Always shows the user a confirmation dialog and asks for their sudo password before running — ' +
      'the command is NEVER executed without explicit approval. ' +
      'Use only when the task genuinely requires elevated permissions ' +
      '(e.g. writing to /etc, managing system services, installing packages system-wide). ' +
      'You MUST provide a clear `reason` explaining why root is needed.',
    promptSnippet:
      'Execute a shell command as root after user sees intent + password prompt',
    promptGuidelines: [
      'Use sudo_run only when root privileges are strictly required — prefer plain bash for everything else. ' +
        'Always set `reason` to a short plain-English sentence explaining why root is needed ' +
        '(e.g. "Installing a system package to /usr/local/bin").',
    ],
    parameters: Type.Object({
      command: Type.String({
        description: 'Shell command to run as root (passed to `sh -c`).',
      }),
      reason: Type.Optional(
        Type.String({
          description:
            'Short plain-English explanation of why root is needed. Shown to the user so they can make an informed decision.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { command, reason } = params

      // Masked password entry needs a real terminal driving ctx.ui.custom().
      if (!ctx.hasUI || ctx.mode !== 'tui') {
        return {
          content: [
            {
              type: 'text',
              text: 'sudo_run requires an interactive terminal session.',
            },
          ],
          details: makeDetails(command, reason, {
            outcome: 'error',
            errorKind: 'no-ui',
          }),
          isError: true,
        }
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Awaiting root approval…' }],
        details: makeDetails(command, reason, { outcome: 'awaiting-approval' }),
      })

      const overlay = await withUILock(() =>
        showSudoPrompt(ctx, command, reason),
      )

      if (overlay.action !== 'approved') {
        const outcome: SudoOutcome =
          overlay.action === 'timeout' ? 'timed-out' : 'denied'
        const msg =
          outcome === 'timed-out'
            ? 'Timed out — auto-denied.'
            : 'Denied by user.'
        ctx.ui.notify(`🔐 ${msg}`, 'warning')
        return {
          content: [{ type: 'text', text: `Cancelled — ${msg}` }],
          details: makeDetails(command, reason, { outcome }),
        }
      }

      const password = overlay.password ?? ''
      if (!password.trim()) {
        ctx.ui.notify('🔐 Cancelled — no password entered.', 'warning')
        return {
          content: [{ type: 'text', text: 'Cancelled — no password entered.' }],
          details: makeDetails(command, reason, { outcome: 'cancelled' }),
        }
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Running as root…' }],
        details: makeDetails(command, reason, { outcome: 'running' }),
      })

      let result: SudoResult
      try {
        result = await runWithSudo(command, password, signal)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text', text: `sudo_run failed: ${msg}` }],
          details: makeDetails(
            command,
            reason,
            signal?.aborted
              ? { outcome: 'cancelled' }
              : { outcome: 'error', errorKind: 'execution' },
          ),
          isError: signal?.aborted !== true,
        }
      }

      if (detectAuthFailure(result.code, result.stderr)) {
        ctx.ui.notify(
          '🔐 sudo authentication failed — wrong password.',
          'error',
        )
        return {
          content: [
            {
              type: 'text',
              text: 'sudo authentication failed — wrong password.',
            },
          ],
          details: makeDetails(command, reason, {
            outcome: 'error',
            exitCode: result.code,
            errorKind: 'authentication',
          }),
          isError: true,
        }
      }

      const combined =
        [result.stdout, result.stderr].filter(Boolean).join('\n') ||
        '(no output)'
      const { text: truncatedText, truncated } = truncate(combined)
      const suffix = truncated
        ? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
        : ''

      return {
        content: [
          {
            type: 'text',
            text: `Exit code: ${result.code}\n\n${truncatedText}${suffix}`,
          },
        ],
        details: makeDetails(command, reason, {
          outcome: result.code === 0 ? 'success' : 'error',
          exitCode: result.code,
          ...(result.code === 0 ? {} : { errorKind: 'execution' as const }),
        }),
        isError: result.code !== 0,
      }
    },

    renderCall(args: { command: string; reason?: string }, theme) {
      const label = theme.fg('toolTitle', theme.bold('sudo '))
      const firstLine = (args.command ?? '').split('\n')[0] ?? ''
      const rest = (args.command ?? '').includes('\n')
        ? theme.fg('dim', ' …')
        : ''
      return new Text(`${label}${theme.fg('accent', firstLine)}${rest}`, 0, 0)
    },

    renderResult(result, _opt, theme, context) {
      const details = result.details as SudoResultDetails | undefined
      const firstText =
        result.content[0]?.type === 'text' ? result.content[0].text : ''

      if (!details) {
        return new Text(
          context.isError ? theme.fg('error', firstText) : firstText,
          0,
          0,
        )
      }
      if (
        details.outcome === 'denied' ||
        details.outcome === 'timed-out' ||
        details.outcome === 'cancelled'
      ) {
        return new Text(theme.fg('warning', firstText), 0, 0)
      }
      if (details.outcome === 'error') {
        return new Text(theme.fg('error', firstText), 0, 0)
      }
      return new Text(firstText, 0, 0)
    },
  })
}
