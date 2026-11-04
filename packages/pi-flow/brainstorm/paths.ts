import { join } from 'node:path'
import { MODE_PROFILE } from '../mode-profile.ts'
import { slugify } from '../slugify.ts'
import type { WorkMode } from '../work-mode.ts'

// AIDEV-NOTE: PMR-XCA9 — mirrors plan-tools/helpers.ts resolveSpecPath's
// env-fallback contract (same package since the pi-planning absorption;
// pure here, exec-based there). Work mode: $LLM_NOTES_ROOT/<repo>/notes/brainstorm/
// when set. Personal mode: $PERSONAL_FEATURES/<repo>/notes/brainstorm/ when set
// ($PERSONAL_FEATURES is the personal counterpart of $LLM_NOTES_ROOT —
// PMR-MSGE: personal brainstorm artifacts must never land under the work
// notes root). Both modes fall back to <git-toplevel>/notes/brainstorm/.
// PMR-H7RW: dir renamed notes/research -> notes/brainstorm; no production
// reader of the old dir remained (findResearchedArtifact's /flow caller
// was removed with PMR-Z2K7), so the rename is a clean break.
export function resolveBrainstormDir(
  mode: WorkMode,
  notesRoot: string | undefined,
  personalFeatures: string | undefined,
  repoName: string,
  gitToplevel: string,
): string {
  // AIDEV-NOTE: which env root applies is data (mode-profile.ts); the
  // params still carry both values so the caller shape is unchanged.
  let root: string | undefined
  if (MODE_PROFILE[mode].artifactRootEnv === 'LLM_NOTES_ROOT') {
    root = notesRoot
  } else {
    root = personalFeatures
  }
  if (root) {
    return join(root, repoName, 'notes', 'brainstorm')
  }
  return join(gitToplevel, 'notes', 'brainstorm')
}

export function brainstormArtifactPath(
  dir: string,
  title: string,
  date: string,
): string {
  return join(dir, `${date}-${slugify(title)}.md`)
}
