/**
 * Aven Context Extension
 *
 * Injects live aven workspace state (open issues, active/ready/blocked tasks)
 * as a hidden custom message at session start, so the agent begins with
 * current task context. Runs `aven prime` from the session cwd (aven infers
 * workspace + project from cwd routing) and strips the static CLI primer
 * head — the primer is already available statically via the aven skill.
 *
 * Non-fatal: a missing/slow aven binary silently skips injection.
 * Idempotent: skips if the session already carries an aven-context entry
 * (resume/fork/reload reuse the existing entry instead of duplicating it).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const execFileAsync = promisify(execFile)

const CUSTOM_TYPE = 'aven-context'
// ponytail: brittle string marker — if aven renames the section, stripPrimer
// returns '' and we skip injection rather than dump 200 lines of static primer
const PRIMER_MARKER = '## Local Conventions'
const AVEN_TIMEOUT_MS = 5_000

// AIDEV-NOTE: prime output = static CLI primer + live workspace sections.
// Only the tail from "## Local Conventions" onward belongs in session context.
export function stripPrimer(primeOutput: string): string {
  const idx = primeOutput.indexOf(PRIMER_MARKER)
  if (idx === -1) return ''
  return primeOutput.slice(idx).trim()
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    // AIDEV-NOTE: getBranch() walks leaf→root, so this also covers sessions
    // resumed/forked from a session that already had context injected.
    const alreadyInjected = ctx.sessionManager
      .getBranch()
      .some((e) => e.type === 'custom_message' && e.customType === CUSTOM_TYPE)
    if (alreadyInjected) return

    let primeOutput: string
    try {
      const r = await execFileAsync('aven', ['prime'], {
        cwd: ctx.cwd,
        timeout: AVEN_TIMEOUT_MS,
      })
      primeOutput = r.stdout
    } catch {
      // aven missing, db locked, or timed out — context injection never
      // blocks or breaks session startup.
      return
    }

    const context = stripPrimer(primeOutput)
    if (!context) return

    // AIDEV-NOTE: pi.sendMessage appends a custom_message entry (participates
    // in LLM context); triggerTurn:false keeps injection passive — no agent run.
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: [
          'Aven workspace state (live, from `aven prime`):',
          '',
          context,
          '',
          'Aven CLI reference: see the aven skill.',
        ].join('\n'),
        display: false,
      },
      { triggerTurn: false },
    )
  })
}
