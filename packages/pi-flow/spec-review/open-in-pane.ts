// AIDEV-NOTE: PMR-XCA9 — single surviving copy. pi-planning's twin
// (plan-tools/open-in-pane.ts, source of truth until the absorption) was
// retired with the package; registerOpenInPane moved here with it.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

type OpenInPaneResult = {
  content: Array<{ type: 'text'; text: string }>
  details: { ok: boolean; paneId?: string }
}

type WaitOptions = { attempts?: number; delayMs?: number }

// AIDEV-NOTE: PMR-R0JD — a plan write can race the open_in_pane call, so
// poll briefly (default 5 x 200ms) before reporting the file missing.
async function waitForFile(
  file: string,
  { attempts = 5, delayMs = 200 }: WaitOptions,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (existsSync(file)) return true
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return existsSync(file)
}

export async function openFileInPane(
  pi: ExtensionAPI,
  file: string,
  command = 'nvim',
  wait: WaitOptions = {},
): Promise<OpenInPaneResult> {
  const absFile = resolve(file)
  // AIDEV-NOTE: shell-quote for herdr pane send-text — the pane's shell
  // parses the text, so single quotes in the path must be escaped
  // (same one-liner as shellEscape in pi-interactive-subagents surface.ts;
  // duplicate on purpose — no cross-package imports).
  const quotedFile = absFile.replace(/'/g, "'\\''")

  if (!(await waitForFile(absFile, wait))) {
    return {
      content: [{ type: 'text', text: `File not found: ${absFile}` }],
      details: { ok: false },
    }
  }

  // AIDEV-NOTE: herdr CLI called directly — deliberate: no cross-package
  // dependency on pi-interactive-subagents for 4 exec calls (plan 2026-09-07-open-spec-file-with-glow).
  // AIDEV-NOTE: subagent panes live in ephemeral tabs that
  // pi-interactive-subagents closes (pane + tab) when the subagent exits, so
  // a review pane split from the calling pane dies with that tab. When the
  // subagent spawn env (PI_SUBAGENT_ID) is present, open a dedicated durable
  // tab instead — it outlives the subagent cleanup. Workspace id comes from
  // the inherited herdr env; without it fall back to the legacy split path.
  const workspaceId = process.env.HERDR_WORKSPACE_ID
  const inSubagent =
    process.env.PI_SUBAGENT_ID !== undefined && workspaceId !== undefined

  try {
    let paneId: string
    if (inSubagent) {
      const created = await pi.exec(
        'herdr',
        [
          'tab',
          'create',
          '--workspace',
          workspaceId,
          '--cwd',
          dirname(absFile),
          '--label',
          'spec-review',
          '--no-focus',
        ],
        {},
      )
      const parsed: unknown = JSON.parse(created.stdout)
      const result = parsed as {
        result?: { root_pane?: { pane_id?: unknown } }
      }
      const rootPaneId = result.result?.root_pane?.pane_id
      if (typeof rootPaneId !== 'string') {
        throw new Error(
          'herdr tab create: missing root_pane.pane_id in response',
        )
      }
      paneId = rootPaneId
    } else {
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
      const splitPaneId = result.result?.pane?.pane_id
      if (typeof splitPaneId !== 'string') {
        throw new Error('herdr pane split: missing pane_id in response')
      }
      paneId = splitPaneId

      try {
        await pi.exec('herdr', ['pane', 'rename', paneId, 'spec-review'], {})
      } catch {
        // cosmetic, non-fatal
      }
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

// AIDEV-NOTE: PMR-XCA9 — tool registration moved from pi-planning's
// plan-tools/open-in-pane.ts; registerOpenInPane is a thin wrapper.
export function registerOpenInPane(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'open_in_pane',
    label: 'Open File in Pane',
    description:
      'Open a file with nvim in a herdr review pane (from a subagent: a durable spec-review tab that survives subagent cleanup). Non-fatal: returns the path and a manual-open note if herdr is unavailable.',
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
