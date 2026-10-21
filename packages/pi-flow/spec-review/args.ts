// AIDEV-NOTE: argument parser for /spec-review (PMR-MR36). Pure module —
// tested without ctx. Bare invocation is the main path (picker over all
// specs in plan-state=review); `help` prints usage; `--workspace <name>` is
// the escape hatch for specs living in another aven workspace.

export type SpecReviewArgs =
  | { kind: 'help' }
  | { kind: 'ok'; workspace?: string }

export function parseSpecReviewArgs(args: string): SpecReviewArgs {
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '')
  if (parts.length === 0) return { kind: 'ok' }
  if (parts[0] === 'help') return { kind: 'help' }
  if (parts[0] === '--workspace' && parts.length === 2) {
    return { kind: 'ok', workspace: parts[1] }
  }
  return { kind: 'help' }
}
