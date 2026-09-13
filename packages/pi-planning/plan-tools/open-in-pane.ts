/**
 * open_in_pane tool — open a file (spec/plan) with nvim in a new herdr pane for review.
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

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

  if (!existsSync(absFile)) {
    return {
      content: [{ type: 'text', text: `File not found: ${absFile}` }],
      details: { ok: false },
    }
  }

  // AIDEV-NOTE: herdr CLI called directly — deliberate: no cross-package
  // dependency on pi-interactive-subagents for 3 exec calls (plan 2026-09-07-open-spec-file-with-glow).
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
      ['pane', 'send-text', paneId, `${command} '${absFile}'`],
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
          text: `${absFile}\nherdr unavailable — open manually: nvim ${absFile}`,
        },
      ],
      details: { ok: false },
    }
  }
}

export function registerOpenInPane(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'open_in_pane',
    label: 'Open File in Pane',
    description:
      'Open a file with nvim (or another command) in a new herdr pane for review. Non-fatal: returns the path and a manual-open note if herdr is unavailable.',
    promptSnippet: 'Open a spec/plan file with nvim in a herdr review pane',
    parameters: Type.Object({
      file: Type.String({ description: 'Absolute path to the file to open' }),
      command: Type.Optional(
        Type.String({ description: 'Command to run (default: nvim)' }),
      ),
    }),
    async execute(_id, params) {
      return openFileInPane(pi, params.file, params.command ?? 'nvim')
    },
  })
}
