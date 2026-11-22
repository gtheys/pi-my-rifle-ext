// AIDEV-NOTE: PMR-XCA9 — moved from packages/pi-planning/test/test.ts;
// only the import paths changed (slugify now canonical in slugify.ts,
// openFileInPane in spec-review/open-in-pane.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveFeaturePath, resolveNotesPath } from '../plan-tools/helpers.ts'
import { slugify } from '../slugify.ts'

const GIT_TOPLEVEL = '/home/dev/Code/acme/widgets'

function fakePi(): ExtensionAPI {
  return {
    exec: async () => ({ stdout: `${GIT_TOPLEVEL}\n`, stderr: '' }),
  } as unknown as ExtensionAPI
}

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
