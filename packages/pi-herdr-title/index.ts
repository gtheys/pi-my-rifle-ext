/**
 * Herdr pane title — renames the current herdr pane to `Pi - <cwd>` on
 * session start. No-op outside herdr (HERDR_PANE_ID unset).
 */

import { execFile } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    const paneId = process.env.HERDR_PANE_ID
    if (!paneId) return
    execFile('herdr', ['pane', 'rename', paneId, `Pi - ${ctx.cwd}`], () => {
      // best effort — herdr CLI missing/slow must never affect the session
    })
  })
}
