import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFeedbackArgs } from '../feedback/args.ts'
import { buildFeedbackPrompt } from '../feedback/prompt.ts'
import { canClose, classify, outcomeSummary } from '../feedback/triage.ts'

// --- args ---

test('parseFeedbackArgs: empty → help', () => {
  assert.deepEqual(parseFeedbackArgs(''), { kind: 'help' })
  assert.deepEqual(parseFeedbackArgs('   '), { kind: 'help' })
})

test('parseFeedbackArgs: Jira-style ref', () => {
  assert.deepEqual(parseFeedbackArgs('DP-123'), {
    kind: 'jira',
    jiraId: 'DP-123',
  })
  assert.deepEqual(parseFeedbackArgs('  dp-42  '), {
    kind: 'jira',
    jiraId: 'DP-42',
  })
})

test('parseFeedbackArgs: aven ref', () => {
  assert.deepEqual(parseFeedbackArgs('PMR-F7YM'), {
    kind: 'aven',
    ref: 'PMR-F7YM',
  })
})

test('parseFeedbackArgs: multiple tokens → help', () => {
  assert.deepEqual(parseFeedbackArgs('DP-1 extra'), { kind: 'help' })
})

// --- triage classifier ---

test('classify: minor/style/naming → fix-now', () => {
  for (const severity of ['minor', 'style', 'naming']) {
    assert.deepEqual(classify({ severity }), {
      action: 'fix-now',
    })
  }
})

test('classify: critical/major/blocker → new-task', () => {
  for (const severity of ['critical', 'major', 'blocker']) {
    assert.deepEqual(classify({ severity }), { action: 'new-task' })
  }
})

test('classify: behavioral keywords escalate regardless of severity', () => {
  assert.deepEqual(
    classify({ severity: 'minor', description: 'changes the auth logic' }),
    { action: 'new-task' },
  )
  assert.deepEqual(
    classify({
      severity: 'minor',
      description: 'rename then fix the data migration',
    }),
    { action: 'new-task' },
  )
})

test('classify: unknown severity → new-task (fail-closed)', () => {
  assert.deepEqual(classify({ severity: 'weird' }), { action: 'new-task' })
  assert.deepEqual(classify({}), { action: 'new-task' })
})

// --- outcome summary ---

test('outcomeSummary: markdown body contains all sections', () => {
  const body = outcomeSummary({
    whatShipped: 'feature X',
    testEvidence: '42 tests pass',
    reviewVerdict: 'clean, 0 blockers',
  })
  assert.match(body, /What shipped/)
  assert.match(body, /feature X/)
  assert.match(body, /Test evidence/)
  assert.match(body, /42 tests pass/)
  assert.match(body, /Review verdict/)
  assert.match(body, /clean, 0 blockers/)
})

test('outcomeSummary: empty section → insufficient error', () => {
  const body = outcomeSummary({
    whatShipped: ' ',
    testEvidence: 'e',
    reviewVerdict: 'v',
  })
  assert.match(body, /insufficient/i)
})

// --- completion guard ---

test('canClose: only a written summary closes', () => {
  assert.equal(canClose(false), false)
  assert.equal(canClose(true), true)
})

// --- prompt ---

test('work prompt: invokes /sonarqube and /pr-quality by name, forbids silent fixes', () => {
  const prompt = buildFeedbackPrompt({ mode: 'work', ref: 'DP-12' })
  assert.match(prompt, /\/sonarqube/)
  assert.match(prompt, /\/pr-quality/)
  assert.match(prompt, /never fix.*silently/is)
  assert.match(prompt, /DP-12/)
})

test('personal prompt: reruns /review, requires outcome summary before done', () => {
  const prompt = buildFeedbackPrompt({ mode: 'personal', ref: 'PMR-XDRB' })
  assert.match(prompt, /\/review/)
  assert.match(prompt, /outcome summary/i)
  assert.match(prompt, /PMR-XDRB/)
  assert.match(prompt, /done/i)
})

test('parseFeedbackArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parseFeedbackArgs('aven:DP-71'), {
    kind: 'aven',
    ref: 'DP-71',
  })
  assert.deepEqual(parseFeedbackArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})
