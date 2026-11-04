// AIDEV-NOTE: Canonical slug rule — lowercase, strip non-alnum, max 5 words,
// dashes. Re-homed out of brainstorm/paths.ts (PMR-H7RW) since plan/paths.ts
// and plan-tools/helpers.ts import it too.
export function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
}
