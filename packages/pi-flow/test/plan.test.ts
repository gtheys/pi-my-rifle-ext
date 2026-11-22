import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canImplement } from '../gates.ts'
import { parsePlanArgs } from '../plan/args.ts'
import { buildPlanPrompt } from '../plan/prompt.ts'
import { classifySize } from '../plan/size-check.ts'

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

// --- prompt ---

const PERSONAL = {
  mode: 'personal',
  ref: 'PMR-F7YM',
} as const

// Regression guard: work-mode route must hand off to the existing
// feature-plan-aven skill by name, carrying the Jira ref — behavior unchanged.
test('buildPlanPrompt: work mode references feature-plan-aven + Jira ref', () => {
  const prompt = buildPlanPrompt({
    mode: 'work',
    ref: 'DP-123',
  })
  assert.match(prompt, /feature-plan-aven/)
  assert.match(prompt, /DP-123/)
})

// AIDEV-NOTE: PMR-T6KF — personal mode's plan route delegates to the
// feature-plan-aven skill by name, same as work mode. Only the size check +
// oneshot escape stay inline.
test('buildPlanPrompt: personal plan route delegates to feature-plan-aven by name', () => {
  const prompt = buildPlanPrompt(PERSONAL)
  assert.match(prompt, /engineering:feature-plan-aven/)
  assert.match(prompt, /personal aven ticket PMR-F7YM/)
  assert.match(prompt, /resume ladder owns ALL resume states/)
  // Personal-mode approval: receipt-gated — the human runs /flow answer
  // first, then spec_approve accepts; raw aven plan-state edits are
  // forbidden in flow context. flow_phase_complete still never reads
  // plan-state.
  assert.match(prompt, /\/flow answer PMR-F7YM approve/)
  assert.match(prompt, /receipt-gated/)
  assert.match(prompt, /refuses[\s\S]*?without the receipt/)
  assert.match(prompt, /NOT run raw/)
  assert.match(prompt, /aven edit --metadata plan-state=approved/)
  assert.match(prompt, /never reads plan-state/)
  assert.ok(
    !/only reads plan-state/.test(prompt),
    'prompt must not claim the gate reads plan-state',
  )
})

test('buildPlanPrompt: personal mode keeps size check + confirm gate', () => {
  const prompt = buildPlanPrompt(PERSONAL)
  assert.match(prompt, /size check/i)
  assert.match(prompt, /classifySize/)
  assert.match(prompt, /ask_user_question/)
  assert.match(prompt, /oneshot/)
  assert.match(prompt, /todo/)
  assert.match(prompt, /PMR-F7YM/)
})

// AIDEV-NOTE: PMR-T6KF — both modes share the same approval suffix: the
// "planned" label lands ONLY after approval + tree; flow_phase_complete runs
// at the end, never before. PMR-C0YV — the suffix must also state the loop's
// auto-advance (closing message: implement starts automatically, no action
// needed, never claim a halt) and phrase the unapproved route as a graceful
// pause, matching loop.ts's pause notify.
test('buildPlanPrompt: personal plan route shares the approval suffix', () => {
  const personal = buildPlanPrompt(PERSONAL)
  const work = buildPlanPrompt({
    mode: 'work',
    ref: 'DP-123',
  })
  for (const prompt of [personal, work]) {
    assert.match(prompt, /"planned" label lands\s+ONLY after approval/)
    assert.match(
      prompt,
      /flow_phase_complete tool with ref=<ticket ref> and\s+phase="plan"/,
    )
    assert.match(prompt, /plan-state "review" WITHOUT\s+the "planned" label/)
    assert.match(
      prompt,
      /loop\s+advances <ticket ref> into the\s+implement phase automatically/,
    )
    assert.match(prompt, /never claim the flow halts/)
    assert.match(prompt, /the flow pauses at plan/)
    assert.ok(
      !/halts and resumes/.test(prompt),
      'old halt narration must be gone',
    )
  }
})

// AIDEV-NOTE: PMR-3HMZ — the personal ONESHOT route skips the spec-approval
// gate: no plan-state=review, no spec_approve wait; the prompt closes the
// phase via flow_phase_complete right after the human confirms the split.
// Only the plan route keeps the PMR-QRJA review gate (via the skill).
// PMR-C0YV — the oneshot block must also announce the loop's auto-advance
// into implement (no action needed) and must not instruct the human to run
// /implement or claim a halt: the loop injects the next phase itself.
test('buildPlanPrompt: personal oneshot route skips the spec-approval gate', () => {
  const prompt = buildPlanPrompt(PERSONAL)
  const oneshotIdx = prompt.indexOf('If confirmed as oneshot')
  const planIdx = prompt.indexOf('If confirmed as plan')
  assert.ok(oneshotIdx !== -1)
  assert.ok(planIdx > oneshotIdx)
  const oneshotBlock = prompt.slice(oneshotIdx, planIdx)
  assert.ok(
    !oneshotBlock.includes('plan-state=review'),
    'oneshot block must not send the ticket into spec review',
  )
  assert.match(oneshotBlock, /skip spec approval/)
  assert.match(
    oneshotBlock,
    /flow_phase_complete tool\s+with ref=PMR-F7YM and phase="plan"/,
  )
  assert.match(
    oneshotBlock,
    /advances PMR-F7YM\s+into the implement phase automatically/,
  )
  assert.match(oneshotBlock, /no action is needed/)
  assert.ok(
    !/halts and resumes/.test(oneshotBlock),
    'oneshot block must not claim the flow halts',
  )
  assert.ok(
    !/run \/implement/.test(oneshotBlock),
    'oneshot block must not tell the human to run /implement',
  )
})

// AIDEV-NOTE: PMR-C0YV review P1 — the plan prompt ALSO reaches the
// standalone /plan command, which arms no flow loop. The advancement wording
// is prompt-only (no delivery-path input): both modes must carry BOTH
// branches — loop auto-advance AND the /flow <ref> resume handoff — so the
// session picks the branch matching the command that started it. Neither
// branch may claim a halt.
test('buildPlanPrompt: advancement wording covers both delivery paths', () => {
  const personal = buildPlanPrompt(PERSONAL)
  const work = buildPlanPrompt({
    mode: 'work',
    ref: 'DP-123',
  })
  for (const prompt of [personal, work]) {
    assert.match(
      prompt,
      /loop\s+advances <ticket ref> into the\s+implement phase automatically/,
    )
    assert.match(prompt, /no action is needed/)
    assert.match(
      prompt,
      /run \/flow <ticket ref>\s+to continue into the implement phase/,
    )
    assert.match(prompt, /never claim the flow halts/i)
    assert.ok(!/halts and resumes/.test(prompt))
  }
  const oneshotIdx = personal.indexOf('If confirmed as oneshot')
  const planIdx = personal.indexOf('If confirmed as plan')
  const oneshotBlock = personal.slice(oneshotIdx, planIdx)
  assert.match(
    oneshotBlock,
    /advances PMR-F7YM into the implement phase automatically/,
  )
  assert.match(oneshotBlock, /no action is needed/)
  assert.match(
    oneshotBlock,
    /run \/flow\s+PMR-F7YM to start the implement phase/,
  )
  assert.ok(!/halts and resumes/.test(oneshotBlock))
})

// AIDEV-NOTE: PMR-T6KF regression guard — the personal plan route must NOT
// carry the old inline flow: no inline epic/subtask decomposition, no
// existing-tree refresh step, no plan-state heredoc resume parsing. The
// skill's workflow and resume ladder own all of these.
test('buildPlanPrompt: personal plan route has no inline decomposition or resume parsing', () => {
  const prompt = buildPlanPrompt(PERSONAL)
  assert.ok(
    !/aven epic add <child-ref>/.test(prompt),
    'no inline subtask linking on the plan branch',
  )
  assert.ok(!/aven epic list/.test(prompt), 'no existing-tree refresh step')
  assert.ok(!/aven epic remove/.test(prompt), 'no existing-tree refresh step')
  assert.ok(!/--epic on/.test(prompt), 'no inline epic conversion')
  assert.ok(!/value<<EOF/.test(prompt), 'no plan-state heredoc parsing')
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

test('parsePlanArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parsePlanArgs('aven:DP-71'), { kind: 'aven', ref: 'DP-71' })
  assert.deepEqual(parsePlanArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})
