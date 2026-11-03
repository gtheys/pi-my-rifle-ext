/**
 * Shared helpers for the plan-tools registrations.
 * Moved from packages/pi-planning/plan-tools/helpers.ts (PMR-XCA9 — package
 * absorbed into pi-flow). The slug rule now lives in research/paths.ts.
 */

import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { slugify } from '../research/paths.ts'

export async function getRepoName(pi: ExtensionAPI): Promise<string> {
  // ponytail: git rev-parse --show-toplevel always works in a repo; remote URL is optional
  try {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    if (r.stdout.trim()) return r.stdout.trim().split('/').pop() ?? 'unknown'
  } catch {
    // Not a git repo or git unavailable — fall through to 'unknown' below.
  }
  return 'unknown'
}

export async function resolveSpecPath(
  pi: ExtensionAPI,
  jiraId: string,
  summary: string,
): Promise<string> {
  const repoName = await getRepoName(pi)
  const slug = slugify(summary)

  const notesRoot = process.env.LLM_NOTES_ROOT
  let specDir: string
  if (notesRoot) {
    specDir = join(notesRoot, repoName, 'notes', 'specs')
  } else {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    specDir = join(r.stdout.trim(), 'notes', 'specs')
  }

  return join(specDir, `${jiraId}__${slug}.md`)
}

// AIDEV-NOTE: Feature path contract — if $PERSONAL_FEATURES is set, feature
// plans live in $PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md (personal
// cross-repo features collection). Otherwise fall back to the repo-local
// <git-toplevel>/.pi/plans/<date>-<slug>/plan.md. plan/paths.ts mirrors this
// contract in pure form for the /plan phase.
export async function resolveFeaturePath(
  pi: ExtensionAPI,
  summary: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10)
  const slug = slugify(summary)

  const personalFeatures = process.env.PERSONAL_FEATURES
  let dir: string
  if (personalFeatures) {
    const repoName = await getRepoName(pi)
    dir = join(personalFeatures, repoName, `${date}-${slug}`)
  } else {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    dir = join(r.stdout.trim(), '.pi', 'plans', `${date}-${slug}`)
  }

  return join(dir, 'plan.md')
}
