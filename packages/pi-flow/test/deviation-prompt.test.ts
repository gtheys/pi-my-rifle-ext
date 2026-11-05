import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDeviationReviewPrompt,
  DEVIATION_MIN_SPEC_LENGTH,
} from '../review/deviation.ts'
import { buildDeviationGateSection } from '../validate/prompt.ts'

const FULL_SPEC =
  'Add a save button to the settings panel. The button must persist the form to /api/settings and disable while the request is in flight.'

const DIFF = 'diff --git a/src/settings.ts b/src/settings.ts\n+save()'

test('buildDeviationReviewPrompt: includes spec, diff and why-inputs when spec is present', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'work',
    spec: FULL_SPEC,
    diff: DIFF,
    commitMessages: 'feat: add save button',
    avenNotes: 'interview: user wants autosave',
  })
  assert.ok(prompt.includes(FULL_SPEC))
  assert.ok(prompt.includes(DIFF))
  assert.ok(prompt.includes('feat: add save button'))
  assert.ok(prompt.includes('interview: user wants autosave'))
  assert.ok(prompt.includes('Mode: work'))
  assert.ok(!prompt.includes('insufficient spec to compare'))
})

test('buildDeviationReviewPrompt: personal mode is labelled', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'personal',
    spec: FULL_SPEC,
    diff: DIFF,
    commitMessages: '',
    avenNotes: '',
  })
  assert.ok(prompt.includes('Mode: personal'))
})

test('buildDeviationReviewPrompt: empty spec degrades to insufficient-spec', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'work',
    spec: '   ',
    diff: DIFF,
    commitMessages: '',
    avenNotes: '',
  })
  assert.ok(prompt.includes('insufficient spec to compare'))
  assert.ok(!prompt.includes(FULL_SPEC))
})

test('buildDeviationReviewPrompt: thin spec (below minimum) degrades to insufficient-spec', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'personal',
    spec: 'Add a button.',
    diff: DIFF,
    commitMessages: '',
    avenNotes: '',
  })
  assert.ok(prompt.includes('insufficient spec to compare'))
  assert.ok(DEVIATION_MIN_SPEC_LENGTH > 'Add a button.'.length)
})

test('buildDeviationReviewPrompt: prompt contains exactly one deviations_count line', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'work',
    spec: FULL_SPEC,
    diff: DIFF,
    commitMessages: '',
    avenNotes: '',
  })
  const countLines = prompt.match(/^\s*deviations_count:.*$/gm) ?? []
  assert.equal(countLines.length, 1)
})

test('buildDeviationReviewPrompt: insufficient-spec prompt still carries the verdict contract', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'work',
    spec: '',
    diff: DIFF,
    commitMessages: '',
    avenNotes: '',
  })
  assert.ok(prompt.includes('## Deviation Verdict'))
  assert.ok(prompt.includes('deviations_count:'))
  assert.ok(prompt.includes('- deviation:'))
})

// --- PMR-C6AK: personal deviation gate routes to the code_review gate ---

test('personal deviation gate: 0-deviation and accept targets are the code_review gate', () => {
  const section = buildDeviationGateSection('personal', 'PMR-C6AK', false)
  assert.match(section, /continue to the human code-review gate/)
  assert.match(section, /On "accept": proceed to the human code-review gate/)
  assert.match(section, /BEFORE the code_review call/)
  assert.ok(!section.includes('then flow_land (review-gate step 9).'))
})

test('personal oneshot deviation gate keeps the same code_review targets', () => {
  const section = buildDeviationGateSection('personal', 'PMR-C6AK', true)
  assert.match(section, /continue to the human code-review gate/)
})

test('work deviation gate: targets unchanged (flow_phase_complete then flow_land)', () => {
  const section = buildDeviationGateSection('work', 'DP-71', false)
  assert.match(section, /continue to flow_phase_complete with/)
  assert.match(section, /then flow_land \(review-gate step 9\)\./)
  assert.match(
    section,
    /BEFORE the flow_phase_complete\(phase="validate"\) \/ flow_land calls/,
  )
})
