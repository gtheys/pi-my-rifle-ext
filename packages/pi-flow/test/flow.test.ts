import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL, phaseCommands } from '../flow/orchestrate.ts'
import { buildFlowPrompt } from '../flow/prompt.ts'

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

// --- phaseCommands (PMR-7HDW: --skip-research propagation) ---

test('phaseCommands: skipResearch flags the implement entry only', () => {
  const commands = phaseCommands('research', 'PMR-abc', true)
  assert.deepEqual(commands, [
    '/research PMR-abc',
    '/plan PMR-abc',
    '/implement PMR-abc --skip-research',
    '/validate PMR-abc',
    '/feedback PMR-abc',
  ])
})

test('phaseCommands: no flag anywhere when skipResearch is false', () => {
  for (const cmd of phaseCommands('research', 'PMR-abc', false)) {
    assert.equal(cmd.includes('--skip-research'), false)
  }
})

test('phaseCommands: starting at implement still gets the flag', () => {
  const commands = phaseCommands('implement', 'DP-71', true)
  assert.deepEqual(commands, [
    '/implement DP-71 --skip-research',
    '/validate DP-71',
    '/feedback DP-71',
  ])
})

test('buildFlowPrompt: skip-research run carries the flagged implement command', () => {
  // Full /flow wiring as the handler composes it: nextPhase decides the
  // start phase, phaseCommands builds the list, buildFlowPrompt renders it.
  const next = nextPhase([], true)
  assert.equal(next.kind, 'phase')
  if (next.kind !== 'phase') return
  const prompt = buildFlowPrompt({
    mode: 'personal',
    ref: 'PMR-abc',
    startPhase: next.phase,
    commands: [
      ...phaseCommands(next.phase, 'PMR-abc', next.researchSkip === true),
    ],
    researchSkip: next.researchSkip === true,
  })
  assert.match(prompt, /\/implement PMR-abc --skip-research/)
  // Every other phase command stays flag-free (their parsers treat extra
  // tokens as help).
  assert.match(prompt, /- \/plan PMR-abc\n/)
  assert.match(prompt, /- \/validate PMR-abc\n/)
  assert.match(prompt, /- \/feedback PMR-abc\n/)
})
