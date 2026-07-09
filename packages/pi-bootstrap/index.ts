import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

// AIDEV-NOTE: Symlinks agents/AGENTS.md → ~/.pi/agent/AGENTS.md on startup.
// Silent once correctly linked. Repairs a dangling symlink; warns only if a
// different real file (or a valid symlink pointing elsewhere) occupies the target.
export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup') return

    const source = fileURLToPath(
      new URL('../../agents/AGENTS.md', import.meta.url),
    )
    const target = join(homedir(), '.pi', 'agent', 'AGENTS.md')

    // Classify whatever currently sits at the target.
    let isSymlink = false
    let isFile = false
    try {
      const st = lstatSync(target)
      isSymlink = st.isSymbolicLink()
      isFile = !isSymlink
    } catch {
      // target absent
    }

    if (isSymlink) {
      const pointsTo = readlinkSync(target)
      // Already linked to our source → done, stay silent (idempotent).
      if (pointsTo === source) return
      // Valid symlink pointing elsewhere → respect the user's own link.
      if (existsSync(target)) {
        ctx.ui.notify(
          `AGENTS.md at ${target} → ${pointsTo} — leaving existing link. Remove it manually to let this package manage it.`,
          'warning',
        )
        return
      }
      // Dangling symlink → drop it so we can recreate it correctly below.
      rmSync(target)
    } else if (isFile) {
      // A real file occupies the target — don't clobber it.
      ctx.ui.notify(
        `AGENTS.md already exists at ${target} — skipping install. Remove it manually to let this package manage it.`,
        'warning',
      )
      return
    }

    try {
      symlinkSync(source, target)
      ctx.ui.notify(`AGENTS.md installed: ${target} → ${source}`, 'info')
    } catch (e) {
      ctx.ui.notify(`Failed to install AGENTS.md: ${e}`, 'error')
    }
  })
}
