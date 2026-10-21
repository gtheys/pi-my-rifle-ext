import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AvenRunner,
  findJiraEpic,
  resolveJiraEpic,
} from '../flow/jira-ref.ts'

type Call = readonly string[]

function runner(responses: Array<string | { stdout: string } | Error>): {
  aven: AvenRunner
  calls: Call[]
} {
  const calls: Call[] = []
  let i = 0
  const aven: AvenRunner = async (args) => {
    calls.push(args)
    const next = responses[i]
    i += 1
    if (next instanceof Error) throw next
    if (typeof next === 'string') return { stdout: next, stderr: '' }
    if (typeof next === 'object' && next !== null && 'stdout' in next) {
      return { stdout: next.stdout, stderr: '' }
    }
    throw new Error(`unexpected aven call #${i}: ${JSON.stringify(args)}`)
  }
  return { aven, calls }
}

const EPIC = JSON.stringify([
  { ref: 'PMR-EPIC1', title: 'DP-71 — thing', is_epic: true },
])
const SYNCED = JSON.stringify([
  { ref: 'DP-71A1', title: 'Fix the login flow', is_epic: false },
])

// --- findJiraEpic ---

test('findJiraEpic: single epic -> found', async () => {
  const { aven } = runner([EPIC])
  assert.deepEqual(await findJiraEpic('DP-71', aven), {
    kind: 'found',
    ref: 'PMR-EPIC1',
  })
})

test('findJiraEpic: empty list -> none', async () => {
  const { aven } = runner(['[]'])
  assert.deepEqual(await findJiraEpic('DP-71', aven), { kind: 'none' })
})

test('findJiraEpic: unknown-metadata-field -> none (field never registered)', async () => {
  const { aven } = runner([{ stdout: 'Error: error unknown-metadata-field\n' }])
  assert.deepEqual(await findJiraEpic('DP-71', aven), { kind: 'none' })
})

test('findJiraEpic: multiple epics -> error asking for explicit ref', async () => {
  const { aven } = runner([
    JSON.stringify([
      { ref: 'PMR-A', is_epic: true },
      { ref: 'PMR-B', is_epic: true },
    ]),
  ])
  const result = await findJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.reason, /PMR-A, PMR-B/)
})

test('findJiraEpic: spawn failure -> error', async () => {
  const { aven } = runner([new Error('aven: command not found')])
  const result = await findJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'error')
})

// --- resolveJiraEpic: existing epic ---

test('resolveJiraEpic: existing epic -> reuse, no aven add', async () => {
  const { aven, calls } = runner([EPIC])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.deepEqual(result, { kind: 'epic', ref: 'PMR-EPIC1', created: false })
  assert.equal(calls.length, 1)
})

// --- resolveJiraEpic: cold start pull-in ---

test('resolveJiraEpic: cold start -> synced found, epic created, dep-linked', async () => {
  const { aven, calls } = runner([
    '[]', // no epic yet
    SYNCED, // synced ticket
    'Task created PMR-NEW1\n', // aven add output
    '', // dep add
  ])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.deepEqual(result, { kind: 'epic', ref: 'PMR-NEW1', created: true })
  // list jira-ref, list jira-key, add (with metadata + epic), dep add
  assert.deepEqual(calls[0], ['list', '--metadata', 'jira-ref=DP-71', '--json'])
  assert.deepEqual(calls[1], ['list', '--metadata', 'jira-key=DP-71', '--json'])
  const add = calls[2] as string[]
  assert.equal(add[0], 'add')
  assert.equal(add[1], 'DP-71 — Fix the login flow')
  assert.ok(add.includes('--epic'))
  assert.ok(add.includes('jira-ref=DP-71'))
  assert.deepEqual(calls[3], ['dep', 'add', 'PMR-NEW1', 'DP-71A1'])
})

test('resolveJiraEpic: not aven-managed -> abort', async () => {
  const { aven, calls } = runner(['[]', '[]'])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'abort')
  if (result.kind !== 'abort') return
  assert.match(result.reason, /not aven-managed/)
  assert.equal(calls.length, 2)
})

test('resolveJiraEpic: aven add without ref in output -> abort', async () => {
  const { aven } = runner(['[]', SYNCED, 'something went wrong'])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'abort')
})

test('resolveJiraEpic: dep add failure -> abort with re-run hint', async () => {
  const { aven } = runner([
    '[]',
    SYNCED,
    'Task created PMR-NEW1',
    new Error('dep failed'),
  ])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'abort')
  if (result.kind !== 'abort') return
  assert.match(result.reason, /PMR-NEW1/)
  assert.match(result.reason, /re-run/)
})

test('resolveJiraEpic: multiple epics error passes through as abort', async () => {
  const { aven } = runner([
    JSON.stringify([
      { ref: 'PMR-A', is_epic: true },
      { ref: 'PMR-B', is_epic: true },
    ]),
  ])
  const result = await resolveJiraEpic('DP-71', aven)
  assert.equal(result.kind, 'abort')
  assert.match(
    result.kind === 'abort' ? result.reason : '',
    /multiple local epics/,
  )
})
