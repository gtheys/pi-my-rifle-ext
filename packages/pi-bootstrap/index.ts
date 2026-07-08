import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { lstatSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

// AIDEV-NOTE: Symlinks agents/AGENTS.md → ~/.pi/agent/AGENTS.md on startup.
// Warns and skips if target already exists (symlink or file).
export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup') return

    const source = fileURLToPath(
      new URL('../agents/AGENTS.md', import.meta.url),
    )
    const target = join(homedir(), '.pi', 'agent', 'AGENTS.md')

    try {
      lstatSync(target)
      // Target exists (file or symlink) — warn and skip
      ctx.ui.notify(
        `AGENTS.md already exists at ${target} — skipping install. Remove it manually to let this package manage it.`,
        'warning',
      )
      return
    } catch {
      // Target does not exist — safe to create symlink
    }

    try {
      symlinkSync(source, target)
      ctx.ui.notify(`AGENTS.md installed: ${target} → ${source}`, 'info')
    } catch (e) {
      ctx.ui.notify(`Failed to install AGENTS.md: ${e}`, 'error')
    }
  })
}
