// AIDEV-NOTE: argument parser for /spec-publish (PMR-MR36 subtask PMR-2D2X).
// Pure module — tested without ctx. Exactly one aven ref is required;
// `--workspace <name>` (any position) is the cross-workspace escape hatch.

export type SpecPublishArgs =
  | { kind: 'help' }
  | { kind: 'ok'; ref: string; workspace?: string }

export function parseSpecPublishArgs(args: string): SpecPublishArgs {
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '')
  let workspace: string | undefined
  const rest: string[] = []
  let i = 0
  while (i < parts.length) {
    const part = parts[i] as string
    if (part === '--workspace') {
      const value = parts[i + 1]
      if (value === undefined || value === '--workspace')
        return { kind: 'help' }
      workspace = value
      i += 2
      continue
    }
    rest.push(part)
    i += 1
  }
  if (rest.length !== 1) return { kind: 'help' }
  if (workspace === undefined) return { kind: 'ok', ref: rest[0] as string }
  return { kind: 'ok', ref: rest[0] as string, workspace }
}
