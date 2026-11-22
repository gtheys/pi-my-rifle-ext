// AIDEV-NOTE: PMR-XCA9 — moved from packages/pi-planning/test/test.ts;
// only the import paths changed (slugify now canonical in slugify.ts,
// openFileInPane in spec-review/open-in-pane.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getRepoName,
  resolveFeaturePath,
  resolveNotesPath,
  resolveSpecPath,
} from '../plan-tools/helpers.ts'
import { slugify } from '../slugify.ts'

const GIT_TOPLEVEL = '/home/dev/Code/acme/widgets'

// AIDEV-NOTE: PMR-HHS8 fix round — the fake exec is command-aware so tests can
// pin the remote-name-preferred getRepoName() and the no-toplevel fail-fast
// guard. remoteUrl '' means "no origin remote configured".
function fakePi(
  opts: { remoteUrl?: string; toplevel?: string } = {},
): ExtensionAPI {
  const remoteUrl = opts.remoteUrl ?? ''
  const toplevel = opts.toplevel ?? GIT_TOPLEVEL
  return {
    exec: async (_cmd: string, args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: remoteUrl ? `${remoteUrl}\n` : '', stderr: '' }
      }
      return { stdout: toplevel, stderr: '' }
    },
  } as unknown as ExtensionAPI
}

test('getRepoName: prefers origin remote name over toplevel basename (worktree-safe)', async () => {
  const name = await getRepoName(
    fakePi({
      remoteUrl: 'https://github.com/acme/widgets.git',
      toplevel: '/home/dev/.herdr/worktrees/widgets/feat-some-branch',
    }),
  )
  assert.equal(name, 'widgets')
})

test('getRepoName: handles scp-style ssh remote URLs', async () => {
  const name = await getRepoName(
    fakePi({ remoteUrl: 'git@github.com:acme/widgets.git' }),
  )
  assert.equal(name, 'widgets')
})

test('getRepoName: falls back to toplevel basename when no remote', async () => {
  const name = await getRepoName(fakePi())
  assert.equal(name, 'widgets')
})

test('slugify: lowercase, strip punctuation, max 5 words', () => {
  assert.equal(
    slugify('Merge /plan command with feature-planning flow!'),
    'merge-plan-command-with-feature-planning',
  )
})

test('resolveFeaturePath: $PERSONAL_FEATURES set → repo/date/slug dir under it', async () => {
  const prev = process.env.PERSONAL_FEATURES
  process.env.PERSONAL_FEATURES = '/home/dev/features'
  try {
    const path = await resolveFeaturePath(fakePi(), 'Merge command flow')
    const date = new Date().toISOString().slice(0, 10)
    assert.equal(
      path,
      `/home/dev/features/widgets/${date}-merge-command-flow/plan.md`,
    )
  } finally {
    if (prev === undefined) delete process.env.PERSONAL_FEATURES
    else process.env.PERSONAL_FEATURES = prev
  }
})

test('resolveFeaturePath: $PERSONAL_FEATURES unset → .pi/plans under git toplevel', async () => {
  delete process.env.PERSONAL_FEATURES
  const path = await resolveFeaturePath(fakePi(), 'Add dark mode')
  const date = new Date().toISOString().slice(0, 10)
  assert.equal(path, `${GIT_TOPLEVEL}/.pi/plans/${date}-add-dark-mode/plan.md`)
})

test('resolveNotesPath: $LLM_NOTES_ROOT set → <root>/<repo>/notes', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    const path = await resolveNotesPath(fakePi(), '')
    assert.equal(path, '/home/dev/notes/widgets/notes')
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveNotesPath: $LLM_NOTES_ROOT set with subdir → <root>/<repo>/notes/<subdir>', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    const path = await resolveNotesPath(fakePi(), 'prs')
    assert.equal(path, '/home/dev/notes/widgets/notes/prs')
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveNotesPath: repo-local fallback uses the remote repo name in a worktree', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    const path = await resolveNotesPath(
      fakePi({
        remoteUrl: 'https://github.com/acme/widgets.git',
        toplevel: '/home/dev/.herdr/worktrees/widgets/feat-some-branch',
      }),
      'prs',
    )
    assert.equal(path, '/home/dev/notes/widgets/notes/prs')
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveNotesPath: $LLM_NOTES_ROOT unset → <git-toplevel>/notes', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  delete process.env.LLM_NOTES_ROOT
  try {
    const path = await resolveNotesPath(fakePi(), 'specs')
    assert.equal(path, `${GIT_TOPLEVEL}/notes/specs`)
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveNotesPath: $LLM_NOTES_ROOT unset and not a git repo → throws (no relative path)', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  delete process.env.LLM_NOTES_ROOT
  try {
    await assert.rejects(
      () => resolveNotesPath(fakePi({ toplevel: '' }), 'specs'),
      /not in a git repository/,
    )
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

// AIDEV-NOTE: PMR-J97S — all three resolvers share ONE non-git behavior:
// fail fast. Without these, resolveSpecPath/resolveFeaturePath returned
// relative paths ('notes/specs/…') despite promising absolute ones, and
// with an env root set a non-git cwd silently landed under <root>/unknown/.
test('resolveNotesPath: $LLM_NOTES_ROOT set but no git repo → throws (no unknown-repo dir)', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    await assert.rejects(
      () => resolveNotesPath(fakePi({ toplevel: '' }), 'specs'),
      /unknown/,
    )
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveSpecPath: $LLM_NOTES_ROOT unset and not a git repo → throws (no relative path)', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  delete process.env.LLM_NOTES_ROOT
  try {
    await assert.rejects(
      () => resolveSpecPath(fakePi({ toplevel: '' }), 'PMR-1', 'Add dark mode'),
      /not in a git repository/,
    )
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveSpecPath: $LLM_NOTES_ROOT set but no git repo → throws (no unknown-repo dir)', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    await assert.rejects(
      () => resolveSpecPath(fakePi({ toplevel: '' }), 'PMR-1', 'Add dark mode'),
      /unknown/,
    )
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveFeaturePath: $PERSONAL_FEATURES unset and not a git repo → throws (no relative path)', async () => {
  const prev = process.env.PERSONAL_FEATURES
  delete process.env.PERSONAL_FEATURES
  try {
    await assert.rejects(
      () => resolveFeaturePath(fakePi({ toplevel: '' }), 'Add dark mode'),
      /not in a git repository/,
    )
  } finally {
    if (prev === undefined) delete process.env.PERSONAL_FEATURES
    else process.env.PERSONAL_FEATURES = prev
  }
})

test('resolveFeaturePath: $PERSONAL_FEATURES set but no git repo → throws (no unknown-repo dir)', async () => {
  const prev = process.env.PERSONAL_FEATURES
  process.env.PERSONAL_FEATURES = '/home/dev/features'
  try {
    await assert.rejects(
      () => resolveFeaturePath(fakePi({ toplevel: '' }), 'Add dark mode'),
      /unknown/,
    )
  } finally {
    if (prev === undefined) delete process.env.PERSONAL_FEATURES
    else process.env.PERSONAL_FEATURES = prev
  }
})

// AIDEV-NOTE: PMR-BHM2 — behavior-pinning tests for resolveSpecPath. The
// repo-local fallback (no $LLM_NOTES_ROOT → <git-toplevel>/notes/specs/) is
// INTENTIONAL: repo writes are allowed when no centralised notes root is
// configured. These tests exist so a "fail-fast when env unset" refactor
// cannot be reintroduced accidentally. See helpers.ts resolveSpecPath.
test('resolveSpecPath: $LLM_NOTES_ROOT set → <root>/<repo>/notes/specs/<JIRA>__<slug>.md', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/dev/notes'
  try {
    const path = await resolveSpecPath(fakePi(), 'PMR-1', 'Add dark mode')
    assert.equal(
      path,
      '/home/dev/notes/widgets/notes/specs/PMR-1__add-dark-mode.md',
    )
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('resolveSpecPath: $LLM_NOTES_ROOT unset → repo-local <git-toplevel>/notes/specs (no throw)', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  delete process.env.LLM_NOTES_ROOT
  try {
    // Must not throw — the repo-local fallback is intentional (PMR-BHM2).
    const path = await resolveSpecPath(fakePi(), 'PMR-1', 'Add dark mode')
    assert.equal(path, `${GIT_TOPLEVEL}/notes/specs/PMR-1__add-dark-mode.md`)
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})
