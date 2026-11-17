import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenGate } from '../flow/gates.ts'
import {
  buildGateFallbackLines,
  buildGateMenuOptions,
  gateChoices,
} from '../flow/picker.ts'

const gates: OpenGate[] = [
  {
    ref: 'PMR-AAA',
    kind: 'plan-review',
    title: 'PMR-AAA · plan review — awaiting /flow answer approve',
  },
  { ref: 'PMR-BBB', kind: 'flow-paused', title: 'PMR-BBB · flow run paused' },
  {
    ref: 'PMR-CCC',
    kind: 'code-review',
    title: 'PMR-CCC · code review — no receipt yet',
  },
  {
    ref: 'PMR-DDD',
    kind: 'answer-gate',
    title: 'PMR-DDD · spec review gate',
    answerCommand: '/flow answer PMR-DDD',
  },
]

test('buildGateMenuOptions: one option per gate, label = title, value = ref', () => {
  const options = buildGateMenuOptions(gates)
  assert.equal(options.length, 4)
  for (let i = 0; i < gates.length; i++) {
    assert.equal(options[i].label, gates[i].title)
    assert.equal(options[i].value, gates[i].ref)
  }
})

test('buildGateMenuOptions: values unique across distinct refs', () => {
  const options = buildGateMenuOptions(gates)
  const values = new Set(options.map((o) => o.value))
  assert.equal(values.size, options.length)
})

test('buildGateMenuOptions: empty gates → empty array', () => {
  assert.deepEqual(buildGateMenuOptions([]), [])
})

test('gateChoices: plan-review → approve/reject then escape', () => {
  const choices = gateChoices(gates[0])
  assert.deepEqual(
    choices.map((c) => c.value),
    ['approve', 'reject', '__command__'],
  )
  assert.equal(choices[choices.length - 1].label, 'show command instead')
})

test('gateChoices: flow-paused → approve/reject then escape', () => {
  const choices = gateChoices(gates[1])
  assert.deepEqual(
    choices.map((c) => c.value),
    ['approve', 'reject', '__command__'],
  )
})

test('gateChoices: code-review → pass/fail then escape', () => {
  const choices = gateChoices(gates[2])
  assert.deepEqual(
    choices.map((c) => c.value),
    ['pass', 'fail', '__command__'],
  )
})

test('gateChoices: answer-gate → default approve/reject vocabulary then escape', () => {
  const choices = gateChoices(gates[3])
  assert.deepEqual(
    choices.map((c) => c.value),
    ['approve', 'reject', '__command__'],
  )
})

test('buildGateFallbackLines: numbered title lines + answer-with line', () => {
  const lines = buildGateFallbackLines(gates)
  assert.equal(lines.length, 8)
  assert.equal(
    lines[0],
    '1. PMR-AAA · plan review — awaiting /flow answer approve',
  )
  assert.equal(lines[1], '   answer with: /flow answer PMR-AAA approve|reject')
  assert.equal(lines[2], '2. PMR-BBB · flow run paused')
  assert.equal(lines[3], '   answer with: /flow answer PMR-BBB approve|reject')
  assert.equal(lines[4], '3. PMR-CCC · code review — no receipt yet')
  assert.equal(lines[5], '   answer with: /flow answer PMR-CCC pass|fail')
  assert.equal(lines[6], '4. PMR-DDD · spec review gate')
  assert.equal(lines[7], '   answer with: /flow answer PMR-DDD approve|reject')
})

test('buildGateFallbackLines: empty gates → []', () => {
  assert.deepEqual(buildGateFallbackLines([]), [])
})

test('all labels are single-line and lead with the ref', () => {
  for (const gate of gates) {
    for (const option of buildGateMenuOptions([gate])) {
      assert.ok(!option.label.includes('\n'))
      assert.ok(option.label.startsWith(gate.ref))
    }
    for (const choice of gateChoices(gate)) {
      assert.ok(!choice.label.includes('\n'))
    }
  }
})
