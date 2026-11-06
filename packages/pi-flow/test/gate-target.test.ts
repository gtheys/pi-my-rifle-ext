import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGateTarget,
  extractReviewedRange,
  type GateTarget,
  gateTargetId,
  isFullSha,
  reviewedRangeLine,
  sha256Hex,
  validateDecisionCitation,
  verifyGateResult,
} from '../validate/gate-target.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const DIFF = 'diff --git a/x.ts b/x.ts\n+hello'

function target(overrides: Partial<GateTarget> = {}): GateTarget {
  const built = buildGateTarget({
    gate: 'deviation',
    ref: 'PMR-TEST1',
    baseSha: BASE,
    headSha: HEAD,
    diff: DIFF,
  })
  if (!('diffSha256' in built))
    throw new Error('fixture target failed to build')
  return { ...built, ...overrides }
}

// --- buildGateTarget ---

test('buildGateTarget pins gate, ref, SHAs and the diff digest', () => {
  const t = target()
  assert.equal(t.gate, 'deviation')
  assert.equal(t.ref, 'PMR-TEST1')
  assert.equal(t.baseSha, BASE)
  assert.equal(t.headSha, HEAD)
  assert.equal(t.diffSha256, sha256Hex(DIFF))
})

test('buildGateTarget rejects short SHAs, empty ref and empty range', () => {
  const shortBase = buildGateTarget({
    gate: 'deviation',
    ref: 'PMR-TEST1',
    baseSha: 'abc1234',
    headSha: HEAD,
    diff: DIFF,
  })
  assert.ok(!('diffSha256' in shortBase))

  const sameRange = buildGateTarget({
    gate: 'deviation',
    ref: 'PMR-TEST1',
    baseSha: BASE,
    headSha: BASE,
    diff: DIFF,
  })
  assert.ok(!('diffSha256' in sameRange))

  const noRef = buildGateTarget({
    gate: 'deviation',
    ref: '',
    baseSha: BASE,
    headSha: HEAD,
    diff: DIFF,
  })
  assert.ok(!('diffSha256' in noRef))
})

test('isFullSha accepts only 40 lowercase hex chars', () => {
  assert.ok(isFullSha(BASE))
  assert.ok(!isFullSha(BASE.toUpperCase()))
  assert.ok(!isFullSha(BASE.slice(0, 39)))
  assert.ok(!isFullSha(`${BASE.slice(0, 39)}g`))
})

// --- deterministic id ---

test('gateTargetId is deterministic and differs per target part', () => {
  const a = gateTargetId(target())
  const b = gateTargetId(target())
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{12}$/)

  const otherDiff = target({ diffSha256: sha256Hex('other bytes') })
  assert.notEqual(a, gateTargetId(otherDiff))

  const otherHead = target({ headSha: 'c'.repeat(40) })
  assert.notEqual(a, gateTargetId(otherHead))
})

// --- echo extraction ---

test('reviewedRangeLine renders the pinned range', () => {
  assert.equal(reviewedRangeLine(target()), `reviewed_range: ${BASE}..${HEAD}`)
})

test('extractReviewedRange takes the LAST exact-match line', () => {
  const artifact = [
    'Some preamble quoting reviewed_range: dead..beef',
    '## Deviation Verdict',
    `reviewed_range: ${BASE}..${HEAD}`,
    'deviations_count: 0',
  ].join('\n')
  const echo = extractReviewedRange(artifact)
  assert.ok(echo !== null)
  assert.equal(echo.baseSha, BASE)
  assert.equal(echo.headSha, HEAD)
})

test('extractReviewedRange ignores short or malformed SHAs', () => {
  assert.equal(extractReviewedRange('reviewed_range: abc..def'), null)
  assert.equal(
    extractReviewedRange(`reviewed_range: ${BASE.slice(0, 12)}..${HEAD}`),
    null,
  )
  assert.equal(extractReviewedRange('no echo at all'), null)
})

// --- verification order: echo BEFORE findings, staleness SECOND ---

test('verifyGateResult passes on exact echo with unchanged HEAD', () => {
  const v = verifyGateResult({
    target: target(),
    artifact: `reviewed_range: ${BASE}..${HEAD}\ndeviations_count: 0`,
    currentHeadSha: HEAD,
  })
  assert.deepEqual(v, { ok: true, status: 'pass' })
})

test('verifyGateResult fails echo-missing when the artifact has no echo line', () => {
  const v = verifyGateResult({
    target: target(),
    artifact: 'deviations_count: 0',
    currentHeadSha: HEAD,
  })
  assert.ok(!v.ok)
  assert.equal(v.status, 'echo-missing')
})

test('verifyGateResult fails target-mismatch on a wrong echo, even with a moved HEAD too', () => {
  const v = verifyGateResult({
    target: target(),
    artifact: `reviewed_range: ${BASE}..${'c'.repeat(40)}`,
    currentHeadSha: 'd'.repeat(40),
  })
  assert.ok(!v.ok)
  assert.equal(v.status, 'target-mismatch')
})

test('verifyGateResult fails stale when HEAD moved past the pinned head', () => {
  const v = verifyGateResult({
    target: target(),
    artifact: `reviewed_range: ${BASE}..${HEAD}`,
    currentHeadSha: 'e'.repeat(40),
  })
  assert.ok(!v.ok)
  assert.equal(v.status, 'stale')
})

// --- decision citation (orchestrator discipline) ---

test('validateDecisionCitation accepts a decision citing a known target', () => {
  const t = target()
  const v = validateDecisionCitation(
    { gate: 'deviation', targetId: gateTargetId(t), status: 'pass' },
    [t],
  )
  assert.ok(v.ok)
  assert.equal(v.target.ref, 'PMR-TEST1')
})

test('validateDecisionCitation rejects unknown target ids and cross-gate citations', () => {
  const t = target()
  const unknown = validateDecisionCitation(
    { gate: 'deviation', targetId: '000000000000', status: 'pass' },
    [t],
  )
  assert.ok(!unknown.ok)

  const crossGate = validateDecisionCitation(
    { gate: 'review', targetId: gateTargetId(t), status: 'pass' },
    [t],
  )
  assert.ok(!crossGate.ok)
})
