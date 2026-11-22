// AIDEV-NOTE: Canonical slug rule — lowercase, strip non-alnum, max 5 words,
// dashes. Re-homed out of brainstorm/paths.ts (PMR-H7RW); imported by
// brainstorm/paths.ts and plan-tools/helpers.ts (plan/paths.ts was deleted
// with the dead resolvePlanDir duplicate, PMR-6RM5).
export function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
}
