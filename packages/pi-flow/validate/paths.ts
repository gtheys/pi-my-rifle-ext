import { join } from 'node:path'

// AIDEV-NOTE: The devctl repository name is fixed (machine-specific layout is
// handled by workRoots in pi-flow config, which must contain the parent dir of
// this repo, e.g. /home/geert/Code/salaryhero). If SalaryHero ever renames the
// repo, change it here.
export const DEVCTL_REPO_NAME = 'sh-devctl'

// AIDEV-NOTE: Pure path resolution — <workRoot>/<sh-devctl>/scripts for the
// first configured workRoot. Returns null when no workRoots are configured;
// the caller (command handler / prompt) surfaces that as a config error.
// The resolution rule is documented in config.schema.json's workRoots
// description — keep the two in sync.
export function resolveDevctlScriptsDir(
  workRoots: readonly string[],
): string | null {
  const first = workRoots[0]
  if (first === undefined) return null
  return join(first, DEVCTL_REPO_NAME, 'scripts')
}
