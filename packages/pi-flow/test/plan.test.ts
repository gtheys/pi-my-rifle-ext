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
  assert.match(prompt, /todo/)
  assert.match(prompt, /PMR-F7YM/)
  assert.match(prompt, /\/x\/plan\.md/)
  assert.match(prompt, /open_in_pane/)
})

// AIDEV-NOTE: PMR-QRJA — the plan phase must END in plan-state=review with
// flow_phase_complete deferred until spec approval; the "planned" label only
// lands after the human approves via spec_approve / /spec-review.
test('buildPlanPrompt: personal mode ends phase in review, not complete', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /plan-state=review/)
  assert.match(prompt, /aven edit PMR-F7YM --metadata plan-state=review/)
  assert.match(prompt, /do not call the\s+flow_phase_complete tool/i)
})

test('buildPlanPrompt: personal mode completes only after plan-state=approved', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /plan-state=approved/)
  assert.match(prompt, /spec_approve/)
  assert.match(
    prompt,
    /flow_phase_complete tool with ref=<ticket ref> and phase="plan"/,
  )
  assert.match(prompt, /"planned" label/)
  const approvedIdx = prompt.indexOf('plan-state=approved')
  const completeIdx = prompt.indexOf(
    'flow_phase_complete tool with ref=<ticket ref>',
  )
  assert.ok(approvedIdx !== -1)
  assert.ok(completeIdx > approvedIdx, 'completion must follow approval')
})

// AIDEV-NOTE: regression guard — /flow resume re-runs this prompt; without an
// approved-check it would reset plan-state to review on already-approved
// tickets and loop pause/approve/resume forever.
test('buildPlanPrompt: personal mode checks plan-state before setting review', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /aven show PMR-F7YM --full/)
  const checkIdx = prompt.indexOf('aven show PMR-F7YM --full')
  const reviewIdx = prompt.indexOf('plan-state=review')
  assert.ok(checkIdx !== -1)
  assert.ok(reviewIdx > checkIdx, 'approved-check must precede review set')
})

test('buildPlanPrompt: personal mode skips review when already approved', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(
    prompt,
    /ALREADY at plan-state=approved[\s\S]*?flow_phase_complete tool/,
    'must go straight to flow_phase_complete when plan-state=approved',
  )
  assert.match(prompt, /do NOT set plan-state=review/i)
})

// AIDEV-NOTE: PMR-3HMZ — the personal ONESHOT route skips the spec-approval
// gate: no plan-state=review, no spec_approve wait; the prompt closes the
// phase via flow_phase_complete right after the human confirms the split.
// Only the plan route keeps the PMR-QRJA review gate.
test('buildPlanPrompt: personal oneshot route skips the spec-approval gate', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  const oneshotIdx = prompt.indexOf('If confirmed as oneshot')
  const planIdx = prompt.indexOf('If confirmed as plan')
  assert.ok(oneshotIdx !== -1)
  assert.ok(planIdx > oneshotIdx)
  const oneshotBlock = prompt.slice(oneshotIdx, planIdx)
  assert.ok(
    !oneshotBlock.includes('--metadata plan-state=review'),
    'oneshot block must not send the ticket into spec review',
  )
  assert.match(oneshotBlock, /skip spec approval/)
  assert.match(
    oneshotBlock,
    /flow_phase_complete tool\s+with ref=PMR-F7YM and phase="plan"/,
  )
})

// AIDEV-NOTE: regression guard — personal plan must open the review pane — parity with
// feature-plan-aven (work mode), which opens plan.md via open_in_pane itself.
test('buildPlanPrompt: personal mode opens plan.md in a herdr review pane', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.match(
    prompt,
    /write the plan\.md to: \/x\/plan\.md[\s\S]*open_in_pane tool with that path/,
  )
  assert.match(prompt, /never block/)
})

// AIDEV-NOTE: regression guard — personal plan must handle a ticket that is
// ALREADY an epic with children (e.g. a post-review hardening epic):
// confirm/refresh the tree, encode order as dep links, never decompose again.
test('buildPlanPrompt: personal mode handles existing epic trees', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-Z0M2',
    planPath: '/x/plan.md',
  })
  assert.match(prompt, /aven epic list PMR-Z0M2/)
  assert.match(prompt, /never decompose/i)
  assert.match(prompt, /aven dep add/)
  assert.match(prompt, /aven epic add/)
  assert.match(prompt, /aven epic remove/)
  assert.match(prompt, /plan-path=\/x\/plan\.md/)
})

// AIDEV-NOTE: regression guard — "aven epic create" is not a real command;
// the ticket itself becomes the epic via aven edit --epic on.
test('buildPlanPrompt: personal mode uses real aven commands for epic creation', () => {
  const prompt = buildPlanPrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    planPath: '/x/plan.md',
  })
  assert.ok(
    !/aven epic create/.test(prompt),
    'prompt must not reference the nonexistent "aven epic create" command',
  )
  assert.match(prompt, /aven edit PMR-F7YM --epic on/)
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

test('parsePlanArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parsePlanArgs('aven:DP-71'), { kind: 'aven', ref: 'DP-71' })
  assert.deepEqual(parsePlanArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})
