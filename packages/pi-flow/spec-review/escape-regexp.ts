// AIDEV-NOTE: escape user-influenced strings before RegExp interpolation so
// metacharacters stay literal. Standard idiom; kept local to pi-flow (no
// cross-package imports allowed).

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
