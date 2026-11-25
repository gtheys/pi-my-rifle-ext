// AIDEV-NOTE: PMR-ZV9Y 5.1 — extracted dispatch surface for pi-desktop-notify.
// The channel blocks (notify-send / herdr / ntfy, best-effort per channel) moved
// here VERBATIM from index.ts's local `dispatch()` so non-extension callers can
// reuse the user's channel configuration without loading the extension. This
// subpath is consumed by pi-flow's flow-state notifications (PMR-ZV9Y 5.2),
// which dynamically imports '@gtheys/pi-desktop-notify/notify', loads the
// config with the re-exported `loadConfig`, then calls `dispatchNotification`.
//
// Node-only bar (relaxed criterion (i), decided in PMR-ZV9Y 5.1): notify.ts must
// not DIRECTLY import the pi runtime — only node builtins + ./config.ts. The
// re-exported `loadConfig` lives in config.ts, which value-imports
// @earendil-works/pi-coding-agent (getAgentDir / CONFIG_DIR_NAME), so the
// subpath pulls that package transitively. That is accepted: the only consumer
// (pi-flow) already runs inside a pi session, so unlike the pi-flow daemon path
// (PMR-8MQH's node-only closure in flow/cost-rows.ts) there is no
// pi-runtime-free process this has to stay reachable from. Do not add a direct
// pi import here — notify.test.ts guards the import list.
//
// Keep behavior identical to index.ts's hooks: every channel is best-effort and
// a failing channel must never block the remaining ones (see the per-channel
// try/catch below and the 'best-effort per channel' suite in notify.test.ts).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildNtfyRequest,
  channelEnabled,
  DEFAULT_HERDR_SOUND,
  type DesktopNotifyConfig,
} from './config.ts'

// The subpath surface PMR-ZV9Y 5.2 consumes: the config types, the loader,
// and dispatchNotification below. Re-exported rather than re-implemented so
// config resolution stays single-sourced in config.ts.
export type { DesktopNotifyConfig, NtfyConfig } from './config.ts'
export { loadConfig } from './config.ts'

const execFileAsync = promisify(execFile)

/**
 * Send `summary`/`body` on every enabled channel. Best-effort per channel:
 * a failing channel never blocks the others.
 */
export async function dispatchNotification(
  config: DesktopNotifyConfig,
  summary: string,
  body: string,
): Promise<void> {
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
