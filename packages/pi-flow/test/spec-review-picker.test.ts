import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SpecInReview } from '../spec-review/aven-spec.ts'
import { pickerOptions, pickSpecs } from '../spec-review/picker.ts'

const SPECS: SpecInReview[] = [
  { ref: 'PMR-AAAA', title: 'First spec' },
  { ref: 'PMR-BBBB', title: 'Second spec' },
]

test('pickerOptions: labels plus Done', () => {
  assert.deepEqual(pickerOptions(SPECS), [
    'PMR-AAAA First spec',
    'PMR-BBBB Second spec',
    'Done',
  ])
})

function selectByLabel(picks: Array<string | undefined>) {
  const seen: Array<string[]> = []
  let i = 0
  return {
    seen,
    select: async (_title: string, options: string[]) => {
      seen.push(options)
      const pick = picks[i]
      i += 1
      return pick
    },
  }
}

test('pickSpecs: Done immediately -> empty batch', async () => {
  const { select } = selectByLabel(['Done'])
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async () => {
      throw new Error('should not resolve')
    },
  })
  assert.deepEqual(outcome, { kind: 'done', picked: [] })
})

test('pickSpecs: no selection (undefined) behaves like Done', async () => {
  const { select } = selectByLabel([undefined])
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async () => {
      throw new Error('should not resolve')
    },
  })
  assert.deepEqual(outcome, { kind: 'done', picked: [] })
})

test('pickSpecs: pick one, then Done -> batch of one, spec removed from options', async () => {
  const { seen, select } = selectByLabel(['PMR-AAAA First spec', 'Done'])
  const opened: string[] = []
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async (ref) => ({
      ok: true,
      planPath: `/plans/${ref}.md`,
    }),
    onPicked: (spec) => {
      opened.push(spec.ref)
    },
  })
  assert.equal(outcome.kind, 'done')
  if (outcome.kind !== 'done') return
  assert.deepEqual(outcome.picked, [
    { ref: 'PMR-AAAA', title: 'First spec', planPath: '/plans/PMR-AAAA.md' },
  ])
  assert.deepEqual(opened, ['PMR-AAAA'])
  assert.deepEqual(seen[0], [
    'PMR-AAAA First spec',
    'PMR-BBBB Second spec',
    'Done',
  ])
  assert.deepEqual(seen[1], ['PMR-BBBB Second spec', 'Done'])
})

test('pickSpecs: missing plan path -> skipped with notice, loop continues', async () => {
  const { select } = selectByLabel([
    'PMR-AAAA First spec',
    'PMR-BBBB Second spec',
    'Done',
  ])
  const skipped: string[] = []
  const opened: string[] = []
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async (ref) =>
      ref === 'PMR-AAAA'
        ? { ok: false, reason: 'aven show PMR-AAAA failed: no plan-path' }
        : { ok: true, planPath: '/plans/PMR-BBBB.md' },
    onPicked: (spec) => {
      opened.push(spec.ref)
    },
    onSkipped: (_spec, reason) => {
      skipped.push(reason)
    },
  })
  assert.equal(outcome.kind, 'done')
  if (outcome.kind !== 'done') return
  assert.deepEqual(outcome.picked, [
    { ref: 'PMR-BBBB', title: 'Second spec', planPath: '/plans/PMR-BBBB.md' },
  ])
  assert.deepEqual(opened, ['PMR-BBBB'])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0], /no plan-path/)
})

test('pickSpecs: pick all until list is empty -> done without Done pick', async () => {
  const { seen, select } = selectByLabel([
    'PMR-AAAA First spec',
    'PMR-BBBB Second spec',
  ])
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async (ref) => ({
      ok: true,
      planPath: `/plans/${ref}.md`,
    }),
  })
  assert.equal(outcome.kind, 'done')
  if (outcome.kind !== 'done') return
  assert.equal(outcome.picked.length, 2)
  assert.equal(seen.length, 2)
})

test('pickSpecs: awaits async onPicked before next select call', async () => {
  const events: string[] = []
  let call = 0
  const select = async (_title: string, options: string[]) => {
    events.push(`select:${options.length}`)
    const pick = ['PMR-AAAA First spec', 'PMR-BBBB Second spec'][call]
    call += 1
    return pick
  }
  const outcome = await pickSpecs({
    specs: SPECS,
    select,
    resolvePlanPath: async (ref) => ({
      ok: true,
      planPath: `/plans/${ref}.md`,
    }),
    onPicked: async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(`picked:${spec.ref}`)
    },
  })
  assert.equal(outcome.kind, 'done')
  // AIDEV-NOTE: ordering proves the loop awaits each async onPicked — if it
  // were fire-and-forget, all select events would appear before any picked.
  assert.deepEqual(events, [
    'select:3',
    'picked:PMR-AAAA',
    'select:2',
    'picked:PMR-BBBB',
  ])
})
