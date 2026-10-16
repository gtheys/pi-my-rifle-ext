import { join } from 'node:path'

// AIDEV-NOTE: Mirrors pi-planning's plan-tools/helpers.ts resolveSpecPath
// env-fallback contract (duplication deliberate — cross-package runtime
// imports are forbidden). If $LLM_NOTES_ROOT is set:
// $LLM_NOTES_ROOT/<repo>/notes/research/ ; else <git-toplevel>/notes/research/.
export function resolveResearchDir(
  notesRoot: string | undefined,
  repoName: string,
  gitToplevel: string,
): string {
  if (notesRoot) {
    return join(notesRoot, repoName, 'notes', 'research')
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
