import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { advancePlanState } from '../aven-tools/advance-plan-state.ts'
import { createFeatureTree } from '../aven-tools/create-feature-tree.ts'
import { findOrCreateEpic } from '../aven-tools/find-or-create-epic.ts'

interface Recorded {
  command: string
  args: string[]
  cwd?: string
}

interface Scripted {
  code: number
  stdout: string
  stderr: string
}

/** Fake ExtensionAPI that returns scripted results keyed by argv[0]+argv[1]. */
function fakePi(
  scripts: Map<string, Scripted>,
  recorded: Recorded[],
): ExtensionAPI {
  return {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      const key = `${args[0]} ${args[1]}`
      const scripted = scripts.get(key)
      if (scripted === undefined) {
        throw new Error(`unscripted aven command: ${args.join(' ')}`)
      }
      return scripted
    },
  } as unknown as ExtensionAPI
}

test('find_or_create_epic: ref pass-through returns existing local epic unchanged', async () => {
  const recorded: Recorded[] = []
  const scripts = new Map<string, Scripted>([
    ['show PMR-AB12', { code: 0, stdout: '{"ref":"PMR-AB12"}', stderr: '' }],
  ])
  const pi = fakePi(scripts, recorded)

  const result = await findOrCreateEpic(pi, 'PMR-AB12', '/cwd')

  assert.deepEqual(result, {
    epicRef: 'PMR-AB12',
    syncedRef: '',
    created: false,
  })
  assert.deepEqual(recorded, [
    { command: 'aven', args: ['show', 'PMR-AB12', '--json'], cwd: '/cwd' },
  ])
})

test('find_or_create_epic: Jira key with no existing epic creates one and links dep', async () => {
  const recorded: Recorded[] = []
  // AIDEV-NOTE: two `list --metadata` calls happen (jira-ref then jira-key);
  // script by call order instead of key collision.
  const listResults = [
    '[]',
    '[{"ref":"PMR-SYNC1","title":"Do the thing","is_epic":false}]',
  ]
  let listCallCount = 0
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      if (args[0] === 'show') {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
      if (args[0] === 'list') {
        const stdout = listResults[listCallCount] ?? '[]'
        listCallCount += 1
        return { code: 0, stdout, stderr: '' }
      }
      if (args[0] === 'add') {
        return { code: 0, stdout: 'created PMR-NEW1\n', stderr: '' }
      }
      if (args[0] === 'dep') {
        return { code: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unscripted aven command: ${args.join(' ')}`)
    },
  } as unknown as ExtensionAPI

  const result = await findOrCreateEpic(pi, 'DP-71', '/cwd')

  assert.deepEqual(result, {
    epicRef: 'PMR-NEW1',
    syncedRef: 'PMR-SYNC1',
    created: true,
  })
  const addCall = recorded.find((r) => r.args[0] === 'add')
  assert.deepEqual(addCall?.args, [
    'add',
    'DP-71 \u2014 Do the thing',
    '--epic',
    '--metadata',
    'jira-ref=DP-71',
  ])
  const depCall = recorded.find((r) => r.args[0] === 'dep')
  assert.deepEqual(depCall?.args, ['dep', 'add', 'PMR-NEW1', 'PMR-SYNC1'])
})

test('find_or_create_epic: second run for same Jira key is idempotent (returns existing epic)', async () => {
  const recorded: Recorded[] = []
  let listCallCount = 0
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      if (args[0] === 'show') {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
      if (args[0] === 'list') {
        listCallCount += 1
        // First call: --metadata jira-ref=DP-71 finds the epic created on run 1.
        return {
          code: 0,
          stdout: '[{"ref":"PMR-NEW1","title":"DP-71","is_epic":true}]',
          stderr: '',
        }
      }
      throw new Error(`unscripted aven command: ${args.join(' ')}`)
    },
  } as unknown as ExtensionAPI

  const result = await findOrCreateEpic(pi, 'DP-71', '/cwd')

  assert.deepEqual(result, {
    epicRef: 'PMR-NEW1',
    syncedRef: '',
    created: false,
  })
  assert.equal(listCallCount, 1)
  assert.equal(
    recorded.filter((r) => r.args[0] === 'add').length,
    0,
    'must not create a second epic',
  )
})

test('find_or_create_epic: input is neither a known ref nor a Jira key throws', async () => {
  const pi: ExtensionAPI = {
    exec: async (_command: string, args: string[]) => {
      if (args[0] === 'show') {
        return { code: 1, stdout: '', stderr: 'not found' }
      }
      throw new Error(`unscripted aven command: ${args.join(' ')}`)
    },
  } as unknown as ExtensionAPI

  await assert.rejects(
    () => findOrCreateEpic(pi, 'not-a-ref', '/cwd'),
    /not a known ticket ref or Jira key/,
  )
})

test('advance_plan_state: sets plan-state and plan-path metadata via avenEdit', async () => {
  const recorded: Recorded[] = []
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      return { code: 0, stdout: '', stderr: '' }
    },
  } as unknown as ExtensionAPI

  await advancePlanState(pi, 'PMR-FEAT1', 'approved', '/plan.md', '/cwd')

  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: [
        'edit',
        'PMR-FEAT1',
        '--metadata',
        'plan-state=approved',
        '--metadata',
        'plan-path=/plan.md',
      ],
      cwd: '/cwd',
    },
  ])
})

test('advance_plan_state: without plan_path only sets plan-state', async () => {
  const recorded: Recorded[] = []
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      return { code: 0, stdout: '', stderr: '' }
    },
  } as unknown as ExtensionAPI

  await advancePlanState(pi, 'PMR-FEAT1', 'review', undefined, '/cwd')

  assert.deepEqual(recorded, [
    {
      command: 'aven',
      args: ['edit', 'PMR-FEAT1', '--metadata', 'plan-state=review'],
      cwd: '/cwd',
    },
  ])
})

test('create_feature_tree: gate rejects non-approved plan-state with zero aven writes', async () => {
  const recorded: Recorded[] = []
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      if (args[0] === 'show') {
        return {
          code: 0,
          stdout:
            'PMR-FEAT1 status=active title="Feature"\nmetadata field_id=F1 key=plan-state\nvalue<<EOF\nreview\nEOF\n',
          stderr: '',
        }
      }
      throw new Error(`unscripted aven command: ${args.join(' ')}`)
    },
  } as unknown as ExtensionAPI

  const result = await createFeatureTree(
    pi,
    'PMR-FEAT1',
    '/plan.md',
    [{ title: 'Phase one', summary: 'x', subtasks: [] }],
    '/cwd',
  )

  assert.equal(
    result.error,
    'create_feature_tree: PMR-FEAT1 plan-state is "review", must be "approved"',
  )
  assert.deepEqual(result.phases, [])
  assert.equal(
    recorded.filter((r) => r.args[0] === 'add').length,
    0,
    'must not create any tickets before the gate passes',
  )
})

test('create_feature_tree: happy path builds phase/subtask tree with argv order', async () => {
  const recorded: Recorded[] = []
  let addCallCount = 0
  const pi: ExtensionAPI = {
    exec: async (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => {
      recorded.push({ command, args, cwd: options?.cwd })
      if (args[0] === 'show') {
        return {
          code: 0,
          stdout:
            'PMR-FEAT1 status=active title="Feature"\nmetadata field_id=F1 key=plan-state\nvalue<<EOF\napproved\nEOF\n',
          stderr: '',
        }
      }
      if (args[0] === 'label') {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'add') {
        addCallCount += 1
        return { code: 0, stdout: `created PMR-N${addCallCount}\n`, stderr: '' }
      }
      if (args[0] === 'epic' || args[0] === 'dep') {
        return { code: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unscripted aven command: ${args.join(' ')}`)
    },
  } as unknown as ExtensionAPI

  const result = await createFeatureTree(
    pi,
    'PMR-FEAT1',
    '/plan.md',
    [
      {
        title: 'Aven client module',
        summary: 'Phase one summary',
        subtasks: [
          { title: 'Client core', body: 'body one' },
          { title: 'Mutating commands', body: 'body two' },
        ],
      },
      {
        title: 'Tool registration',
        summary: 'Phase two summary',
        subtasks: [{ title: 'Register tools', body: 'body three' }],
      },
    ],
    '/cwd',
  )

  const addCalls = recorded.filter((r) => r.args[0] === 'add')
  assert.deepEqual(
    addCalls.map((r) => r.args),
    [
      [
        'add',
        '1. Aven client module',
        '--label',
        'phase',
        '--label',
        'impl',
        '--description',
        'Phase one summary',
        '--metadata',
        'plan-path=/plan.md',
      ],
      [
        'add',
        '1.1 Client core',
        '--label',
        'impl',
        '--description',
        'body one',
        '--metadata',
        'plan-path=/plan.md',
      ],
      [
        'add',
        '1.2 Mutating commands',
        '--label',
        'impl',
        '--description',
        'body two',
        '--metadata',
        'plan-path=/plan.md',
      ],
      [
        'add',
        '2. Tool registration',
        '--label',
        'phase',
        '--label',
        'impl',
        '--description',
        'Phase two summary',
        '--metadata',
        'plan-path=/plan.md',
      ],
      [
        'add',
        '2.1 Register tools',
        '--label',
        'impl',
        '--description',
        'body three',
        '--metadata',
        'plan-path=/plan.md',
      ],
    ],
  )

  const epicCalls = recorded.filter((r) => r.args[0] === 'epic')
  assert.deepEqual(
    epicCalls.map((r) => r.args),
    [
      ['epic', 'add', 'PMR-N1', 'PMR-FEAT1'],
      ['epic', 'add', 'PMR-N2', 'PMR-FEAT1'],
      ['epic', 'add', 'PMR-N3', 'PMR-FEAT1'],
      ['epic', 'add', 'PMR-N4', 'PMR-FEAT1'],
      ['epic', 'add', 'PMR-N5', 'PMR-FEAT1'],
    ],
  )

  const depCalls = recorded.filter((r) => r.args[0] === 'dep')
  assert.deepEqual(
    depCalls.map((r) => r.args),
    [['dep', 'add', 'PMR-N4', 'PMR-N1']],
  )

  assert.deepEqual(result, {
    phases: [
      {
        ref: 'PMR-N1',
        title: 'Aven client module',
        subtasks: [
          { ref: 'PMR-N2', title: 'Client core' },
          { ref: 'PMR-N3', title: 'Mutating commands' },
        ],
      },
      {
        ref: 'PMR-N4',
        title: 'Tool registration',
        subtasks: [{ ref: 'PMR-N5', title: 'Register tools' }],
      },
    ],
  })
})
