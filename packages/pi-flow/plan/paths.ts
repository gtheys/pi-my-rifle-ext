import { join } from 'node:path'
import { slugify } from '../research/paths.ts'

// AIDEV-NOTE: Mirrors pi-planning's plan-tools/helpers.ts resolveFeaturePath
// env-fallback contract (duplication deliberate — cross-package runtime
// imports are forbidden). If $PERSONAL_FEATURES is set:
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
