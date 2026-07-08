import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSemReviewGuidance,
  getSemToolAvailability,
} from './sem-guidance.mjs'

test('getSemToolAvailability detects active sem review tools', () => {
  const availability = getSemToolAvailability([
    'read',
    'sem_context',
    'sem_impact',
  ])
  assert.equal(availability.context, true)
  assert.equal(availability.impact, true)
  assert.equal(availability.diff, false)
  assert.equal(availability.any, true)
})

test('buildSemReviewGuidance for commit review includes selective sem workflow', () => {
  const guidance = buildSemReviewGuidance(
    { type: 'commit', sha: 'abc1234' },
    getSemToolAvailability([
      'sem_diff',
      'sem_context',
      'sem_impact',
      'sem_entities',
    ]),
  )

  assert.ok(guidance)
  assert.match(guidance, /Semantic tooling for this diff review/)
  assert.match(guidance, /sem_diff.*abc1234/)
  assert.match(guidance, /sem_impact/)
  assert.match(guidance, /sem_context/)
  assert.match(
    guidance,
    /confirm final findings with raw `git diff`, `read`, or direct file inspection/,
  )
})

test('buildSemReviewGuidance for folder review avoids diff-first instructions', () => {
  const guidance = buildSemReviewGuidance(
    { type: 'folder', paths: ['src', 'docs'] },
    getSemToolAvailability(['sem_context', 'sem_entities', 'sem_impact']),
  )

  assert.ok(guidance)
  assert.match(guidance, /snapshot review/)
  assert.doesNotMatch(guidance, /Start with `sem_diff`/)
  assert.match(guidance, /sem_entities/)
  assert.match(guidance, /sem_context/)
})
