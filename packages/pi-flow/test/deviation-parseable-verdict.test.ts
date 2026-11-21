import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDeviationReviewPrompt } from '../review/deviation.ts'
import { deviationResultToToolResult } from '../tools/deviation.ts'
import {
  DEVIATION_VERDICT_HEADING,
  parseDeviationArtifact,
} from '../validate/deviation-gate.ts'

// AIDEV-NOTE: PMR-MH1Y golden reproduction — PMR-C0YV validate phase
// (2026-11-21, personal oneshot) burned THREE consecutive deviation_review
// runs on strict-parse failures over the same inputs (range a1e483a..7034e29
// resolved correctly every time):
//   run 1: deviations_count declares 5 but 0 "- deviation: ..." line(s) parsed
//   run 2: deviations_count declares 8 but 0 parsed
//   run 3: deviations_count declares 4 but 1 parsed
// The reviewer enumerated its findings as narrative prose (quoting spec/notes
// text with backticks, regexes and angle-bracket placeholders) and never
// restated them as contract lines; the error gave the caller nothing to
// diagnose with, so every blind re-run failed the same way. These tests pin
// the fix: (a) the reviewer prompt carries an explicit section-shape contract
// plus a self-check, (b) a parse failure surfaces the raw reviewer artifact
// so the caller can diagnose instead of re-running blind, (c) the parser
// stays strict — a malformed artifact is still never treated as 0.

const SPEC =
  'Fix the resume flow: `/flow <ref>` must resume halted runs, the picker must match /halts and resumes/, and the `<ticket ref>` placeholder must survive.'

const DIFF = 'diff --git a/flow/resume.ts b/flow/resume.ts\n+resume(ref)'

// Run-1 signature: findings as a numbered prose list (special characters
// quoted from the spec/aven notes), verdict section carries ONLY the count.
const PMR_C0YV_RUN1_ARTIFACT = [
  'I compared the spec against the diff for range a1e483a..7034e29.',
  '',
  'The implementation deviates from the spec in 5 places:',
  '',
  '1. The spec says `/flow <ref>` must resume, but resume.md drops the `<ticket ref>` placeholder handling.',
  '2. The regex /halts and resumes/ is not covered by the new picker tests.',
  '3. `validate/prompt.ts` still quotes the old D3 step verbatim.',
  '4. The aven note "interview: user wants <ticket ref> in the picker" was ignored.',
  '5. Angle-bracket placeholders like <base sha> leak into the journal.',
  '',
  DEVIATION_VERDICT_HEADING,
  'reviewed_range: a1e483a..7034e29',
  'deviations_count: 5',
].join('\n')

// Run-3 signature: ONE line survived the strict regex (reviewer mixed one
// contract line into prose), the other 3 findings stayed narrative.
const PMR_C0YV_RUN3_ARTIFACT = [
  'Findings: the diff drops two spec requirements.',
  'First, `/flow <ref>` no longer passes the ref through.',
  'Second, the /halts and resumes/ matcher regressed.',
  'Third, see below.',
  '',
  DEVIATION_VERDICT_HEADING,
  '- deviation: placeholder dropped | why: spec requires <ticket ref> (inferred: spec line 2) | flow/resume.ts:18',
  'deviations_count: 4',
].join('\n')

function textOf(result: {
  content: { type: string; text?: string }[]
}): string {
  const block = result.content[0]
  if (
    block !== undefined &&
    block.type === 'text' &&
    block.text !== undefined
  ) {
    return block.text
  }
  return ''
}

// --- fail-closed parser behavior is preserved (guard: passes pre- AND post-fix) ---

test('golden PMR-C0YV run 1: declared 5 with 0 parseable lines is still a strict error', () => {
  const parsed = parseDeviationArtifact(PMR_C0YV_RUN1_ARTIFACT)
  assert.equal(parsed.ok, false)
  if (!parsed.ok) {
    assert.match(parsed.reason, /declares 5 but 0/)
    assert.match(parsed.reason, /truncated or malformed/)
  }
})

test('golden PMR-C0YV run 3: declared 4 with 1 parseable line is still a strict error', () => {
  const parsed = parseDeviationArtifact(PMR_C0YV_RUN3_ARTIFACT)
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.reason, /declares 4 but 1/)
})

// --- the fix: parse errors surface the raw artifact for diagnosis ---

test('golden PMR-C0YV run 1: parse failure returns the raw reviewer artifact for diagnosis', () => {
  const result = deviationResultToToolResult(PMR_C0YV_RUN1_ARTIFACT)
  assert.equal(result.isError, true)
  assert.equal(result.details.ok, false)
  const text = textOf(result)
  assert.match(text, /NEVER treat this as 0/)
  // The caller must be able to SEE what the reviewer emitted — the prose
  // findings and the mismatched count — instead of re-running blind.
  assert.match(text, /raw reviewer artifact/i)
  assert.ok(text.includes('deviations_count: 5'))
  assert.ok(text.includes('/halts and resumes/'))
  assert.ok(text.includes('<ticket ref>'))
})

test('golden PMR-C0YV run 3: parse failure excerpt includes the surviving contract line', () => {
  const result = deviationResultToToolResult(PMR_C0YV_RUN3_ARTIFACT)
  assert.equal(result.isError, true)
  const text = textOf(result)
  assert.ok(text.includes('- deviation: placeholder dropped'))
  assert.ok(text.includes('deviations_count: 4'))
})

test('long artifact: excerpt keeps a bounded head slice alongside the tail (PMR-H17H)', () => {
  // > RAW_ARTIFACT_EXCERPT_MAX so the excerpt path engages: prose findings
  // at the head, verdict section at the tail, filler in between.
  const artifact = [
    '1. PROSE-FINDING-HEAD-MARKER: spec requires X but diff drops it',
    'filler\n'.repeat(600),
    DEVIATION_VERDICT_HEADING,
    'reviewed_range: a1e483a..7034e29',
    // Count mismatch (declares 1, zero "- deviation:" lines) forces the
    // parse-failure path — the excerpt only ships on isError results.
    'deviations_count: 1',
  ].join('\n')
  const result = deviationResultToToolResult(artifact)
  assert.equal(result.isError, true)
  const text = textOf(result)
  // Tail (verdict) and head (prose findings) both survive; the middle is cut.
  assert.ok(text.includes('deviations_count: 1'))
  assert.ok(text.includes('PROSE-FINDING-HEAD-MARKER'))
  assert.match(text, /\n…\n/)
})

// --- the fix: the reviewer prompt carries an explicit self-check contract ---

test('reviewer prompt requires a verdict section with ONLY contract lines and a self-check', () => {
  const prompt = buildDeviationReviewPrompt({
    mode: 'personal',
    spec: SPEC,
    diff: DIFF,
    commitMessages: 'fix: resume flow',
    avenNotes: 'interview: keep <ticket ref> placeholder',
  })
  // Section-shape contract: no prose inside the verdict section.
  assert.match(prompt, /ONLY/i)
  assert.match(prompt, /[Nn]o prose/)
  // Prose findings must be restated as contract lines.
  assert.match(prompt, /[Rr]estate/)
  // The fields are pipe-separated; literal pipes inside fields break parsing.
  assert.match(prompt, /\|.*inside|inside.*\|/)
  // Mandatory self-check: count the emitted lines against N before responding.
  assert.match(prompt, /SELF-CHECK/i)
  assert.match(prompt, /count the "- deviation:" lines/i)
})

// --- happy-path guard: a contract-conformant artifact parses cleanly ---

test('contract-conformant artifact with special characters in fields parses cleanly', () => {
  const artifact = [
    'Some review prose above the verdict section is fine.',
    '',
    DEVIATION_VERDICT_HEADING,
    'reviewed_range: a1e483a..7034e29',
    'deviations_count: 2',
    '- deviation: /flow <ref> resume broken | why: spec requires it (inferred: spec line 1) | flow/resume.ts:18',
    '- deviation: matcher /halts and resumes/ regressed | why: spec requires the regex (inferred: picker test gap) | flow/picker.ts:7',
  ].join('\n')
  const parsed = parseDeviationArtifact(artifact)
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.deviationsCount, 2)
    assert.equal(parsed.deviations.length, 2)
  }
})
