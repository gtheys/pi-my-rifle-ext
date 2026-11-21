import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEVIATION_CONTRACT_PROMPT,
  DEVIATION_VERDICT_HEADING,
  decideDeviationRoute,
  parseDeviationArtifact,
} from '../validate/deviation-gate.ts'

// --- parseDeviationArtifact (strict deviations_count contract) ---

// PMR-N98C repro: a count whose payload lines are missing is the production
// truncated-artifact defect — it must be an ERROR, never an ok result with an
// empty payload.
test('parseDeviationArtifact: count with no payload lines is a truncated-artifact error', () => {
  const result = parseDeviationArtifact('notes\ndeviations_count: 2\n')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /truncated or malformed/)
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
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '- deviation: second finding | why: scope drift (inferred: diff) | src/y.ts:2',
    'deviations_count: 2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    // The fenced 0 must NOT win; the real count is 2 and the payload backs it.
    assert.equal(result.deviationsCount, 2)
    assert.equal(result.deviations.length, 2)
  }
})

// --- PMR-6YC7: scoping misses must not parse N well-formed lines to 0 ---

test('parseDeviationArtifact: recovers lines excluded by last-heading scoping', () => {
  // The reviewer recaps the verdict under a repeated trailing heading whose
  // section carries only the count; the well-formed lines sit under the
  // FIRST heading. Last-heading-wins scoping parses 0 lines — recover them.
  const artifact = [
    DEVIATION_VERDICT_HEADING,
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '- deviation: second finding | why: scope drift (inferred: diff) | src/y.ts:2',
    '',
    '## Self-check',
    'Counted 2 "- deviation:" lines, matching N=2.',
    '',
    DEVIATION_VERDICT_HEADING,
    'deviations_count: 2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.deviationsCount, 2)
    assert.equal(result.deviations.length, 2)
    assert.equal(result.recovered, true)
  }
})

test('parseDeviationArtifact: recovers lines cut off by a subheading inside the verdict section', () => {
  const artifact = [
    DEVIATION_VERDICT_HEADING,
    'deviations_count: 2',
    '',
    '### Deviations',
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '- deviation: second finding | why: scope drift (inferred: diff) | src/y.ts:2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) {
    assert.equal(result.deviationsCount, 2)
    assert.equal(result.deviations.length, 2)
    assert.equal(result.recovered, true)
  }
})

test('parseDeviationArtifact: clean in-section parse is not flagged as recovered', () => {
  const artifact = [
    DEVIATION_VERDICT_HEADING,
    '- deviation: real finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    'deviations_count: 1',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.ok(result.ok)
  if (result.ok) assert.equal(result.recovered, undefined)
})

test('parseDeviationArtifact: duplicate restated lines still error, with scoping diagnostic', () => {
  // Lines appear BOTH in prose restatement and in the section: artifact-wide
  // count (4) !== declared (2), so no recovery — but the error must say how
  // many well-formed lines exist artifact-wide vs in the section.
  const artifact = [
    'As contract lines, my findings are:',
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '- deviation: second finding | why: scope drift (inferred: diff) | src/y.ts:2',
    '',
    DEVIATION_VERDICT_HEADING,
    'deviations_count: 2',
    '',
    '### Deviations',
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '- deviation: second finding | why: scope drift (inferred: diff) | src/y.ts:2',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /truncated or malformed/)
    assert.match(result.reason, /declares 2 but 0/)
    assert.match(result.reason, /4 well-formed/)
  }
})

test('parseDeviationArtifact: mismatch diagnostic distinguishes transport loss (0 artifact-wide)', () => {
  const result = parseDeviationArtifact(
    `${DEVIATION_VERDICT_HEADING}\ndeviations_count: 3\n`,
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /declares 3 but 0/)
    assert.match(result.reason, /0 well-formed/)
  }
})

test('parseDeviationArtifact: declared 0 with well-formed lines present is an error, never a silent 0', () => {
  const artifact = [
    'Findings restated outside the section:',
    '- deviation: first finding | why: spec mismatch (inferred: diff) | src/x.ts:1',
    '',
    DEVIATION_VERDICT_HEADING,
    'deviations_count: 0',
  ].join('\n')
  const result = parseDeviationArtifact(artifact)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /declares 0 but 1 well-formed/)
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
