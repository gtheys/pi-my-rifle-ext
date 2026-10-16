import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideReviewRoute,
  parseReviewArtifact,
} from '../validate/review-gate.ts'

// --- parseReviewArtifact (strict blockers_count contract) ---

test('parseReviewArtifact: parses blockers_count line', () => {
  const result = parseReviewArtifact('notes\nblockers_count: 2\n')
  assert.deepEqual(result, { ok: true, blockersCount: 2, blockers: [] })
})

test('parseReviewArtifact: zero blockers', () => {
  const result = parseReviewArtifact('# Review\nblockers_count: 0\n')
  assert.deepEqual(result, { ok: true, blockersCount: 0, blockers: [] })
})

test('parseReviewArtifact: tolerates surrounding whitespace', () => {
  const result = parseReviewArtifact('  blockers_count:   3  \n')
  assert.deepEqual(result, { ok: true, blockersCount: 3, blockers: [] })
})

test('parseReviewArtifact: missing count is an error, never 0', () => {
  const result = parseReviewArtifact('looks fine to me\nno numbers here')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /blockers_count/)
})

test('parseReviewArtifact: malformed count is an error', () => {
  assert.equal(parseReviewArtifact('blockers_count: many').ok, false)
  assert.equal(parseReviewArtifact('blockers_count: -1').ok, false)
  assert.equal(parseReviewArtifact('blockers_count: 1.5').ok, false)
  assert.equal(parseReviewArtifact('blockers_count: ').ok, false)
})

test('parseReviewArtifact: duplicate counts are an error', () => {
  const result = parseReviewArtifact('blockers_count: 0\nblockers_count: 1\n')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /multiple/)
})

// --- blocker note extraction ---

test('parseReviewArtifact: extracts blocker note lines', () => {
  const artifact = [
    '## Findings',
    '- blocker: auth token not validated',
    '- nit: rename variable',
    '- blocker: missing error handling in queue consumer',
    'blockers_count: 2',
  ].join('\n')
  const result = parseReviewArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    assert.deepEqual(result.blockers, [
      'auth token not validated',
      'missing error handling in queue consumer',
    ])
  }
})

// --- decideReviewRoute (pure gate decision) ---

test('decideReviewRoute: zero blockers, work mode -> PR landing', () => {
  assert.deepEqual(decideReviewRoute('work', 0), {
    route: 'landing',
    landing: 'pr',
  })
})

test('decideReviewRoute: zero blockers, personal mode -> push main', () => {
  assert.deepEqual(decideReviewRoute('personal', 0), {
    route: 'landing',
    landing: 'push-main',
  })
})

test('decideReviewRoute: blockers -> back to implement with note', () => {
  const decision = decideReviewRoute('work', 2, [
    'auth token not validated',
    'missing error handling',
  ])
  assert.equal(decision.route, 'implement')
  if (decision.route === 'implement') {
    assert.match(decision.blockersNote, /auth token not validated/)
    assert.match(decision.blockersNote, /missing error handling/)
  }
})

test('decideReviewRoute: blockers without listed notes still routes to implement', () => {
  const decision = decideReviewRoute('personal', 1, [])
  assert.equal(decision.route, 'implement')
  if (decision.route === 'implement') {
    assert.match(decision.blockersNote, /1 review blocker/)
  }
})
