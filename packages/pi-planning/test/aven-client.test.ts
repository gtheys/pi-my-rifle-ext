import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  avenAdd,
  avenDepAdd,
  avenEdit,
  avenEpicAdd,
  avenEpicList,
  avenExec,
  avenLabelCreate,
  avenShowFull,
  parseCreatedRef,
  parseShowFull,
} from '../shared/aven.ts'

interface Recorded {
  command: string
  args: string[]
  cwd?: string
}

function fakePi(
  scriptedResult: { code: number; stdout: string; stderr: string },
  recorded: Recorded[],
): ExtensionAPI {
  return {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      return scriptedResult
    },
  } as unknown as ExtensionAPI
}

test('parseCreatedRef: extracts ref from "created <ref>"', () => {
  assert.equal(parseCreatedRef('created PMR-AB12'), 'PMR-AB12')
})

test('parseCreatedRef: unrecognized output returns empty string', () => {
  assert.equal(parseCreatedRef('nothing useful here'), '')
})

test('avenExec: passes argv through and maps result', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: 'ok', stderr: '' }, recorded)
  const result = await avenExec(pi, ['list', '--ready'], '/cwd')
  assert.deepEqual(recorded, [
    { command: 'aven', args: ['list', '--ready'], cwd: '/cwd' },
  ])
  assert.deepEqual(result, { code: 0, stdout: 'ok', stderr: '' })
})

test('avenAdd: builds exact argv and returns parsed ref', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi(
    { code: 0, stdout: 'created PMR-AB12\n', stderr: '' },
    recorded,
  )
  const ref = await avenAdd(
    pi,
    {
      title: 'Add feature',
      epic: true,
      status: 'todo',
      metadata: { 'plan-state': 'draft' },
    },
    '/cwd',
  )
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: [
        'add',
        'Add feature',
        '--epic',
        '--status',
        'todo',
        '--metadata',
        'plan-state=draft',
      ],
      cwd: '/cwd',
    },
  ])
  assert.equal(ref, 'PMR-AB12')
})

test('avenAdd: builds argv with repeated --label and --description', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi(
    { code: 0, stdout: 'created PMR-AB12\n', stderr: '' },
    recorded,
  )
  await avenAdd(
    pi,
    {
      title: 'Add feature',
      labels: ['impl', 'urgent'],
      description: 'Some body text',
    },
    '/cwd',
  )
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: [
        'add',
        'Add feature',
        '--label',
        'impl',
        '--label',
        'urgent',
        '--description',
        'Some body text',
      ],
      cwd: '/cwd',
    },
  ])
})

test('avenAdd: non-zero exit throws with stderr detail', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 1, stdout: '', stderr: 'boom' }, recorded)
  await assert.rejects(() => avenAdd(pi, { title: 'x' }, '/cwd'), /boom/)
})

test('avenEdit: builds exact argv for status/metadata/epic', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: '', stderr: '' }, recorded)
  await avenEdit(
    pi,
    'PMR-AB12',
    { status: 'active', metadata: { owner: 'geert' }, epic: false },
    '/cwd',
  )
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: [
        'edit',
        'PMR-AB12',
        '--status',
        'active',
        '--metadata',
        'owner=geert',
        '--epic',
        'off',
      ],
      cwd: '/cwd',
    },
  ])
})

test('avenEpicList: passes --json and parses array', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi(
    { code: 0, stdout: '[{"ref":"PMR-1"},{"ref":"PMR-2"}]', stderr: '' },
    recorded,
  )
  const children = await avenEpicList(pi, 'PMR-EPIC', '/cwd')
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: ['epic', 'list', 'PMR-EPIC', '--json'],
      cwd: '/cwd',
    },
  ])
  assert.deepEqual(children, [{ ref: 'PMR-1' }, { ref: 'PMR-2' }])
})

test('avenEpicList: non-array JSON degrades to empty list', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: '{}', stderr: '' }, recorded)
  const children = await avenEpicList(pi, 'PMR-EPIC', '/cwd')
  assert.deepEqual(children, [])
})

test('avenDepAdd: builds exact argv', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: '', stderr: '' }, recorded)
  await avenDepAdd(pi, 'PMR-AB12', 'PMR-CD34', '/cwd')
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: ['dep', 'add', 'PMR-AB12', 'PMR-CD34'],
      cwd: '/cwd',
    },
  ])
})

test('avenLabelCreate: builds exact argv', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: '', stderr: '' }, recorded)
  await avenLabelCreate(pi, 'bug', '/cwd')
  assert.deepEqual(recorded, [
    { command: 'aven', args: ['label', 'create', 'bug'], cwd: '/cwd' },
  ])
})

test('avenLabelCreate: "already exists" on stderr is not an error', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi(
    { code: 1, stdout: '', stderr: 'Error: label already exists' },
    recorded,
  )
  await assert.doesNotReject(() => avenLabelCreate(pi, 'bug', '/cwd'))
})

test('avenLabelCreate: other errors still throw', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 1, stdout: '', stderr: 'boom' }, recorded)
  await assert.rejects(() => avenLabelCreate(pi, 'bug', '/cwd'), /boom/)
})

test('avenEpicAdd: builds exact argv', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 0, stdout: '', stderr: '' }, recorded)
  await avenEpicAdd(pi, 'PMR-AB12', 'PMR-FEAT1', '/cwd')
  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: ['epic', 'add', 'PMR-AB12', 'PMR-FEAT1'],
      cwd: '/cwd',
    },
  ])
})

test('avenEpicAdd: non-zero exit throws with stderr detail', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi({ code: 1, stdout: '', stderr: 'boom' }, recorded)
  await assert.rejects(
    () => avenEpicAdd(pi, 'PMR-AB12', 'PMR-FEAT1', '/cwd'),
    /boom/,
  )
})

test('avenShowFull: passes --full argv and parses stdout', async () => {
  const recorded: Recorded[] = []
  const pi = fakePi(
    { code: 0, stdout: 'PMR-AB12 status=active title="Feature"', stderr: '' },
    recorded,
  )
  const ticket = await avenShowFull(pi, 'PMR-AB12', '/cwd')
  assert.deepEqual(recorded, [
    { command: 'aven', args: ['show', 'PMR-AB12', '--full'], cwd: '/cwd' },
  ])
  assert.equal(ticket.ref, 'PMR-AB12')
  assert.equal(ticket.title, 'Feature')
})

const FULL_TICKET_FIXTURE = `PMR-HNW9 status=active priority=none labels=impl blocked_by=1 title="1.1 Client core + mutating commands"
id=HNW9R4CR0876JN52
project=pi-my-rifle-ext prefix=PMR
created=2026-09-26T17:03:30Z updated=2026-09-26T17:04:51Z
description<<EOF
Add shared/aven.ts with exec wrapper.
Second line of description.
EOF
metadata field_id=V15S8AFY44C20FSE key=plan-path
value<<EOF
/home/geert/.../plan.md
EOF
metadata field_id=V15S8AFY44C20FSF key=plan-state
value<<EOF
draft
EOF
note id=N1
body<<EOF
First note body.
EOF
depends_on open=1 total=1
- PMR-YNSQ status=active title="1. Phase: Aven client module"
blocks open=0 total=0
Related total=0
`

test('parseShowFull: fixture with 2 metadata keys, 1 note, multiline description', () => {
  const ticket = parseShowFull(FULL_TICKET_FIXTURE)
  assert.equal(ticket.ref, 'PMR-HNW9')
  assert.equal(ticket.status, 'active')
  assert.equal(ticket.title, '1.1 Client core + mutating commands')
  assert.equal(ticket.isEpic, false)
  assert.equal(
    ticket.description,
    'Add shared/aven.ts with exec wrapper.\nSecond line of description.',
  )
  assert.deepEqual(ticket.metadata, {
    'plan-path': '/home/geert/.../plan.md',
    'plan-state': 'draft',
  })
  assert.deepEqual(ticket.notes, ['First note body.'])
})

test('parseShowFull: empty ticket yields empty maps', () => {
  const ticket = parseShowFull('')
  assert.equal(ticket.ref, '')
  assert.deepEqual(ticket.metadata, {})
  assert.deepEqual(ticket.notes, [])
  assert.equal(ticket.description, '')
})

test('parseShowFull: unclosed heredoc parses to end of input without throwing', () => {
  const truncated = `PMR-ZZZZ status=todo title="Truncated"
description<<EOF
Line one
Line two`
  const ticket = parseShowFull(truncated)
  assert.equal(ticket.ref, 'PMR-ZZZZ')
  assert.equal(ticket.description, 'Line one\nLine two')
})

test('parseShowFull: epic=yes sets isEpic true', () => {
  const ticket = parseShowFull(
    'PMR-EPIC status=active epic=yes title="An epic"',
  )
  assert.equal(ticket.isEpic, true)
})
