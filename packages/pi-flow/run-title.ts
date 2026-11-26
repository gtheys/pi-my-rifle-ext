/**
 * Run-title resolution for the pi-flow journal (PMR-9DZ0).
 *
 * AIDEV-NOTE: PMR-9DZ0 — sanitizeTitle MUST run at journal-write time, not at
 * render time. The run journal is JSONL: one event object per line, so a
 * multi-line title would corrupt the line format and every consumer of the
 * journal. The render path (flow/run-health.ts) trusts the journal and only
 * exposition-escapes label values — this sanitizer is the single guard.
 *
 * AIDEV-NOTE: session-side module (imports fetchJiraIssue, which shells out to
 * acli via pi.exec). Imported only by index.ts; never add it to the four
 * node-only closure roots guarded by test/cost-rows-node-only.test.ts.
 *
 * AIDEV-NOTE: resolveRunTitle NEVER throws by design — the title is a cosmetic
 * enrichment of a run-start event; a failing acli lookup must not abort the
 * flow run. Every failure path returns a warning string instead.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { fetchJiraIssue } from './plan-tools/jira-issue.ts'
import type { WorkMode } from './work-mode.ts'

/** Hard cap for journaled/rendered titles (Grafana table/barchart cells). */
export const TITLE_MAX = 120

// AIDEV-NOTE: order matters (pinned by test/run-title.test.ts): control chars
// → space, collapse whitespace, trim, empty→undefined, THEN cap. Capping last
// means the cap sees a normalized string; capping first could leave a trailing
// space inside the 120-char window.
export function sanitizeTitle(raw: string): string | undefined {
  let value = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  if (!value) {
    return undefined
  }
  return value.slice(0, TITLE_MAX)
}

export interface RunTitleInput {
  mode: WorkMode
  /** Personal mode only: the title from the aven snapshot read (zero extra calls). */
  avenTitle?: string
  /** Work mode only: typed Jira ID, else the epic's jira-ref metadata, else null. */
  jiraKey: string | null
}

export interface RunTitleResult {
  title?: string
  warning: string | null
}

/**
 * Resolve the run title best-effort. Never throws: every failure becomes a
 * warning string so the caller can journal run-start without a title and keep
 * the flow running.
 */
export async function resolveRunTitle(
  pi: ExtensionAPI,
  input: RunTitleInput,
): Promise<RunTitleResult> {
  if (input.mode === 'personal') {
    const avenTitle = sanitizeTitle(input.avenTitle ?? '')
    if (avenTitle === undefined) {
      return { warning: null }
    }
    return { title: avenTitle, warning: null }
  }
  if (input.jiraKey === null) {
    return { warning: null }
  }
  try {
    const issue = await fetchJiraIssue(pi, input.jiraKey)
    const title = sanitizeTitle(issue.summary)
    if (title === undefined) {
      return { warning: null }
    }
    return { title, warning: null }
  } catch (error) {
    return { warning: lookupWarning(input.jiraKey, error) }
  }
}

function lookupWarning(jiraKey: string, error: unknown): string {
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else {
    message = String(error)
  }
  return `title lookup failed for ${jiraKey} — continuing without a title (${message})`
}
