import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPhasePrompt } from '../flow/phase-prompts.ts'

const BASE = {
  mode: 'personal' as const,
  ref: 'TP-1',
  skipResearch: false,
  gitRoot: '/home/x/pi-flow-range',
  workRoots: [] as string[],
  labels: [] as string[],
}

test('research: defaults to feature flow with the ref as topic', async () => {
  const result = await buildPhasePrompt('research', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Research phase/)
  assert.match(result.prompt, /personal/)
  assert.doesNotMatch(result.prompt, /Debug flow/)
})

test('research: explicit debug override routes the debug flow', async () => {
  const result = await buildPhasePrompt('research', {
    ...BASE,
    research: { kind: 'debug', text: 'cart total wrong' },
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Debug flow/)
  assert.match(result.prompt, /cart total wrong/)
})

test('plan: prompt carries the plan.md path from gitRoot', async () => {
  const result = await buildPhasePrompt('plan', BASE)
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /plan\.md/)
})

test('implement: refuses without the planned label', async () => {
  const result = await buildPhasePrompt('implement', BASE)
  assert.equal(result.kind, 'block')
})

test('implement: no researched label without skip -> skip-required block', async () => {
  const result = await buildPhasePrompt('implement', {
    ...BASE,
    labels: ['planned'],
  })
  assert.equal(result.kind, 'block')
  if (result.kind !== 'block') return
  assert.match(result.reason, /--skip-research/)
})

test('implement: planned + researched (or skip) -> send', async () => {
  for (const labels of [
    ['planned', 'researched'],
    ['planned', 'researched', 'bug'],
    ['planned'],
  ] as string[][]) {
    const result = await buildPhasePrompt('implement', {
      ...BASE,
      labels,
      skipResearch: true,
    })
    assert.equal(result.kind, 'send', JSON.stringify(labels))
  }
})

test('validate: personal mode sends without scripts dir', async () => {
  const result = await buildPhasePrompt('validate', BASE)
  assert.equal(result.kind, 'send')
})

test('validate: work mode without workRoots blocks loudly', async () => {
  const result = await buildPhasePrompt('validate', {
    ...BASE,
    mode: 'work',
    workRoots: [],
  })
  assert.equal(result.kind, 'block')
  if (result.kind !== 'block') return
  assert.match(result.reason, /workRoots/)
})

test('feedback: always sends', async () => {
  const result = await buildPhasePrompt('feedback', BASE)
  assert.equal(result.kind, 'send')
})
