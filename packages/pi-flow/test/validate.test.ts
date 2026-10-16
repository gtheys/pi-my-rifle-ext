import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('buildValidatePrompt: personal mode is a PMR-8449 seam', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    scriptsDir: null,
  })
  assert.ok(p.includes('PMR-8449'))
})
