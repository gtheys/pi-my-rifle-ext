import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEVIATION_CONTRACT_PROMPT,
  DEVIATION_VERDICT_HEADING,
  decideDeviationRoute,
  parseDeviationArtifact,
} from '../validate/deviation-gate.ts'

// --- parseDeviationArtifact (strict deviations_count contract) ---

test('parseDeviationArtifact: parses deviations_count line', () => {
  const result = parseDeviationArtifact('notes\ndeviations_count: 2\n')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.deviationsCount, 2)
})

test('parseDeviationArtifact: zero deviations', () => {
  const result = parseDeviationArtifact(
    '# Deviation Review\ndeviations_count: 0\n',
  )
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.deviationsCount, 0)
})

test('parseDeviationArtifact: missing count is an error, never 0', () => {
  const result = parseDeviationArtifact('no deviations spotted, ship it')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /deviations_count/)
})

test('parseDeviationArtifact: duplicate counts are an error', () => {
  const result = parseDeviationArtifact(
    'deviations_count: 0\ndeviations_count: 1\n',
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /multiple/)
})

test('parseDeviationArtifact: negative count is an error', () => {
  const result = parseDeviationArtifact('deviations_count: -1')
  assert.equal(result.ok, false)
})

test('parseDeviationArtifact: non-integer count is an error', () => {
  assert.equal(parseDeviationArtifact('deviations_count: 1.5').ok, false)
  assert.equal(parseDeviationArtifact('deviations_count: many').ok, false)
})

// --- deviation line extraction ---

test('parseDeviationArtifact: extracts deviation lines with why and evidence', () => {
  const artifact = [
    '## Deviation Verdict',
    '- deviation: added retry loop absent from spec | why: API is flaky (inferred: commit msg "retry on 429") | src/client.ts:42',
    '- deviation: switched ORM | why: spec said Drizzle (inferred: plan.md section 3) | src/db.ts:10',
    'deviations_count: 2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.deviationsCount, 2)
    assert.equal(result.deviations.length, 2)
    const [first, second] = result.deviations
    assert.match(first?.what ?? '', /retry loop/)
    assert.match(first?.why ?? '', /flaky/)
    assert.match(first?.evidence ?? '', /429/)
    assert.equal(first?.file, 'src/client.ts')
    assert.equal(first?.line, 42)
    assert.match(second?.what ?? '', /ORM/)
    assert.match(second?.evidence ?? '', /plan\.md/)
  }
})

test('parseDeviationArtifact: deviation with inferred label preserved', () => {
  const artifact = [
    '## Deviation Verdict',
    '- deviation: cached tokens | why: perf (inferred: profile data) | src/auth.ts:7',
    'deviations_count: 1',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) assert.match(result.deviations[0]?.why ?? '', /perf/)
})

// --- verdict-section scoping (quoted contract must not false-positive) ---

test('parseDeviationArtifact: quoted fenced contract does not override real heading', () => {
  const artifact = [
    'The gate requires this exact shape:',
    '```',
    `   ${DEVIATION_VERDICT_HEADING}`,
    `   ${DEVIATION_CONTRACT_PROMPT}`,
    '```',
    DEVIATION_VERDICT_HEADING,
    '- deviation: real finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    'deviations_count: 1',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.deviationsCount, 1)
    assert.equal(result.deviations.length, 1)
  }
})

test('parseDeviationArtifact: quoted heading prose cannot false-positive count', () => {
  const artifact = [
    'Remember to write:',
    '```',
    'deviations_count: 0',
    '```',
    DEVIATION_VERDICT_HEADING,
    'deviations_count: 2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) assert.equal(result.deviationsCount, 2)
})

// --- decideDeviationRoute (pure gate decision) ---

test('decideDeviationRoute: zero deviations proceeds to validate complete', () => {
  const decision = decideDeviationRoute(0, [])
  assert.deepEqual(decision, { route: 'validate-complete' })
})

test('decideDeviationRoute: deviations route to human decision with note', () => {
  const decision = decideDeviationRoute(2, ['added retry loop', 'switched ORM'])
  assert.equal(decision.route, 'human-decision')
  if (decision.route === 'human-decision') {
    assert.match(decision.deviationsNote, /2 deviation/)
    assert.match(decision.deviationsNote, /retry loop/)
  }
})
