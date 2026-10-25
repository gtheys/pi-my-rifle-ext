import { join } from 'node:path'
import type { WorkMode } from '../work-mode.ts'

// AIDEV-NOTE: Mirrors pi-planning's plan-tools/helpers.ts resolveSpecPath
// env-fallback contract (duplication deliberate — cross-package runtime
// imports are forbidden). Work mode: $LLM_NOTES_ROOT/<repo>/notes/research/
// when set. Personal mode: $PERSONAL_FEATURES/<repo>/notes/research/ when set
// ($PERSONAL_FEATURES is the personal counterpart of $LLM_NOTES_ROOT —
// PMR-MSGE: personal research must never land under the work notes root).
// Both modes fall back to <git-toplevel>/notes/research/.
export function resolveResearchDir(
  mode: WorkMode,
  notesRoot: string | undefined,
  personalFeatures: string | undefined,
  repoName: string,
  gitToplevel: string,
): string {
  let root: string | undefined
  if (mode === 'work') {
    root = notesRoot
  } else {
    root = personalFeatures
  }
  if (root) {
    return join(root, repoName, 'notes', 'research')
  }
  return join(gitToplevel, 'notes', 'research')
}

// Same slug rule as plan-tools/helpers.ts slugify: lowercase, strip non-alnum,
// max 5 words, dashes.
export function slugify(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
}

export function researchArtifactPath(
  dir: string,
  title: string,
  date: string,
): string {
  return join(dir, `${date}-${slugify(title)}.md`)
}
