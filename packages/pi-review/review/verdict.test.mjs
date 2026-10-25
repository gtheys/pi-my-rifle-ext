import assert from 'node:assert/strict'
import test from 'node:test'

import { REVIEW_VERDICT_INSTRUCTIONS } from './verdict.ts'

test('verdict instructions contain the exact contract lines', () => {
  // Byte-for-byte match with pi-flow's REVIEW_CONTRACT_PROMPT wording
  // (validate/review-gate.ts is the canonical source).
  assert.match(REVIEW_VERDICT_INSTRUCTIONS, /^\s*blockers_count: <N>$/m)
  assert.match(
    REVIEW_VERDICT_INSTRUCTIONS,
    /^\s*- blocker: <description> \(omit this line entirely when N is 0\)$/m,
  )
})

test('verdict instructions mark the section with a Verdict heading', () => {
  assert.match(REVIEW_VERDICT_INSTRUCTIONS, /^\s*## Verdict$/m)
})
