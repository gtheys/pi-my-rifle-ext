// AIDEV-NOTE: Boundary for aven ref resolution (PMR-5900) — all shell-outs
// live here, decisions come from the pure ./aven-resolve.ts module.
// Resolution: plain `show` (cwd-inferred workspace) → `search` in the active
// workspace → iterate `workspace list`. An explicit override skips straight
// to `show --workspace <override>`.
import {
  isUnknownRef,
  overrideFailureReason,
  parseWorkspaceList,
  searchHasExactRef,
  unknownRefFailureReason,
  workspaceSearchOrder,
} from './aven-resolve.ts'

export type AvenRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export type RefResolution =
  | { ok: true; workspace?: string }
  | { ok: false; reason: string }

function stderrOf(error: unknown): string | undefined {
  const stderr = (error as { stderr?: unknown })?.stderr
  if (typeof stderr === 'string') return stderr
  const msg = error instanceof Error ? error.message : String(error)
  return msg
}

export async function resolveAvenRef(
  ref: string,
  exec: AvenRunner,
  workspaceOverride?: string,
): Promise<RefResolution> {
  if (workspaceOverride !== undefined) {
    try {
      await exec(['show', ref, '--json', '--workspace', workspaceOverride])
      return { ok: true, workspace: workspaceOverride }
    } catch (error: unknown) {
      return {
        ok: false,
        reason: overrideFailureReason(
          ref,
          workspaceOverride,
          stderrOf(error) ?? 'unknown error',
        ),
      }
    }
  }
  try {
    await exec(['show', ref, '--json'])
    return { ok: true }
  } catch (error: unknown) {
    if (!isUnknownRef(stderrOf(error))) {
      return {
        ok: false,
        reason: `aven show ${ref} failed: ${stderrOf(error) ?? 'unknown error'}`,
      }
    }
  }
  const tried: string[] = []
  try {
    const searched = await exec(['search', ref, '--json'])
    if (searchHasExactRef(searched.stdout, ref)) {
      return { ok: true }
    }
  } catch {
    // active-workspace search unavailable — fall through to the sweep
  }
  let available: string[] = []
  try {
    available = parseWorkspaceList((await exec(['workspace', 'list'])).stdout)
  } catch {
    available = []
  }
  for (const workspace of workspaceSearchOrder(available, tried)) {
    tried.push(workspace)
    try {
      const searched = await exec([
        'search',
        ref,
        '--json',
        '--workspace',
        workspace,
      ])
      if (!searchHasExactRef(searched.stdout, ref)) continue
      await exec(['show', ref, '--json', '--workspace', workspace])
      return { ok: true, workspace }
    } catch {
      // workspace unreachable or show failed — keep sweeping
    }
  }
  return { ok: false, reason: unknownRefFailureReason(ref) }
}
