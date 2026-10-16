import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import { parseValidateArgs } from '../validate/args.ts'
import {
  GATE_STEPS,
  gatePassed,
  initialGateState,
  pollExhausted,
  stepFails,
  stepSucceeds,
} from '../validate/gate.ts'
import { DEVCTL_REPO_NAME, resolveDevctlScriptsDir } from '../validate/paths.ts'
import { composeHumanTest, routePersonalOutcome } from '../validate/personal.ts'
import { buildValidatePrompt } from '../validate/prompt.ts'

// --- args ---

test('parseValidateArgs: empty → help', () => {
  assert.deepEqual(parseValidateArgs(''), { kind: 'help' })
  assert.deepEqual(parseValidateArgs('   '), { kind: 'help' })
})

test('parseValidateArgs: Jira-style ref', () => {
  assert.deepEqual(parseValidateArgs('DP-123'), {
    kind: 'jira',
    jiraId: 'DP-123',
  })
  assert.deepEqual(parseValidateArgs('  dp-42  '), {
    kind: 'jira',
    jiraId: 'DP-42',
  })
})

test('parseValidateArgs: aven ref', () => {
  assert.deepEqual(parseValidateArgs('PMR-F7YM'), {
    kind: 'aven',
    ref: 'PMR-F7YM',
  })
})

test('parseValidateArgs: multiple tokens → help', () => {
  assert.deepEqual(parseValidateArgs('DP-1 extra'), { kind: 'help' })
})

// --- gate state machine ---

test('gate: initial state is at minikube, not passed', () => {
  const s = initialGateState()
  assert.equal(s.step, 'minikube')
  assert.equal(s.failed, null)
  assert.deepEqual(s.completed, [])
  assert.equal(gatePassed(s), false)
})

test('gate: success advances in order to completion', () => {
  let s = initialGateState()
  for (const expected of GATE_STEPS) {
    assert.equal(s.step, expected)
    s = stepSucceeds(s)
  }
  assert.equal(gatePassed(s), true)
  assert.deepEqual(s.completed, [...GATE_STEPS])
})

test('gate: failure records step + output and refuses to advance', () => {
  const s0 = initialGateState()
  const s1 = stepFails(s0, 'minikube start timed out')
  assert.deepEqual(s1.failed, {
    step: 'minikube',
    output: 'minikube start timed out',
  })
  assert.equal(s1.step, 'minikube')
  assert.equal(gatePassed(s1), false)
  // advancing past a failed gate is refused — state unchanged
  const s2 = stepSucceeds(s1)
  assert.deepEqual(s2, s1)
})

test('gate: failure at later step keeps earlier completions', () => {
  let s = stepSucceeds(initialGateState()) // minikube done
  s = stepSucceeds(s) // connectivity done -> at queues
  assert.equal(s.step, 'queues')
  const failed = stepFails(s, 'exit 1: queue creation failed')
  assert.deepEqual(failed.failed, {
    step: 'queues',
    output: 'exit 1: queue creation failed',
  })
  assert.deepEqual(failed.completed, ['minikube', 'connectivity'])
})

test('gate: succeed after recorded failure is refused (re-run required)', () => {
  const failed = stepFails(initialGateState(), 'boom')
  assert.deepEqual(stepSucceeds(failed), failed)
})

// --- bounded poll ---

test('pollExhausted: bounded by maxAttempts', () => {
  const cfg = { maxAttempts: 3, intervalMs: 0 }
  assert.equal(pollExhausted(0, cfg), false)
  assert.equal(pollExhausted(2, cfg), false)
  assert.equal(pollExhausted(3, cfg), true)
  assert.equal(pollExhausted(10, cfg), true)
})

// --- paths ---

test('resolveDevctlScriptsDir: joins first workRoot with devctl repo scripts', () => {
  const dir = resolveDevctlScriptsDir(['/home/geert/Code/salaryhero'])
  assert.equal(dir, '/home/geert/Code/salaryhero/sh-devctl/scripts')
})

test('resolveDevctlScriptsDir: first matching root wins', () => {
  const dir = resolveDevctlScriptsDir(['/a', '/b'])
  assert.equal(dir, '/a/sh-devctl/scripts')
})

test('resolveDevctlScriptsDir: no workRoots → null', () => {
  assert.equal(resolveDevctlScriptsDir([]), null)
})

test('DEVCTL_REPO_NAME is the fixed devctl repo', () => {
  assert.equal(DEVCTL_REPO_NAME, 'sh-devctl')
})

// --- prompt ---

test('buildValidatePrompt: work mode lists all gate steps in order', () => {
  const p = buildValidatePrompt({
    mode: 'work',
    ref: 'DP-71',
    scriptsDir: '/x/sh-devctl/scripts',
  })
  let last = -1
  for (const needle of [
    'minikube status',
    'test-services-connectivity.sh',
    'add-sqs-queues.sh',
    'devctl skill',
    'ask_user_question',
    'acli',
  ]) {
    const i = p.indexOf(needle)
    assert.ok(i > last, `expected "${needle}" after previous step`)
    last = i
  }
  assert.ok(p.includes('DP-71'))
  assert.ok(p.includes('/x/sh-devctl/scripts'))
})

// --- personal mode (PMR-8449) ---

describe('composeHumanTest', () => {
  it('returns insufficient-context when all sections are empty', () => {
    const r = composeHumanTest({
      whatChanged: '',
      planValidationNotes: '',
      researchFindings: '',
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /insufficient/i)
  })
  it('returns insufficient-context when sections are whitespace only', () => {
    const r = composeHumanTest({
      whatChanged: '  ',
      planValidationNotes: '\n',
      researchFindings: '',
    })
    assert.equal(r.ok, false)
  })
  it('composes runnable steps from whatChanged + validation notes', () => {
    const r = composeHumanTest({
      whatChanged: 'Added gate.ts state machine to validate/.',
      planValidationNotes: 'Run: bun test validate. Expect all tests green.',
      researchFindings: 'Gate must never advance past a failure.',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.steps.length >= 2)
    assert.ok(r.steps.some((s) => s.includes('bun test validate')))
    assert.ok(r.expectedOutcome.includes('all tests green'))
    // whatChanged and research findings appear as context steps
    const joined = r.steps.join('\n')
    assert.ok(joined.includes('Added gate.ts'))
  })
  it('missing validation notes still composes but expected outcome comes from research', () => {
    const r = composeHumanTest({
      whatChanged: 'Rewired /validate personal branch.',
      planValidationNotes: '',
      researchFindings: 'Human runs the flow and answers pass/fail.',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.expectedOutcome.includes('pass/fail'))
  })
})

describe('routePersonalOutcome', () => {
  it('pass completes with a dated aven note', () => {
    const r = routePersonalOutcome({ kind: 'pass' }, '2026-10-16')
    assert.deepEqual(r, {
      action: 'complete',
      avenNote: 'validated by human, 2026-10-16',
    })
  })
  it('fail routes back to /implement with the failure note and retry reset', () => {
    const r = routePersonalOutcome(
      { kind: 'fail', description: 'gate froze after step 2' },
      '2026-10-16',
    )
    assert.deepEqual(r, {
      action: 'reimplement',
      avenNote: 'gate froze after step 2',
      route: '/implement',
      retryBudgetReset: true,
    })
  })
  it('fail without description is refused', () => {
    const r = routePersonalOutcome(
      { kind: 'fail', description: '   ' },
      '2026-10-16',
    )
    assert.equal(r.action, 'invalid')
  })
})

test('buildValidatePrompt: personal mode asks for artifacts, ask_user_question, routing', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    scriptsDir: null,
  })
  assert.ok(p.includes('PMR-F7YM'))
  assert.ok(p.includes('ask_user_question'))
  assert.ok(p.includes('/implement'))
  assert.ok(p.includes('validated by human'))
  assert.ok(!p.includes('PMR-8449'))
  assert.ok(!p.includes('minikube'))
})
