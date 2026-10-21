// AIDEV-NOTE: argument parser for /spec-publish (PMR-MR36 subtask PMR-2D2X).
// Pure module — tested without ctx. Exactly one aven ref is required.

export type SpecPublishArgs = { kind: 'help' } | { kind: 'ok'; ref: string }

export function parseSpecPublishArgs(args: string): SpecPublishArgs {
  const parts = args
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '')
  if (parts.length !== 1) return { kind: 'help' }
  return { kind: 'ok', ref: parts[0] as string }
}
