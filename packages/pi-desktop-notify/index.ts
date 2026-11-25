/**
 * Desktop Notification Extension
 *
 * Sends notifications when pi finishes work after an idle period, or when pi
 * is waiting for user input. Channels:
 * - desktop (notify-send)
 * - herdr (when running inside a herdr session)
 * - ntfy (homelab push server, configurable)
 *
 * Usage:
 * - `/notify`         — toggle notifications on/off
 * - `/notify on`      — enable
 * - `/notify off`     — disable
 * - `/notify idle`    — show current idle threshold
 * - `/notify idle 60` — set idle threshold to 60 seconds
 * - `/notify test`    — send a test notification on every enabled channel
 *
 * Channel configuration lives in pi-desktop-notify/config.json (global +
 * project override); see config.ts and the README.
 *
 * State persists across sessions via appendEntry.
 */

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  buildNtfyRequest,
  channelEnabled,
  DEFAULT_HERDR_SOUND,
  type DesktopNotifyConfig,
  loadConfig,
  notifyOnPromptEnabled,
} from './config.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_IDLE_THRESHOLD_MS = 30_000 // 30 seconds

interface NotifyState {
  enabled: boolean
  idleThresholdMs: number
}

function loadState(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): NotifyState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (
      e.type === 'custom' &&
      e.customType === 'desktop-notify-state' &&
      e.data
    ) {
      return e.data as NotifyState
    }
  }
  return { enabled: true, idleThresholdMs: DEFAULT_IDLE_THRESHOLD_MS }
}

export default function (pi: ExtensionAPI) {
  let state: NotifyState = {
    enabled: true,
    idleThresholdMs: DEFAULT_IDLE_THRESHOLD_MS,
  }
  let config: DesktopNotifyConfig = {}
  let lastAgentEndTs = 0

  pi.on('session_start', async (_event, ctx) => {
    state = loadState(ctx.sessionManager.getEntries())
    lastAgentEndTs = 0
    try {
      config = await loadConfig(ctx.cwd)
    } catch (error: unknown) {
      config = {}
      const msg = error instanceof Error ? error.message : String(error)
      // Fail loudly, not silently: desktop notifications still work, but the
      // user learns their config is broken.
      ctx.ui.notify(`pi-desktop-notify: ${msg}`, 'error')
    }
  })

  // Send `summary`/`body` on every enabled channel. Best-effort per channel:
  // a failing channel never blocks the others.
  async function dispatch(summary: string, body: string): Promise<void> {
    if (channelEnabled(config, 'desktop')) {
      try {
        await execFileAsync('notify-send', [
          '--app-name=pi',
          '--icon=utilities-terminal',
          summary,
          body,
        ])
      } catch (_e) {
        // Silently ignore — notification daemon may not be running
      }
    }

    // AIDEV-NOTE: herdr channel mirrors the desktop one — same enabled flag,
    // same best-effort semantics. Gated on HERDR_ENV so we don't spawn herdr
    // outside a herdr session.
    if (process.env.HERDR_ENV === '1' && channelEnabled(config, 'herdr')) {
      let sound = DEFAULT_HERDR_SOUND
      if (config.herdr?.sound !== undefined) sound = config.herdr.sound
      try {
        await execFileAsync('herdr', [
          'notification',
          'show',
          summary,
          '--body',
          body,
          '--sound',
          sound,
        ])
      } catch (_e) {
        // Silently ignore — herdr server may not be running
      }
    }

    if (channelEnabled(config, 'ntfy') && config.ntfy !== undefined) {
      const req = buildNtfyRequest(config.ntfy, summary, body)
      try {
        await fetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(req.timeoutMs),
        })
      } catch (_e) {
        // Silently ignore — ntfy server may be unreachable
      }
    }
  }

  pi.on('agent_start', async (_event, _ctx) => {
    // Track when agent starts — we'll check idle gap on agent_end
  })

  pi.on('agent_end', async (_event, ctx) => {
    const now = Date.now()
    const previousEnd = lastAgentEndTs
    const idleBeforeRun = now - previousEnd
    lastAgentEndTs = now

    if (!state.enabled) return
    // AIDEV-NOTE: Only notify when the user was idle long enough before this run.
    // previousEnd===0 means first run in this session → always notify (idleBeforeRun is huge).
    // Using previousEnd (captured before overwrite) so the guard is never trivially true.
    if (previousEnd !== 0 && idleBeforeRun < state.idleThresholdMs) return

    // Extract snippet from last assistant message
    const entries = ctx.sessionManager.getBranch()
    let snippet = ''
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.type === 'message' && e.message?.role === 'assistant') {
        const content = e.message.content
        if (typeof content === 'string') {
          snippet = content
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              snippet = block.text ?? ''
              break
            }
          }
        }
        break
      }
    }

    // Truncate body to ~200 chars, collapse whitespace
    const body = snippet.replace(/\s+/g, ' ').trim().slice(0, 200)
    const folder = basename(ctx.cwd)

    const summary = `pi finished — ${folder}`
    const fullBody = body || '(no output)'

    await dispatch(summary, fullBody)
  })

  // AIDEV-NOTE: "needs input" notifications bypass the idle threshold — a
  // blocking prompt is worth interrupting for, even mid-session. Pi coalesces
  // nested/overlapping prompts into one outer span, so this fires once per
  // waiting period. Gated by notifyOnPrompt config (default true).
  pi.on('ui_prompt_start', async (event, ctx) => {
    if (!state.enabled) return
    if (!notifyOnPromptEnabled(config)) return

    const folder = basename(ctx.cwd)
    let title: string = event.kind
    if (event.title !== undefined && event.title !== '') {
      title = event.title
    }
    await dispatch(`pi needs input — ${folder}`, title)
  })

  pi.registerCommand('notify', {
    description:
      'Toggle or configure notifications (on/off/idle <seconds>/test)',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const action = parts[0]?.toLowerCase()

      if (action === 'on') {
        state.enabled = true
        pi.appendEntry('desktop-notify-state', state)
        ctx.ui.notify('Notifications enabled', 'info')
        return
      }
      if (action === 'off') {
        state.enabled = false
        pi.appendEntry('desktop-notify-state', state)
        ctx.ui.notify('Notifications disabled', 'info')
        return
      }
      if (action === 'idle') {
        const secs = parseInt(parts[1], 10)
        if (Number.isNaN(secs) || secs < 1) {
          ctx.ui.notify(
            `Idle threshold: ${state.idleThresholdMs / 1000}s`,
            'info',
          )
          return
        }
        state.idleThresholdMs = secs * 1000
        pi.appendEntry('desktop-notify-state', state)
        ctx.ui.notify(`Idle threshold set to ${secs}s`, 'info')
        return
      }
      if (action === 'test') {
        let channels = 'none (check config)'
        const names: string[] = []
        if (channelEnabled(config, 'desktop')) names.push('desktop')
        if (channelEnabled(config, 'herdr')) names.push('herdr')
        if (channelEnabled(config, 'ntfy')) names.push('ntfy')
        if (names.length > 0) channels = names.join(', ')
        ctx.ui.notify(`Sending test notification via: ${channels}`, 'info')
        await dispatch('pi-desktop-notify test', 'If you see this, it works.')
        return
      }

      // AIDEV-NOTE: only a bare /notify toggles. Unknown subcommands must NOT
      // fall through to the toggle — that made `/notify test` on a stale
      // session look like it flipped notifications on/off.
      if (action !== undefined && action !== '') {
        ctx.ui.notify(
          `Unknown subcommand "${action}" — usage: /notify [on|off|idle [seconds]|test]`,
          'error',
        )
        return
      }

      // No arg — toggle
      state.enabled = !state.enabled
      let notifyStatus: string
      if (state.enabled) {
        notifyStatus = 'enabled'
      } else {
        notifyStatus = 'disabled'
      }
      pi.appendEntry('desktop-notify-state', state)
      ctx.ui.notify(`Notifications ${notifyStatus}`, 'info')
    },
  })
}
