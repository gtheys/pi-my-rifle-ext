/**
 * Shared helpers for the plan-tools registrations.
 * Moved from packages/pi-planning/plan-tools/helpers.ts (PMR-XCA9 — package
 * absorbed into pi-flow). The slug rule now lives in slugify.ts (re-homed out of brainstorm/paths.ts, PMR-H7RW).
 */

import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { slugify } from '../slugify.ts'

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

// AIDEV-NOTE: Spec path contract — if $LLM_NOTES_ROOT is set, specs live in
// $LLM_NOTES_ROOT/<repo>/notes/specs/<JIRA>__<slug>.md (work mode, centralised
// notes root). Otherwise fall back to repo-local <git-toplevel>/notes/specs/.
// The repo-local fallback is INTENTIONAL (repo writes allowed when no env var
// is set) — it was previously assumed to fail fast; that was wrong. Pinned by
// the resolveSpecPath tests in test/plan-tools.test.ts (PMR-BHM2). Do not
// convert this branch to a throw without updating those tests.
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

// AIDEV-NOTE: Notes subdir allowlist — resolve_notes_path only ever appends
// one of these fixed segments to the notes root, never an arbitrary path, so
// the tool cannot be used for path injection. '' means the notes root itself.
// Mirror this list in resolve-notes-path.ts's TypeBox union (PMR-TF0R).
export const NOTES_SUBDIRS = [
  '',
  'prs',
  'specs',
  'research',
  'tickets',
] as const
export type NotesSubdir = (typeof NOTES_SUBDIRS)[number]

// AIDEV-NOTE: Notes path contract — if $LLM_NOTES_ROOT is set, notes live in
// $LLM_NOTES_ROOT/<repo>/notes[/<subdir>] (work mode, centralised notes root).
// Otherwise fall back to <git-toplevel>/notes[/<subdir>] (repo-local). This is
// the generic counterpart of resolveSpecPath (which hardcodes 'specs').
export async function resolveNotesPath(
  pi: ExtensionAPI,
  subdir: NotesSubdir,
): Promise<string> {
  const notesRoot = process.env.LLM_NOTES_ROOT
  let dir: string
  if (notesRoot) {
    const repoName = await getRepoName(pi)
    dir = join(notesRoot, repoName, 'notes')
  } else {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    dir = join(r.stdout.trim(), 'notes')
  }

  return join(dir, subdir)
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
