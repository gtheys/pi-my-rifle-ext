// AIDEV-NOTE: Pure work-mode detection — unit-testable without pi/herdr.
// The pi-bound wrapper (resolveMode) shells out to git and lives in index.ts.

export type WorkMode = 'work' | 'personal'

// AIDEV-NOTE: Path-segment aware prefix match — /foo/bar must not match
// /foo/barbaz. Equality counts as "under" the root.
export function modeForToplevel(
  toplevel: string,
  workRoots: readonly string[],
): WorkMode {
  for (const root of workRoots) {
    const normalized = root.endsWith('/') ? root : `${root}/`
    if (toplevel === root || toplevel.startsWith(normalized)) {
      return 'work'
    }
  }
  return 'personal'
}
