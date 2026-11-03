import { join } from 'node:path'
import { slugify } from '../research/paths.ts'

// AIDEV-NOTE: PMR-XCA9 — mirrors plan-tools/helpers.ts resolveFeaturePath's
// env-fallback contract (same package since the pi-planning absorption;
// pure here, exec-based there). If $PERSONAL_FEATURES is set:
// $PERSONAL_FEATURES/<repo>/<date>-<slug>/ ; else
// <git-toplevel>/.pi/plans/<date>-<slug>/. plan.md sits inside the dir.

export function resolvePlanDir(
  personalFeatures: string | undefined,
  repoName: string,
  gitToplevel: string,
  date: string,
  summary: string,
): string {
  const slug = slugify(summary)
  if (personalFeatures) {
    return join(personalFeatures, repoName, `${date}-${slug}`)
  }
  return join(gitToplevel, '.pi', 'plans', `${date}-${slug}`)
}
