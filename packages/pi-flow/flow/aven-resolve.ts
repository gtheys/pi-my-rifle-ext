// AIDEV-NOTE: Pure decision logic for aven ref resolution (PMR-5900).
// No I/O here — the boundary (index.ts / aven exec helpers) shells out and
// feeds observed outcomes into these functions. Fallback order:
//   1. `aven show <ref> --json` (fast path, implicit cwd-inferred workspace)
//   2. `aven search <ref> --json` in the active workspace
//   3. `aven workspace list`, then search each workspace in listed order
// until an exact ref match is found, then re-show with `--workspace <ws>`.
// An explicit `avenWorkspace` config override skips the whole dance.

/** aven's unknown-ref marker — seen on stderr as `error unknown-ref`. */
export function isUnknownRef(stderr: string | undefined): boolean {
  return stderr?.includes('unknown-ref') === true
}

/** True when a search result array contains an entry whose ref matches exactly. */
export function searchHasExactRef(stdout: string, ref: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return false
  }
  if (!Array.isArray(parsed)) return false
  return parsed.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { ref?: unknown }).ref === ref,
  )
}

/**
 * Parse `aven workspace list` output (plain text, one workspace per line:
 * `<name> key="..."`). Returns names in listed order.
 */
export function parseWorkspaceList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name.length > 0)
}

/** Workspaces still to search: listed order, minus already-tried, deduped. */
export function workspaceSearchOrder(
  available: string[],
  tried: string[],
): string[] {
  const triedSet = new Set(tried)
  const seen = new Set<string>()
  const order: string[] = []
  for (const name of available) {
    if (triedSet.has(name) || seen.has(name)) continue
    seen.add(name)
    order.push(name)
  }
  return order
}

/** Actionable failure message — never a bare unknown-ref (PMR-5900). */
export function unknownRefFailureReason(ref: string): string {
  return (
    `aven ref ${ref} not found in any workspace. ` +
    `Fix one of: (1) one-time mapping \`aven project path add pi-my-rifle-ext <this-checkout-path>\`, ` +
    `(2) set "avenWorkspace" in pi-flow config.json to the workspace holding ${ref}`
  )
}

/** Actionable failure message for an explicit override that did not resolve. */
export function overrideFailureReason(
  ref: string,
  workspace: string,
  cause: string,
): string {
  return (
    `aven ref ${ref} could not be read in configured avenWorkspace "${workspace}": ${cause}. ` +
    `Check the avenWorkspace value in pi-flow config.json and that ${ref} exists there`
  )
}
