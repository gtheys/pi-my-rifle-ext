import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL } from '../flow/orchestrate.ts'
import { resumeSeedFromEvents } from '../flow/resume.ts'

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

// --- resumeSeedFromEvents (PMR-XTQQ phase 2: /flow resume seeding) ---

test('resume seed: parked loop-state + run-input seeds budget, cutoff, and input', async () => {
  const cutoff = '2026-11-14T10:00:00.000Z'
  const events = [
    {
      kind: 'run-start' as const,
      at: 't',
      ref: 'R',
      mode: 'personal' as const,
    },
    {
      kind: 'run-input' as const,
      at: 't',
      ref: 'R',
      input: { mode: 'personal' as const, gitRoot: '/repo', workRoots: [] },
    },
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: true,
        blockerRetries: 1,
        validateStartedAt: cutoff,
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => true)
  assert.deepEqual(seed.resume, {
    blockerRetries: 1,
    validateStartedAt: cutoff,
  })
  assert.deepEqual(seed.input, {
    mode: 'personal',
    gitRoot: '/repo',
    workRoots: [],
  })
})

test('resume seed: latest loop-state and run-input win (journal tail)', async () => {
  const events = [
    {
      kind: 'loop-state' as const,
      at: 't1',
      ref: 'R',
      loop: {
        phase: 'plan' as const,
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'old',
        status: 'running' as const,
      },
    },
    {
      kind: 'loop-state' as const,
      at: 't2',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: true,
        blockerRetries: 2,
        validateStartedAt: 'new',
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => true)
  assert.deepEqual(seed.resume, {
    blockerRetries: 2,
    validateStartedAt: 'new',
  })
})

test('resume seed: terminal snapshots never seed', async () => {
  const events = [
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: false,
        blockerRetries: 2,
        validateStartedAt: 'cutoff',
        status: 'halted' as const,
      },
    },
  ]
  assert.deepEqual(
    resumeSeedFromEvents(events, () => true),
    {},
  )
})

test('resume seed: journaled run-input ignored when its gitRoot vanished', async () => {
  const events = [
    {
      kind: 'run-input' as const,
      at: 't',
      ref: 'R',
      input: {
        mode: 'personal' as const,
        gitRoot: '/gone/worktree',
        workRoots: [],
      },
    },
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'plan' as const,
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'cutoff',
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => false)
  assert.equal(seed.input, undefined)
  assert.notEqual(seed.resume, undefined)
})

test('resume seed: empty or missing journal seeds nothing', async () => {
  assert.deepEqual(
    resumeSeedFromEvents(null, () => true),
    {},
  )
  assert.deepEqual(
    resumeSeedFromEvents([], () => true),
    {},
  )
})
