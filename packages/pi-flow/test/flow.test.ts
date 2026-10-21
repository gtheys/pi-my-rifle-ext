import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL } from '../flow/orchestrate.ts'

// --- parseFlowArgs ---

test('parseFlowArgs: aven ref', () => {
  const parsed = parseFlowArgs('PMR-abc123')
  assert.deepEqual(parsed, {
    kind: 'aven',
    ref: 'PMR-abc123',
    skipResearch: false,
  })
})

test('parseFlowArgs: jira ref normalizes', () => {
  const parsed = parseFlowArgs('dp-71')
  assert.deepEqual(parsed, {
    kind: 'jira',
    jiraId: 'DP-71',
    skipResearch: false,
  })
})

test('parseFlowArgs: --skip-research passthrough', () => {
  const parsed = parseFlowArgs('PMR-abc --skip-research')
  assert.deepEqual(parsed, { kind: 'aven', ref: 'PMR-abc', skipResearch: true })
})

test('parseFlowArgs: empty is help', () => {
  assert.equal(parseFlowArgs('').kind, 'help')
  assert.equal(parseFlowArgs('  ').kind, 'help')
})

test('parseFlowArgs: extra positional args are help', () => {
  assert.equal(parseFlowArgs('a b').kind, 'help')
})

// --- nextPhase (pure resolver, mapping table) ---

test('nextPhase: no labels -> research', () => {
  assert.deepEqual(nextPhase([], false), { kind: 'phase', phase: 'research' })
})

test('nextPhase: skipResearch with no researched -> plan + researchSkip', () => {
  assert.deepEqual(nextPhase([], true), {
    kind: 'phase',
    phase: 'plan',
    researchSkip: true,
  })
})

test('nextPhase: researched -> plan', () => {
  assert.deepEqual(nextPhase(['researched'], false), {
    kind: 'phase',
    phase: 'plan',
  })
})

test('nextPhase: planned -> implement', () => {
  assert.deepEqual(nextPhase(['researched', 'planned'], false), {
    kind: 'phase',
    phase: 'implement',
  })
})

test('nextPhase: active -> validate', () => {
  assert.deepEqual(nextPhase(['researched', 'planned', 'active'], false), {
    kind: 'phase',
    phase: 'validate',
  })
})

test('nextPhase: review-passed -> feedback', () => {
  assert.deepEqual(
    nextPhase(['researched', 'planned', 'active', 'review-passed'], false),
    { kind: 'phase', phase: 'feedback' },
  )
})

test('nextPhase: done label -> done', () => {
  assert.deepEqual(
    nextPhase(
      ['researched', 'planned', 'active', 'review-passed', 'done'],
      false,
    ),
    { kind: 'done' },
  )
})

test('nextPhase: mid-flow kill resumes at implement without duplicates', () => {
  // Labels as they exist after a kill during implement (research+plan done,
  // active not yet set). Re-running yields implement, then the same labels
  // again yield implement — idempotent, no phase is skipped or repeated.
  const labels = ['researched', 'planned']
  const first = nextPhase(labels, false)
  const second = nextPhase(labels, true)
  assert.deepEqual(first, { kind: 'phase', phase: 'implement' })
  assert.deepEqual(second, { kind: 'phase', phase: 'implement' })
})

test('nextPhase: skipResearch is irrelevant once researched', () => {
  assert.deepEqual(nextPhase(['researched'], true), {
    kind: 'phase',
    phase: 'plan',
  })
})

test('PHASE_LABEL maps every phase to its lifecycle label', () => {
  assert.equal(PHASE_LABEL.research, 'researched')
  assert.equal(PHASE_LABEL.plan, 'planned')
  assert.equal(PHASE_LABEL.implement, 'active')
  assert.equal(PHASE_LABEL.validate, 'review-passed')
  assert.equal(PHASE_LABEL.feedback, 'done')
})
