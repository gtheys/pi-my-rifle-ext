/**
 * Desktop Notification Extension
 *
 * Sends desktop notifications (via notify-send) when pi finishes work
 * after an idle period. Avoids spamming during active back-and-forth.
 *
 * Usage:
 * - `/notify`       — toggle notifications on/off
 * - `/notify on`    — enable
 * - `/notify off`   — disable
 * - `/notify idle`  — show current idle threshold
 * - `/notify idle 60` — set idle threshold to 60 seconds
 *
 * State persists across sessions via appendEntry.
 */

import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

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
  let lastAgentEndTs = 0

  pi.on('session_start', async (_event, ctx) => {
    state = loadState(ctx.sessionManager.getEntries())
    lastAgentEndTs = 0
  })

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

    try {
      await execFileAsync('notify-send', [
        '--app-name=pi',
        '--icon=utilities-terminal',
        summary,
        fullBody,
      ])
    } catch (e) {
      // Silently ignore — notification daemon may not be running
    }
  })

  pi.registerCommand('notify', {
    description:
      'Toggle or configure desktop notifications (on/off/idle <seconds>)',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/)
      const action = parts[0]?.toLowerCase()

      if (action === 'on') {
        state.enabled = true
        pi.appendEntry('desktop-notify-state', state)
        ctx.ui.notify('Desktop notifications enabled', 'info')
        return
      }
      if (action === 'off') {
        state.enabled = false
        pi.appendEntry('desktop-notify-state', state)
        ctx.ui.notify('Desktop notifications disabled', 'info')
        return
      }
      if (action === 'idle') {
        const secs = parseInt(parts[1], 10)
        if (isNaN(secs) || secs < 1) {
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

      // No arg or unknown — toggle
      state.enabled = !state.enabled
      pi.appendEntry('desktop-notify-state', state)
      ctx.ui.notify(
        `Desktop notifications ${state.enabled ? 'enabled' : 'disabled'}`,
        'info',
      )
    },
  })
}
