import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildReviewPrompt } from '../spec-review/prompt.ts'

const PICKED = [
  { ref: 'PMR-AAAA', title: 'First spec', planPath: '/plans/pmr-aaaa/plan.md' },
  {
    ref: 'PMR-BBBB',
    title: 'Second spec',
    planPath: '/plans/pmr-bbbb/plan.md',
  },
]

test('buildReviewPrompt: lists every picked spec with ref, title and plan path', () => {
  const prompt = buildReviewPrompt(PICKED)
  for (const spec of PICKED) {
    assert.ok(prompt.includes(spec.ref), `missing ref ${spec.ref}`)
    assert.ok(prompt.includes(spec.title), `missing title ${spec.title}`)
    assert.ok(
      prompt.includes(spec.planPath),
      `missing planPath ${spec.planPath}`,
    )
  }
})

test('buildReviewPrompt: instructs review-stage behavior and in-place fixes', () => {
  const prompt = buildReviewPrompt(PICKED)
  assert.match(prompt, /feature-plan-aven/)
  assert.match(prompt, /review-stage|review stage/i)
  assert.match(prompt, /in place/i)
})

test('buildReviewPrompt: approval requires explicit "approve <REF>" aven edit + /spec-publish', () => {
  const prompt = buildReviewPrompt(PICKED)
  assert.match(prompt, /approve PMR-AAAA/)
  assert.match(
    prompt,
    /aven edit .REF. --metadata plan-state=approved --label plan --status todo/,
  )
  assert.match(prompt, /\/spec-publish <REF>/)
  assert.match(prompt, /never approve/i)
})

test('buildReviewPrompt: single spec still complete', () => {
  const prompt = buildReviewPrompt([PICKED[0]])
  assert.match(prompt, /approve PMR-AAAA/)
  assert.ok(!prompt.includes('PMR-BBBB'))
})
