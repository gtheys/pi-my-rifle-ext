// AIDEV-NOTE: DELIBERATE DUPLICATION from packages/pi-planning/plan-tools/
// open-in-pane.ts — cross-package runtime imports are forbidden in this
// repo, so openFileInPane is copied here for /spec-review. Keep the two
// copies in sync (source of truth: pi-planning).

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type OpenInPaneResult = {
  content: Array<{ type: 'text'; text: string }>
  details: { ok: boolean; paneId?: string }
}

export async function openFileInPane(
  pi: ExtensionAPI,
  file: string,
  command = 'nvim',
): Promise<OpenInPaneResult> {
  const absFile = resolve(file)
  // AIDEV-NOTE: shell-quote for herdr pane send-text — the pane's shell
  // parses the text, so single quotes in the path must be escaped
  // (same one-liner as shellEscape in pi-interactive-subagents surface.ts;
  // duplicate on purpose — no cross-package imports).
  const quotedFile = absFile.replace(/'/g, "'\\''")

  if (!existsSync(absFile)) {
    return {
      content: [{ type: 'text', text: `File not found: ${absFile}` }],
      details: { ok: false },
    }
  }

  // AIDEV-NOTE: herdr CLI called directly — deliberate: no cross-package
  // dependency for 4 exec calls (see pi-planning twin: plan 2026-09-07-open-spec-file-with-glow).
  try {
    const split = await pi.exec(
      'herdr',
      [
        'pane',
        'split',
        '--direction',
        'right',
        '--no-focus',
        '--cwd',
        dirname(absFile),
        '--current',
      ],
      {},
    )
    const parsed: unknown = JSON.parse(split.stdout)
    const result = parsed as {
      result?: { pane?: { pane_id?: unknown } }
    }
    const paneId = result.result?.pane?.pane_id
    if (typeof paneId !== 'string') {
      throw new Error('herdr pane split: missing pane_id in response')
    }

    try {
      await pi.exec('herdr', ['pane', 'rename', paneId, 'spec-review'], {})
    } catch {
      // cosmetic, non-fatal
    }

    await pi.exec(
      'herdr',
      ['pane', 'send-text', paneId, `${command} '${quotedFile}'`],
      {},
    )
    await pi.exec('herdr', ['pane', 'send-keys', paneId, 'return'], {})

    return {
      content: [{ type: 'text', text: `Opened ${absFile} in pane ${paneId}` }],
      details: { ok: true, paneId },
    }
  } catch {
    return {
      content: [
        {
          type: 'text',
          text: `${absFile}\nherdr unavailable — open manually: nvim ${quotedFile}`,
        },
      ],
      details: { ok: false },
    }
  }
}
