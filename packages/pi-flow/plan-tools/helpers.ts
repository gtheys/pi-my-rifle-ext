/**
 * Shared helpers for the plan-tools registrations.
 * Moved from packages/pi-planning/plan-tools/helpers.ts (PMR-XCA9 — package
 * absorbed into pi-flow). The slug rule now lives in slugify.ts (re-homed out of brainstorm/paths.ts, PMR-H7RW).
 */

import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { slugify } from '../slugify.ts'

// AIDEV-NOTE: PMR-HHS8 fix round (review P1) — getRepoName MUST prefer the
// origin remote name (basename of the URL, `.git` stripped) over the toplevel
// basename. In a herdr git worktree the toplevel basename is the worktree
// name (e.g. `feat-flow-document-paths-env-standard`), not the repo, which
// scattered notes/PR docs into per-worktree junk dirs. The skill fallbacks
// (notes-locator, pr-description SKILL.md) use `git remote get-url origin`
// first too — that "keep both in sync" claim holds again only because of
// this ordering. Toplevel basename remains the fallback when there is no
// remote or the lookup fails.
export async function getRepoName(pi: ExtensionAPI): Promise<string> {
  try {
    const remote = await pi.exec('git', ['remote', 'get-url', 'origin'], {})
    const url = remote.stdout.trim()
    if (url) {
      let name = url.split('/').pop() ?? ''
      if (name.endsWith('.git')) {
        name = name.slice(0, -'.git'.length)
      }
      if (name) return name
    }
  } catch {
    // No origin remote or git unavailable — fall through to the toplevel name.
  }
  try {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    if (r.stdout.trim()) return r.stdout.trim().split('/').pop() ?? 'unknown'
  } catch {
    // Not a git repo or git unavailable — fall through to 'unknown' below.
  }
  return 'unknown'
}

// AIDEV-NOTE: PMR-J97S — ONE documented non-git behavior across all three
// resolvers below: FAIL FAST. Outside a git repository a resolver must never
// return a relative path (join('', 'notes') → 'notes') despite promising an
// absolute one, and with a notes-root env var set it must never silently land
// files under <root>/unknown/ (getRepoName's last-resort name). Both cases
// throw with the resolver name in the message; pinned by test/plan-tools.
async function gitToplevelOrFail(
  pi: ExtensionAPI,
  who: string,
  envName: string,
): Promise<string> {
  const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const toplevel = r.stdout.trim()
  if (!toplevel) {
    throw new Error(
      `${who}: not in a git repository and $${envName} is unset — cannot resolve an absolute path`,
    )
  }
  return toplevel
}

async function repoNameOrFail(pi: ExtensionAPI, who: string): Promise<string> {
  const repoName = await getRepoName(pi)
  if (repoName === 'unknown') {
    throw new Error(
      `${who}: cannot derive a repo name (no origin remote, not a git repository) — refusing to resolve a path under an 'unknown' repo dir`,
    )
  }
  return repoName
}

// AIDEV-NOTE: Spec path contract — if $LLM_NOTES_ROOT is set, specs live in
// $LLM_NOTES_ROOT/<repo>/notes/specs/<JIRA>__<slug>.md (work mode, centralised
// notes root). Otherwise fall back to repo-local <git-toplevel>/notes/specs/.
// The repo-local fallback is INTENTIONAL (repo writes allowed when no env var
// is set) — it was previously assumed to fail fast; that was wrong. Pinned by
// the resolveSpecPath tests in test/plan-tools.test.ts (PMR-BHM2). Do not
// convert this branch to a throw without updating those tests. PMR-J97S:
// OUTSIDE a git repo the fallback still fails fast (see gitToplevelOrFail) —
// the intentional case is a repo-local path inside a git repo.
export async function resolveSpecPath(
  pi: ExtensionAPI,
  jiraId: string,
  summary: string,
): Promise<string> {
  const slug = slugify(summary)

  const notesRoot = process.env.LLM_NOTES_ROOT
  let specDir: string
  if (notesRoot) {
    const repoName = await repoNameOrFail(pi, 'resolveSpecPath')
    specDir = join(notesRoot, repoName, 'notes', 'specs')
  } else {
    const toplevel = await gitToplevelOrFail(
      pi,
      'resolveSpecPath',
      'LLM_NOTES_ROOT',
    )
    specDir = join(toplevel, 'notes', 'specs')
  }

  return join(specDir, `${jiraId}__${slug}.md`)
}

// AIDEV-NOTE: Notes subdir allowlist — resolve_notes_path only ever appends
// one of these fixed segments to the notes root, never an arbitrary path, so
// the tool cannot be used for path injection. '' means the notes root itself.
// resolve-notes-path.ts builds its TypeBox union from this array — adding a
// subdir here is a single edit (PMR-TF0R, PMR-HHS8 fix round).
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
    const repoName = await repoNameOrFail(pi, 'resolveNotesPath')
    dir = join(notesRoot, repoName, 'notes')
  } else {
    // AIDEV-NOTE: PMR-HHS8 fix round (review P3), unified by PMR-J97S —
    // fail fast outside a git repo: join('', 'notes') would return the
    // relative path 'notes' while the tool promises an absolute one. All
    // three resolvers share this behavior via gitToplevelOrFail.
    const toplevel = await gitToplevelOrFail(
      pi,
      'resolveNotesPath',
      'LLM_NOTES_ROOT',
    )
    dir = join(toplevel, 'notes')
  }

  return join(dir, subdir)
}

// AIDEV-NOTE: Feature path contract — if $PERSONAL_FEATURES is set, feature
// plans live in $PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md (personal
// cross-repo features collection). Otherwise fall back to the repo-local
// <git-toplevel>/.pi/plans/<date>-<slug>/plan.md. resolveFeaturePath is the
// single contract for feature plan paths.
export async function resolveFeaturePath(
  pi: ExtensionAPI,
  summary: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10)
  const slug = slugify(summary)

  const personalFeatures = process.env.PERSONAL_FEATURES
  let dir: string
  if (personalFeatures) {
    const repoName = await repoNameOrFail(pi, 'resolveFeaturePath')
    dir = join(personalFeatures, repoName, `${date}-${slug}`)
  } else {
    const toplevel = await gitToplevelOrFail(
      pi,
      'resolveFeaturePath',
      'PERSONAL_FEATURES',
    )
    dir = join(toplevel, '.pi', 'plans', `${date}-${slug}`)
  }

  return join(dir, 'plan.md')
}
