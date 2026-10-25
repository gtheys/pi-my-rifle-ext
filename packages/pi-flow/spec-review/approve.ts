// AIDEV-NOTE: shared label+metadata transition helper for /spec-review
// (PMR-MR36), designed for reuse by the follow-up flows (PMR-SE93, PMR-EZHA).
// Approving a spec pins plan-state=approved and moves it to todo so the plan
// implementation phase picks it up. The `plan` label is added ONLY for
// non-oneshot tickets: a oneshot-confirmed ticket with the plan label would
// misroute /implement onto the plan route with no children and no tree. aven
// edit errors print "Error: ..." possibly with exit 0 — failure detection is
// by output text ("updated <REF>" must appear on success), loud error result
// carries aven's raw output.

import type { AvenRunner } from '../flow/jira-ref.ts'
import { escapeRegExp } from './escape-regexp.ts'

export type ApproveResult =
  | { kind: 'ok'; ref: string }
  | { kind: 'error'; reason: string }

// AIDEV-NOTE: labels read via `aven show <ref> --json`; any failure (aven
// down, bad JSON) keeps the legacy `--label plan` behavior — the oneshot
// check is an omission optimization, not a new failure mode.
async function readLabels(
  aven: AvenRunner,
  ref: string,
  workspace: string | undefined,
): Promise<string[] | null> {
  const args = ['show', ref, '--json']
  if (workspace !== undefined) {
    args.push('--workspace', workspace)
  }
  try {
    const { stdout, stderr } = await aven(args)
    const failed =
      /^(Error:|error\s)/m.test(stdout) || /^(Error:|error\s)/m.test(stderr)
    if (failed) {
      return null
    }
    const parsed: unknown = JSON.parse(stdout)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { labels?: unknown }).labels)
    ) {
      return (parsed as { labels: unknown[] }).labels.filter(
        (l): l is string => typeof l === 'string',
      )
    }
    return null
  } catch {
    return null
  }
}

export async function approveSpec(
  aven: AvenRunner,
  ref: string,
  opts: { workspace?: string } = {},
): Promise<ApproveResult> {
  const labels = await readLabels(aven, ref, opts.workspace)
  const isOneshot = labels?.includes('oneshot') === true
  const args = ['edit', ref, '--metadata', 'plan-state=approved']
  if (!isOneshot) {
    args.push('--label', 'plan')
  }
  args.push('--status', 'todo')
  if (opts.workspace !== undefined) {
    args.push('--workspace', opts.workspace)
  }
  let stdout = ''
  let stderr = ''
  try {
    const out = await aven(args)
    stdout = out.stdout
    stderr = out.stderr
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { kind: 'error', reason: `aven edit ${ref} failed: ${msg}` }
  }
  const updated = new RegExp(`^updated ${escapeRegExp(ref)}(\\s|$)`, 'm').test(
    stdout,
  )
  if (!updated) {
    const raw = [stdout.trim(), stderr.trim()]
      .filter((s) => s !== '')
      .join('\n')
    return {
      kind: 'error',
      reason: `aven edit ${ref} did not report success: ${raw.slice(0, 300)}`,
    }
  }
  return { kind: 'ok', ref }
}
