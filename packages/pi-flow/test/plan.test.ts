import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canImplement, needsResearchSkip } from '../gates.ts'
import { parsePlanArgs } from '../plan/args.ts'
import { resolvePlanDir } from '../plan/paths.ts'
import { buildPlanPrompt } from '../plan/prompt.ts'
import { classifySize } from '../plan/size-check.ts'
import { buildEpicSplitPlan, type SplitInput } from '../plan/split-gate.ts'

// --- args ---

test('parsePlanArgs: empty → help', () => {
  assert.deepEqual(parsePlanArgs(''), { kind: 'help' })
  assert.deepEqual(parsePlanArgs('   '), { kind: 'help' })
})

test('parsePlanArgs: Jira-style ref', () => {
  assert.deepEqual(parsePlanArgs('DP-123'), { kind: 'jira', jiraId: 'DP-123' })
  assert.deepEqual(parsePlanArgs('  dp-42  '), {
    kind: 'jira',
    jiraId: 'DP-42',
  })
})

test('parsePlanArgs: aven ref', () => {
  assert.deepEqual(parsePlanArgs('PMR-F7YM'), {
    kind: 'aven',
    ref: 'PMR-F7YM',
  })
})

// --- size check ---

test('classifySize: single-module change → oneshot', () => {
  const v = classifySize({
    title: 'Fix label parsing',
    description: 'Change one regex in packages/pi-flow and update its test.',
  })
  assert.equal(v.size, 'oneshot')
  assert.deepEqual(v.reasons, [])
})

test('classifySize: data-model hit → plan with reason', () => {
  const v = classifySize({
    title: 'Add ticket sync',
    description: 'Needs a migration to add a new table for labels.',
  })
  assert.equal(v.size, 'plan')
  assert.ok(v.reasons.some((r) => r.includes('data model')))
})

test('classifySize: cross-package hit → plan with reason', () => {
  const v = classifySize({
    title: 'Shared config',
    description: 'Move config parsing so it is shared across packages.',
  })
  assert.equal(v.size, 'plan')
  assert.ok(v.reasons.some((r) => r.includes('cross-package')))
})

test('classifySize: multi-step test hit → plan with reason', () => {
  const v = classifySize({
    title: 'Rework flow',
    description: 'Requires updating integration tests in several suites.',
  })
  assert.equal(v.size, 'plan')
  assert.ok(v.reasons.some((r) => r.includes('test')))
})

test('classifySize: multiple hits → multiple reasons', () => {
  const v = classifySize({
    title: 'Big one',
    description: 'Schema migration plus cross-package refactor.',
  })
  assert.equal(v.size, 'plan')
  assert.equal(v.reasons.length, 2)
})

// --- split gate ---

const splitBase: SplitInput = {
  confirmed: true,
  ref: 'PMR-F7YM',
  title: 'RPIV plan flow',
  subtasks: ['Size check', 'Handoff prompt'],
}

test('buildEpicSplitPlan: confirmed → epic plan', () => {
  const plan = buildEpicSplitPlan(splitBase)
  assert.ok(plan)
  assert.equal(plan.ref, 'PMR-F7YM')
  assert.equal(plan.subtasks.length, 2)
})

test('buildEpicSplitPlan: not confirmed → null', () => {
  assert.equal(buildEpicSplitPlan({ ...splitBase, confirmed: false }), null)
  assert.equal(buildEpicSplitPlan({ ...splitBase, confirmed: undefined }), null)
})

test('buildEpicSplitPlan: no subtasks → null', () => {
  assert.equal(buildEpicSplitPlan({ ...splitBase, subtasks: [] }), null)
})

// --- prompt ---

// Regression guard: work-mode route must hand off to the existing
// feature-plan-aven skill by name, carrying the Jira ref — behavior unchanged.
test('buildPlanPrompt: work mode references feature-plan-aven + Jira ref', () => {
  const prompt = buildPlanPrompt({
    mode: 'work',
    ref: 'DP-123',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /feature-plan-aven/)
  assert.match(prompt, /DP-123/)
})

test('buildPlanPrompt: personal mode instructs size check + confirm gate', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /size check/i)
  assert.match(prompt, /ask_user_question/)
  assert.match(prompt, /oneshot/)
  assert.match(prompt, /planned/)
  assert.match(prompt, /todo/)
  assert.match(prompt, /PMR-F7YM/)
  assert.match(prompt, /\/x\/plan\.md/)
})

// --- W76D gates ---

test('canImplement: refuses without planned label', () => {
  const r = canImplement(['researched', 'oneshot'])
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /planned/)
})

test('canImplement: ok with planned', () => {
  const r = canImplement(['planned'])
  assert.equal(r.ok, true)
  assert.equal(r.reason, undefined)
})

test('needsResearchSkip: true only when researched missing', () => {
  assert.equal(needsResearchSkip(['planned']), true)
  assert.equal(needsResearchSkip(['planned', 'researched']), false)
})

// --- paths ---

test('resolvePlanDir: PERSONAL_FEATURES set → features branch', () => {
  assert.equal(
    resolvePlanDir('/pf', 'myrepo', '/home/x/repo', '2026-10-16', 'add-thing'),
    '/pf/myrepo/2026-10-16-add-thing',
  )
})

test('resolvePlanDir: PERSONAL_FEATURES unset → .pi/plans branch', () => {
  assert.equal(
    resolvePlanDir(undefined, 'myrepo', '/home/x/repo', '2026-10-16', 'add'),
    '/home/x/repo/.pi/plans/2026-10-16-add',
  )
})
