// AIDEV-NOTE: aven query half of /spec-review (PMR-MR36). aven prints errors
// (unknown-metadata-field, unknown-ref, "error " prefixed lines) WITH EXIT 0,
// so every failure is detected by stdout text — never by exit code. Loud
// failure = an 'error' result carrying aven's raw output; never throw across
// the module boundary, never swallow. `aven list --json` omits metadata
// entirely on aven 0.1.39, so plan-path is read from `aven show <ref> --full`
// human text, trusting only `metadata field_id=... key=<k>` / value<<EOF
// blocks (description text may contain the words "plan-path").

import type { AvenRunner } from '../flow/jira-ref.ts'
import { escapeRegExp } from './escape-regexp.ts'

export interface SpecInReview {
  ref: string
  title: string
}

export type SpecListResult =
  | { kind: 'ok'; specs: SpecInReview[] }
  | { kind: 'error'; reason: string }

export type PlanPathResult =
  | {
      kind: 'found'
      planPath: string
      planState: string | null
    }
  | { kind: 'none' }
  | { kind: 'error'; reason: string }

// AIDEV-NOTE: conservative extension of flow/jira-ref.ts detection. aven can
// fail with exit 0; classify by text and fail loud. unknown-metadata-field is
// NOT special-cased here: for plan-state=review the field should exist by the
// time /spec-review runs, so treat it as a real error rather than "empty".
// AIDEV-NOTE: exported for readPlanState (flow loop's awaiting-approval gate,
// PMR-W60H) — same parsing path, one metadata contract.
export function avenErrorText(stdout: string, stderr: string): string | null {
  const lines = [...stdout.split('\n'), ...stderr.split('\n')]
  const bad = lines.find((line) => /^(Error:|error\s)/.test(line.trim()))
  if (bad !== undefined) {
    return [stdout.trim(), stderr.trim()].filter((s) => s !== '').join('\n')
  }
  return null
}

export async function listSpecsInReview(
  aven: AvenRunner,
  opts: { project: string; workspace?: string },
): Promise<SpecListResult> {
  const args = [
    'list',
    '--project',
    opts.project,
    '--metadata',
    'plan-state=review',
    '--open',
    '--json',
  ]
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
    return { kind: 'error', reason: `aven list failed: ${msg}` }
  }
  const failure = avenErrorText(stdout, stderr)
  if (failure !== null) {
    return { kind: 'error', reason: `aven list failed: ${failure}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      kind: 'error',
      reason: `aven list returned bad JSON: ${stdout.slice(0, 120)}`,
    }
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'error', reason: 'aven list JSON was not an array' }
  }
  const specs: SpecInReview[] = parsed.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const ref = (entry as { ref?: unknown }).ref
    if (typeof ref !== 'string' || ref === '') return []
    const rawTitle = (entry as { title?: unknown }).title
    const title = typeof rawTitle === 'string' ? rawTitle : ref
    return [{ ref, title }]
  })
  return { kind: 'ok', specs }
}

// AIDEV-NOTE: only trust `metadata field_id=... key=<k>` blocks followed by a
// value<<EOF ... EOF heredoc; anything else in the output (including a
// description mentioning "plan-path") is ignored.
export function parseMetadataBlock(text: string, key: string): string | null {
  const re = new RegExp(
    `^metadata field_id=\\S+ key=${escapeRegExp(key)}$\\n^value<<EOF$\\n([\\s\\S]*?)\\n^EOF$`,
    'm',
  )
  const match = re.exec(text)
  if (match === null) return null
  return match[1] ?? null
}

export async function readPlanPath(
  aven: AvenRunner,
  ref: string,
  opts: { workspace?: string } = {},
): Promise<PlanPathResult> {
  const args = ['show', ref, '--full']
  // AIDEV-NOTE: PMR-MR36 fix round — the workspace must ride along with the
  // per-ref query, or a cross-workspace pick resolves its plan path against
  // the cwd-inferred workspace and fails.
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
    return { kind: 'error', reason: `aven show failed: ${msg}` }
  }
  const failure = avenErrorText(stdout, stderr)
  if (failure !== null) {
    return { kind: 'error', reason: `aven show ${ref} failed: ${failure}` }
  }
  const planPath = parseMetadataBlock(stdout, 'plan-path')
  if (planPath === null) return { kind: 'none' }
  const planState = parseMetadataBlock(stdout, 'plan-state')
  return { kind: 'found', planPath, planState }
}
