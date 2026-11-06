import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL } from '../flow/orchestrate.ts'

// --- parseFlowArgs ---

test('parseFlowArgs: aven ref', () => {
  const parsed = parseFlowArgs('PMR-abc123')
  assert.deepEqual(parsed, { kind: 'aven', ref: 'PMR-abc123' })
})

test('parseFlowArgs: jira ref normalizes', () => {
  const parsed = parseFlowArgs('dp-71')
  assert.deepEqual(parsed, { kind: 'jira', jiraId: 'DP-71' })
})

test('parseFlowArgs: empty is help', () => {
  assert.equal(parseFlowArgs('').kind, 'help')
  assert.equal(parseFlowArgs('  ').kind, 'help')
})

test('parseFlowArgs: extra positional args are help', () => {
  assert.equal(parseFlowArgs('a b').kind, 'help')
})

// --- nextPhase (pure resolver, mapping table; PIV lifecycle, PMR-Z2K7) ---

test('nextPhase: no labels -> plan', () => {
  assert.deepEqual(nextPhase([]), { kind: 'phase', phase: 'plan' })
})

test('nextPhase: planned -> implement', () => {
  assert.deepEqual(nextPhase(['planned']), {
    kind: 'phase',
    phase: 'implement',
  })
})

test('nextPhase: active -> validate', () => {
  assert.deepEqual(nextPhase(['planned', 'active']), {
    kind: 'phase',
    phase: 'validate',
  })
})

test('nextPhase: review-passed -> feedback', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed']), {
    kind: 'phase',
    phase: 'feedback',
  })
})

test('nextPhase: personal review-passed -> done (feedback folded into validate)', () => {
  assert.deepEqual(
    nextPhase(['planned', 'active', 'review-passed'], 'personal'),
    { kind: 'done' },
  )
})

test('nextPhase: work review-passed -> feedback (explicit mode)', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed'], 'work'), {
    kind: 'phase',
    phase: 'feedback',
  })
})

test('nextPhase: done label -> done', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed', 'done']), {
    kind: 'done',
  })
})

test('nextPhase: mid-flow kill resumes at implement without duplicates', () => {
  // Labels as they exist after a kill during implement (plan done,
  // active not yet set). Re-running yields implement, then the same labels
  // again yield implement — idempotent, no phase is skipped or repeated.
  const labels = ['planned']
  const first = nextPhase(labels)
  const second = nextPhase(labels)
  assert.deepEqual(first, { kind: 'phase', phase: 'implement' })
  assert.deepEqual(second, { kind: 'phase', phase: 'implement' })
})

test('nextPhase: legacy research-era labels do not affect resolution', () => {
  assert.deepEqual(nextPhase(['researched', 'research-skipped']), {
    kind: 'phase',
    phase: 'plan',
  })
  assert.deepEqual(nextPhase(['researched', 'research-skipped', 'planned']), {
    kind: 'phase',
    phase: 'implement',
  })
})

test('PHASE_LABEL maps every phase to its lifecycle label', () => {
  assert.equal(PHASE_LABEL.plan, 'planned')
  assert.equal(PHASE_LABEL.implement, 'active')
  assert.equal(PHASE_LABEL.validate, 'review-passed')
  assert.equal(PHASE_LABEL.feedback, 'done')
})

test('parseFlowArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parseFlowArgs('aven:DP-71'), {
    kind: 'aven',
    ref: 'DP-71',
  })
  assert.deepEqual(parseFlowArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})
