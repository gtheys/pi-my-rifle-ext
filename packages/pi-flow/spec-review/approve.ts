// AIDEV-NOTE: shared label+metadata transition helper for /spec-review
// (PMR-MR36), designed for reuse by the follow-up flows (PMR-SE93, PMR-EZHA).
// Approving a spec pins it to the `plan` label, marks plan-state=approved, and
// moves it to todo so the plan implementation phase picks it up. aven edit
// errors print "Error: ..." possibly with exit 0 — failure detection is by
// output text ("updated <REF>" must appear on success), loud error result
// carries aven's raw output.

import type { AvenRunner } from '../flow/jira-ref.ts'

export type ApproveResult =
  | { kind: 'ok'; ref: string }
  | { kind: 'error'; reason: string }

export async function approveSpec(
  aven: AvenRunner,
  ref: string,
  opts: { workspace?: string } = {},
): Promise<ApproveResult> {
  const args = [
    'edit',
    ref,
    '--metadata',
    'plan-state=approved',
    '--label',
    'plan',
    '--status',
    'todo',
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
    return { kind: 'error', reason: `aven edit ${ref} failed: ${msg}` }
  }
  const updated = new RegExp(`^updated ${ref}(\\s|$)`, 'm').test(stdout)
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
