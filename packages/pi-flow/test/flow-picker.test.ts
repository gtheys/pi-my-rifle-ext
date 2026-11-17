import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { OpenGate } from '../flow/gates.ts'
import {
  buildGateFallbackLines,
  buildGateMenuOptions,
  COMMAND_ESCAPE_VALUE,
  gateChoices,
  isPickerInvocation,
  planPickerOutcome,
  splitGateValue,
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

test('buildGateMenuOptions: one option per gate, label = title, value = ref|kind composite', () => {
  const options = buildGateMenuOptions(gates)
  assert.equal(options.length, 4)
  for (let i = 0; i < gates.length; i++) {
    assert.equal(options[i].label, gates[i].title)
    assert.equal(options[i].value, `${gates[i].ref}|${gates[i].kind}`)
  }
})

test('buildGateMenuOptions: values unique across distinct refs', () => {
  const options = buildGateMenuOptions(gates)
  const values = new Set(options.map((o) => o.value))
  assert.equal(values.size, options.length)
})

// PMR-ZGPY fix round 2 — ref collision: deriveRunGates can emit two gates
// with the SAME ref (code-review + answer-gate); composite values keep the
// rows distinct and each pick resolves its own vocabulary.
const colliding: OpenGate[] = [
  {
    ref: 'PMR-EEE',
    kind: 'code-review',
    title: 'PMR-EEE — validate phase awaiting code review',
  },
  {
    ref: 'PMR-EEE',
    kind: 'answer-gate',
    title: 'PMR-EEE — spec-review gate awaiting answer',
    answerCommand: '/flow answer PMR-EEE',
  },
]

test('same ref, two kinds → two menu options with distinct composite values', () => {
  const options = buildGateMenuOptions(colliding)
  assert.equal(options.length, 2)
  assert.notEqual(options[0].value, options[1].value)
  assert.deepEqual(
    options.map((o) => o.value),
    ['PMR-EEE|code-review', 'PMR-EEE|answer-gate'],
  )
})

test('splitGateValue: composite value splits into ref + kind', () => {
  assert.deepEqual(splitGateValue('PMR-EEE|code-review'), {
    ref: 'PMR-EEE',
    kind: 'code-review',
  })
  assert.deepEqual(splitGateValue('PMR-1|answer-gate'), {
    ref: 'PMR-1',
    kind: 'answer-gate',
  })
})

test('splitGateValue: ref without separator → empty kind (lookup misses, safe)', () => {
  assert.deepEqual(splitGateValue('PMR-1'), { ref: 'PMR-1', kind: '' })
})

test('planPickerOutcome: picking each colliding row resolves its own vocabulary', () => {
  const menu = planPickerOutcome(true, colliding)
  assert.equal(menu.kind, 'menu')
  if (menu.kind !== 'menu') return
  const options = menu.options
  for (const option of options) {
    const split = splitGateValue(option.value)
    const plan = planPickerOutcome(true, colliding, {
      stage: 'gate-picked',
      gateRef: split.ref,
      gateKind: split.kind,
    })
    assert.equal(plan.kind, 'choice-menu')
    if (plan.kind !== 'choice-menu') return
    const picked = colliding.find(
      (g) => g.ref === split.ref && g.kind === split.kind,
    )
    if (picked === undefined) throw new Error('fixture row missing')
    const expected = gateChoices(picked)
    assert.deepEqual(plan.options, expected)
  }
})

test('planPickerOutcome: gate-picked with mismatched kind → empty (no first-match steal)', () => {
  const plan = planPickerOutcome(true, colliding, {
    stage: 'gate-picked',
    gateRef: 'PMR-EEE',
    gateKind: 'plan-review',
  })
  assert.equal(plan.kind, 'empty')
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

// ---------------------------------------------------------------------------
// PMR-ZGPY 4.2 — planPickerOutcome: pure dispatch table for the zero-arg
// /flow picker. Selection stages mirror the two-step ctx.ui.select flow.
// ---------------------------------------------------------------------------

type Selection = Parameters<typeof planPickerOutcome>[2]

test('planPickerOutcome: no UI → fallback lines (regardless of selection)', () => {
  const plan = planPickerOutcome(false, gates)
  assert.equal(plan.kind, 'fallback')
  if (plan.kind === 'fallback') {
    assert.ok(plan.lines.length > 0)
    assert.deepEqual(plan.lines, buildGateFallbackLines(gates))
  }
  const cancelled = planPickerOutcome(false, gates, {
    stage: 'gate-cancelled',
  })
  assert.equal(cancelled.kind, 'fallback')
})

test('planPickerOutcome: hasUI + empty gates → empty', () => {
  const plan = planPickerOutcome(true, [])
  assert.equal(plan.kind, 'empty')
})

test('planPickerOutcome: hasUI + no selection → menu with gate options', () => {
  const plan = planPickerOutcome(true, gates)
  assert.equal(plan.kind, 'menu')
  if (plan.kind === 'menu') {
    assert.deepEqual(plan.options, buildGateMenuOptions(gates))
  }
})

test('planPickerOutcome: gate picked → choice-menu for that gate', () => {
  const plan = planPickerOutcome(true, gates, {
    stage: 'gate-picked',
    gateRef: 'PMR-CCC',
    gateKind: 'code-review',
  })
  assert.equal(plan.kind, 'choice-menu')
  if (plan.kind === 'choice-menu') {
    assert.equal(plan.gateRef, 'PMR-CCC')
    const gate = gates.find((g) => g.ref === 'PMR-CCC')
    assert.ok(gate, 'expected a PMR-CCC gate fixture')
    assert.deepEqual(plan.options, gateChoices(gate))
  }
})

test('planPickerOutcome: gate picked with unknown ref → empty', () => {
  const plan = planPickerOutcome(true, gates, {
    stage: 'gate-picked',
    gateRef: 'PMR-NOPE',
    gateKind: 'code-review',
  })
  assert.equal(plan.kind, 'empty')
})

test('planPickerOutcome: answered with a real choice → answer', () => {
  const plan = planPickerOutcome(true, gates, {
    stage: 'answered',
    gateRef: 'PMR-AAA',
    gateKind: 'plan-review',
    choice: 'approve',
  })
  assert.equal(plan.kind, 'answer')
  if (plan.kind === 'answer') {
    assert.equal(plan.ref, 'PMR-AAA')
    assert.equal(plan.choice, 'approve')
  }
})

test('planPickerOutcome: answered with escape value → print-command', () => {
  const plan = planPickerOutcome(true, gates, {
    stage: 'answered',
    gateRef: 'PMR-BBB',
    gateKind: 'flow-paused',
    choice: COMMAND_ESCAPE_VALUE,
  })
  assert.equal(plan.kind, 'print-command')
  if (plan.kind === 'print-command') {
    assert.equal(plan.ref, 'PMR-BBB')
    assert.ok(plan.choices.length >= 2)
  }
})

test('planPickerOutcome: second select cancelled → print-command', () => {
  const plan = planPickerOutcome(true, gates, {
    stage: 'choice-cancelled',
    gateRef: 'PMR-AAA',
    gateKind: 'plan-review',
  })
  assert.equal(plan.kind, 'print-command')
  if (plan.kind === 'print-command') {
    assert.equal(plan.ref, 'PMR-AAA')
    assert.deepEqual(plan.choices, ['approve', 'reject'])
  }
})

test('planPickerOutcome: answered/cancelled with unknown ref → empty', () => {
  assert.equal(
    planPickerOutcome(true, gates, {
      stage: 'answered',
      gateRef: 'PMR-NOPE',
      gateKind: 'plan-review',
      choice: 'approve',
    }).kind,
    'empty',
  )
  assert.equal(
    planPickerOutcome(true, gates, {
      stage: 'choice-cancelled',
      gateRef: 'PMR-NOPE',
      gateKind: 'plan-review',
    }).kind,
    'empty',
  )
})

test('planPickerOutcome: first select cancelled → empty (notify nothing)', () => {
  const plan: Selection = { stage: 'gate-cancelled' }
  assert.equal(planPickerOutcome(true, gates, plan).kind, 'empty')
})

// PMR-ZGPY fix round 2 — /flow dispatch: picker ONLY on zero args; every
// other arg shape keeps the parseFlowArgs usage notify.
test('isPickerInvocation: empty/whitespace args → true', () => {
  assert.equal(isPickerInvocation(''), true)
  assert.equal(isPickerInvocation('   '), true)
})

test('isPickerInvocation: one or more args → false', () => {
  assert.equal(isPickerInvocation('X'), false)
  assert.equal(isPickerInvocation('X Y'), false)
  assert.equal(isPickerInvocation('answer PMR-1 approve'), false)
})

test('grep-proof: picker module has no sendUserMessage / pickup / spawn', async () => {
  const src = await readFile(
    new URL('../flow/picker.ts', import.meta.url),
    'utf8',
  )
  assert.ok(!src.includes('sendUserMessage'))
  assert.ok(!/pickup/i.test(src))
  assert.ok(!/spawn/i.test(src))
})
