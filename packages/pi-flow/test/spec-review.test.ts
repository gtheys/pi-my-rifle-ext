import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AvenRunner } from '../flow/jira-ref.ts'
import { approveSpec } from '../spec-review/approve.ts'
import { listSpecsInReview, readPlanPath } from '../spec-review/aven-spec.ts'

type Call = readonly string[]

function runner(
  responses: Array<string | { stdout: string; stderr?: string } | Error>,
): { aven: AvenRunner; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const aven: AvenRunner = async (args) => {
    calls.push(args)
    const next = responses[i]
    i += 1
    if (next instanceof Error) throw next
    if (typeof next === 'string') return { stdout: next, stderr: '' }
    if (typeof next === 'object' && next !== null && 'stdout' in next) {
      return { stdout: next.stdout, stderr: next.stderr ?? '' }
    }
    throw new Error(`unexpected aven call #${i}: ${JSON.stringify(args)}`)
  }
  return { aven, calls }
}

const REVIEW_LIST = JSON.stringify([
  {
    ref: 'PMR-YWY0',
    id: 'YWY0A1B2C3D4E5F6',
    title: 'Spec-review foundation',
    project: 'pi-my-rifle-ext',
    status: 'review',
    priority: 'none',
    labels: ['plan'],
    deleted: false,
    is_epic: false,
    epic_parent: null,
    epic_children: [],
    has_conflict: false,
    blocked_by: [],
    blocks: [],
    available_at: null,
    due_on: null,
    recurrence: null,
    recurrence_group: null,
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:00Z',
  },
])

// --- listSpecsInReview ---

test('listSpecsInReview: ok with entries', async () => {
  const { aven, calls } = runner([REVIEW_LIST])
  const result = await listSpecsInReview(aven, {
    project: 'pi-my-rifle-ext',
  })
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.specs.length, 1)
  assert.deepEqual(result.specs[0], {
    ref: 'PMR-YWY0',
    title: 'Spec-review foundation',
  })
  assert.deepEqual(calls[0], [
    'list',
    '--project',
    'pi-my-rifle-ext',
    '--metadata',
    'plan-state=review',
    '--open',
    '--json',
  ])
})

test('listSpecsInReview: empty list -> ok empty', async () => {
  const { aven } = runner(['[]'])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.deepEqual(result, { kind: 'ok', specs: [] })
})

test('listSpecsInReview: exit-0 error text -> error, not empty list', async () => {
  const { aven } = runner([
    { stdout: 'Error: error unknown-ref: no such project "p"\n' },
  ])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.reason, /unknown-ref/)
})

test('listSpecsInReview: malformed JSON -> error', async () => {
  const { aven } = runner([{ stdout: 'not json at all' }])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.equal(result.kind, 'error')
})

test('listSpecsInReview: JSON non-array -> error', async () => {
  const { aven } = runner([{ stdout: '{"ref": "PMR-X"}' }])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.equal(result.kind, 'error')
})

test('listSpecsInReview: workspace flag passed when provided', async () => {
  const { aven, calls } = runner(['[]'])
  await listSpecsInReview(aven, { project: 'p', workspace: 'personal' })
  assert.deepEqual(calls[0], [
    'list',
    '--project',
    'p',
    '--metadata',
    'plan-state=review',
    '--open',
    '--json',
    '--workspace',
    'personal',
  ])
})

test('listSpecsInReview: entries without string ref are skipped', async () => {
  const { aven } = runner([JSON.stringify([{ ref: 42 }, { ref: 'PMR-OK' }])])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.equal(result.specs.length, 1)
  assert.equal(result.specs[0]?.ref, 'PMR-OK')
})

test('listSpecsInReview: spawn failure -> error', async () => {
  const { aven } = runner([new Error('aven: command not found')])
  const result = await listSpecsInReview(aven, { project: 'p' })
  assert.equal(result.kind, 'error')
})

// --- readPlanPath ---

const SHOW_FULL = [
  'PMR-YWY0 Spec-review foundation [review]',
  '',
  'Description:',
  'The plan lives at plan-path, see the docs.',
  '',
  'metadata field_id=3T3NPP5RERQC3E0S key=plan-path',
  'value<<EOF',
  '/home/geert/Code/notes/personal-specs/pi-my-rifle-ext/2026-10-21-pmr-mr36/plan.md',
  'EOF',
  'metadata field_id=8TFEPP335NYAN3A0 key=plan-state',
  'value<<EOF',
  'review',
  'EOF',
].join('\n')

test('readPlanPath: found', async () => {
  const { aven, calls } = runner([{ stdout: SHOW_FULL }])
  const result = await readPlanPath(aven, 'PMR-YWY0')
  assert.deepEqual(result, {
    kind: 'found',
    planPath:
      '/home/geert/Code/notes/personal-specs/pi-my-rifle-ext/2026-10-21-pmr-mr36/plan.md',
    planState: 'review',
  })
  assert.deepEqual(calls[0], ['show', 'PMR-YWY0', '--full'])
})

test('readPlanPath: missing plan-path -> none', async () => {
  const { aven } = runner([
    {
      stdout:
        'PMR-YWY0 title\n\nmetadata field_id=8TFE key=plan-state\nvalue<<EOF\nreview\nEOF\n',
    },
  ])
  const result = await readPlanPath(aven, 'PMR-YWY0')
  assert.equal(result.kind, 'none')
})

test('readPlanPath: multiline value', async () => {
  const { aven } = runner([
    {
      stdout:
        'metadata field_id=AAA key=plan-path\nvalue<<EOF\nline one\nline two\nEOF\n',
    },
  ])
  const result = await readPlanPath(aven, 'PMR-X')
  assert.deepEqual(result, {
    kind: 'found',
    planPath: 'line one\nline two',
    planState: null,
  })
})

test('readPlanPath: "plan-path" mention in description is not trusted', async () => {
  const { aven } = runner([
    {
      stdout:
        'Description:\nuse plan-path key here\nmetadata field_id=8TFE key=plan-state\nvalue<<EOF\nreview\nEOF\n',
    },
  ])
  const result = await readPlanPath(aven, 'PMR-X')
  assert.equal(result.kind, 'none')
})

test('readPlanPath: exit-0 error -> error', async () => {
  const { aven } = runner([{ stdout: 'Error: error unknown-ref: xyz\n' }])
  const result = await readPlanPath(aven, 'PMR-NOPE')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.reason, /unknown-ref/)
})

test('readPlanPath: threads workspace into aven show args', async () => {
  const { aven, calls } = runner([{ stdout: SHOW_FULL }])
  const result = await readPlanPath(aven, 'PMR-YWY0', { workspace: 'ws2' })
  assert.equal(result.kind, 'found')
  assert.deepEqual(calls[0], [
    'show',
    'PMR-YWY0',
    '--full',
    '--workspace',
    'ws2',
  ])
})

test('readPlanPath: spawn failure -> error', async () => {
  const { aven } = runner([new Error('boom')])
  const result = await readPlanPath(aven, 'PMR-X')
  assert.equal(result.kind, 'error')
})

// --- approveSpec ---

test('approveSpec: success', async () => {
  const { aven, calls } = runner([{ stdout: 'updated PMR-YWY0\n' }])
  const result = await approveSpec(aven, 'PMR-YWY0')
  assert.deepEqual(result, { kind: 'ok', ref: 'PMR-YWY0' })
  assert.deepEqual(calls[0], [
    'edit',
    'PMR-YWY0',
    '--metadata',
    'plan-state=approved',
    '--label',
    'plan',
    '--status',
    'todo',
  ])
})

test('approveSpec: workspace pinned when provided', async () => {
  const { aven, calls } = runner([{ stdout: 'updated PMR-YWY0\n' }])
  const result = await approveSpec(aven, 'PMR-YWY0', { workspace: 'personal' })
  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.ok(calls[0]?.includes('--workspace'))
  assert.ok(calls[0]?.includes('personal'))
})

test('approveSpec: no workspace -> no workspace flag', async () => {
  const { aven, calls } = runner([{ stdout: 'updated PMR-YWY0\n' }])
  await approveSpec(aven, 'PMR-YWY0')
  assert.ok(!calls[0]?.includes('--workspace'))
})

test('approveSpec: failure is loud with raw output', async () => {
  const { aven } = runner([
    { stdout: 'Error: error unknown-ref: no task xyz\n' },
  ])
  const result = await approveSpec(aven, 'PMR-NOPE')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.reason, /unknown-ref/)
})

test('approveSpec: missing updated line -> error', async () => {
  const { aven } = runner([{ stdout: 'something unexpected' }])
  const result = await approveSpec(aven, 'PMR-X')
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.reason, /did not report success/)
})

test('approveSpec: spawn failure -> error', async () => {
  const { aven } = runner([new Error('edit blew up')])
  const result = await approveSpec(aven, 'PMR-X')
  assert.equal(result.kind, 'error')
})
