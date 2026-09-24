import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBranchInput, personalBranch, slugify } from '../branch.ts'

// --- parseBranchInput: modes ---

test('parseBranchInput: jira mode', () => {
  assert.deepEqual(parseBranchInput({ jira_id: 'IMP-7070' }), {
    kind: 'jira',
    jiraId: 'IMP-7070',
  })
})

test('parseBranchInput: personal mode with type', () => {
  assert.deepEqual(parseBranchInput({ name: 'Add Save Button', type: 'fix' }), {
    kind: 'personal',
    name: 'Add Save Button',
    type: 'fix',
  })
})

test('parseBranchInput: personal mode defaults type to feat', () => {
  assert.deepEqual(parseBranchInput({ name: 'Add Save Button' }), {
    kind: 'personal',
    name: 'Add Save Button',
    type: 'feat',
  })
})

test('parseBranchInput: literal mode', () => {
  assert.deepEqual(parseBranchInput({ branch: 'release/1.2.3' }), {
    kind: 'literal',
    branch: 'release/1.2.3',
  })
})

// --- parseBranchInput: errors ---

test('parseBranchInput: empty input errors', () => {
  assert.throws(() => parseBranchInput({}), /Missing branch input/)
})

test('parseBranchInput: jira_id + name is ambiguous', () => {
  assert.throws(
    () => parseBranchInput({ jira_id: 'IMP-1', name: 'thing' }),
    /Ambiguous branch input/,
  )
})

test('parseBranchInput: name + branch is ambiguous', () => {
  assert.throws(
    () => parseBranchInput({ name: 'thing', branch: 'x/y' }),
    /Ambiguous branch input/,
  )
})

test('parseBranchInput: all three modes is ambiguous', () => {
  assert.throws(
    () => parseBranchInput({ jira_id: 'IMP-1', name: 'n', branch: 'b' }),
    /Ambiguous branch input/,
  )
})

test('parseBranchInput: invalid type errors and lists valid values', () => {
  assert.throws(
    () => parseBranchInput({ name: 'thing', type: 'bugfix' }),
    /Invalid type 'bugfix'.*(feat, fix, chore, docs, refactor)/,
  )
})

// --- slugify: known-good literals ---

test('slugify: punctuation stripped', () => {
  assert.equal(slugify('Add Save Button & Export!'), 'add-save-button-export')
})

test('slugify: long names truncated to first 5 words', () => {
  assert.equal(
    slugify('one two three four five six seven'),
    'one-two-three-four-five',
  )
})

test('slugify: edge hyphens trimmed', () => {
  assert.equal(slugify('  -- Hello World --  '), 'hello-world')
})

test('slugify: empty after strip', () => {
  assert.equal(slugify('!!!***'), '')
})

test('slugify: numbers and case preserved as lowercase', () => {
  assert.equal(slugify('Fix CVE-2024-1234 NOW'), 'fix-cve-2024-1234-now')
})

// --- personalBranch ---

test('personalBranch: composes type/slug', () => {
  assert.equal(
    personalBranch('Add Save Button & Export!', 'feat'),
    'feat/add-save-button-export',
  )
})

test('personalBranch: each personal type', () => {
  assert.equal(personalBranch('docs', 'docs'), 'docs/docs')
  assert.equal(
    personalBranch('refactor core', 'refactor'),
    'refactor/refactor-core',
  )
})

// --- herdr.ts parsing helpers ---

// AIDEV-NOTE: fixtures mirror `herdr worktree list` / `herdr agent list`
// output captured live from herdr 0.8.2 — do not "fix" field names.
import {
  filterLinked,
  parseCreateResult,
  parseJson,
  parseWorktrees,
  pickString,
} from '../herdr.ts'

test('parseJson: valid JSON parses, non-JSON returns null', () => {
  assert.equal(parseJson('{"a":1}') !== null, true)
  assert.equal(parseJson('not json at all'), null)
})

test('pickString: herdr 0.8.2 worktree entry field names', () => {
  const entry = JSON.parse(
    '{"branch":"main","is_bare":false,"label":"sh-projects","open_workspace_id":"w1N","path":"/home/geert/Code/notes/sh-projects"}',
  )
  assert.equal(
    pickString(entry, ['path', 'worktree_path']),
    '/home/geert/Code/notes/sh-projects',
  )
  assert.equal(pickString(entry, ['branch', 'head']), 'main')
  assert.equal(pickString(entry, ['label', 'name']), 'sh-projects')
  assert.equal(
    pickString(entry, ['open_workspace_id', 'workspace_id', 'id']),
    'w1N',
  )
})

test('pickString: herdr 0.8.2 agent entry field names', () => {
  const entry = JSON.parse(
    '{"agent":"pi","agent_status":"working","pane_id":"w23:pX","workspace_id":"w23","cwd":"/repo"}',
  )
  assert.equal(pickString(entry, ['agent', 'name']), 'pi')
  assert.equal(
    pickString(entry, ['agent_status', 'state', 'status']),
    'working',
  )
  assert.equal(pickString(entry, ['pane_id', 'pane']), 'w23:pX')
  assert.equal(pickString(entry, ['workspace_id', 'workspace.id']), 'w23')
})

test('pickString: variant names and nested lookup', () => {
  const variants = JSON.parse(
    '{"worktree_path":"/wt","name":"alt-label","workspace":{"id":"w9"}}',
  )
  assert.equal(pickString(variants, ['path', 'worktree_path']), '/wt')
  assert.equal(pickString(variants, ['label', 'name']), 'alt-label')
  assert.equal(pickString(variants, ['workspace_id', 'workspace.id']), 'w9')
})

test('pickString: missing everywhere returns empty string', () => {
  assert.equal(pickString({}, ['path', 'worktree_path']), '')
  assert.equal(pickString(null, ['path']), '')
  assert.equal(pickString('str', ['path']), '')
})

test('parseWorktrees + filterLinked: main checkout filtered, linked kept', () => {
  // AIDEV-NOTE: fixture mirrors live herdr 0.8.2 list payload — main
  // checkout carries is_linked_worktree:false and must not be listed.
  const payload = JSON.parse(
    `{"result":{"worktrees":[
      {"branch":"main","is_bare":false,"is_linked_worktree":false,"label":"sh-projects","open_workspace_id":"w1N","path":"/repo"},
      {"branch":"feature/x","is_bare":false,"is_linked_worktree":true,"label":"fx","open_workspace_id":"w2A","path":"/repo/.wt/fx"}
    ]}}`,
  )
  const worktrees = parseWorktrees(payload)
  assert.equal(worktrees.length, 2)
  assert.equal(worktrees[0].isLinked, false)
  assert.equal(worktrees[1].isLinked, true)
  const linked = filterLinked(worktrees)
  assert.equal(linked.length, 1)
  assert.equal(linked[0].branch, 'feature/x')
})

test('parseWorktrees: absent is_linked_worktree defaults to linked', () => {
  const payload = JSON.parse(
    '{"result":{"worktrees":[{"branch":"main","path":"/repo","label":"l"}]}}',
  )
  const worktrees = parseWorktrees(payload)
  assert.equal(worktrees[0].isLinked, true)
  assert.equal(filterLinked(worktrees).length, 1)
})

// --- bootstrap.ts: detectBootstrapPlan ---

import { detectBootstrapPlan, selectEnvFiles } from '../bootstrap.ts'

test('detectBootstrapPlan: bun.lock', () => {
  assert.deepEqual(detectBootstrapPlan(['bun.lock', 'package.json']), {
    steps: [
      {
        label: 'bun install',
        command: 'GH_TOKEN="$(gh auth token)" bun install',
        shell: true,
      },
    ],
  })
})

test('detectBootstrapPlan: bun.lockb variant', () => {
  assert.deepEqual(detectBootstrapPlan(['bun.lockb']), {
    steps: [
      {
        label: 'bun install',
        command: 'GH_TOKEN="$(gh auth token)" bun install',
        shell: true,
      },
    ],
  })
})

test('detectBootstrapPlan: yarn uses shell command with GH_TOKEN', () => {
  const plan = detectBootstrapPlan(['yarn.lock', 'package.json'])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].shell, true)
  assert.ok(plan.steps[0].command.includes('GH_TOKEN'))
  assert.ok(plan.steps[0].command.includes('gh auth token'))
  assert.ok(plan.steps[0].command.includes('yarn install'))
})

test('detectBootstrapPlan: package-lock.json → npm ci', () => {
  assert.deepEqual(detectBootstrapPlan(['package-lock.json']), {
    steps: [
      {
        label: 'npm ci',
        command: 'GH_TOKEN="$(gh auth token)" npm ci',
        shell: true,
      },
    ],
  })
})

test('detectBootstrapPlan: pnpm-lock.yaml', () => {
  assert.deepEqual(detectBootstrapPlan(['pnpm-lock.yaml']), {
    steps: [
      {
        label: 'pnpm install',
        command: 'GH_TOKEN="$(gh auth token)" pnpm install --frozen-lockfile',
        shell: true,
      },
    ],
  })
})

test('detectBootstrapPlan: Cargo.toml', () => {
  assert.deepEqual(detectBootstrapPlan(['Cargo.toml', 'src/main.rs']), {
    steps: [{ label: 'cargo fetch', command: 'cargo fetch', shell: false }],
  })
})

test('detectBootstrapPlan: go.mod → note only', () => {
  assert.deepEqual(detectBootstrapPlan(['go.mod', 'main.go']), {
    steps: [],
    note: 'go: global module cache, nothing to install',
  })
})

test('detectBootstrapPlan: none → note only', () => {
  assert.deepEqual(detectBootstrapPlan(['README.md', 'index.html']), {
    steps: [],
    note: 'no recognized lockfile — nothing to bootstrap',
  })
})

test('detectBootstrapPlan: monorepo yarn.lock + Cargo.toml → 2 steps', () => {
  const plan = detectBootstrapPlan(['yarn.lock', 'Cargo.toml'])
  assert.equal(plan.steps.length, 2)
  assert.equal(plan.steps[0].label, 'yarn install')
  assert.equal(plan.steps[1].label, 'cargo fetch')
})

test('detectBootstrapPlan: bun + go.mod → install step + go note', () => {
  const plan = detectBootstrapPlan(['bun.lock', 'go.mod'])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].label, 'bun install')
  assert.ok((plan.note ?? '').includes('go:'))
})

test('detectBootstrapPlan: multiple JS lockfiles — first in priority wins, ambiguity noted', () => {
  const plan = detectBootstrapPlan(['yarn.lock', 'pnpm-lock.yaml'])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].label, 'yarn install')
  assert.ok((plan.note ?? '').includes('multiple JS lockfiles'))
})

// --- bootstrap.ts: selectEnvFiles ---

test('selectEnvFiles: .env in both → excluded (never overwritten)', () => {
  assert.deepEqual(selectEnvFiles(['.env', '.env.local'], ['.env']), [
    '.env.local',
  ])
})

test('selectEnvFiles: source-only .env.local → included', () => {
  assert.deepEqual(selectEnvFiles(['.env.local'], []), ['.env.local'])
})

test('selectEnvFiles: non-.env files ignored (.environment excluded)', () => {
  assert.deepEqual(
    selectEnvFiles(['.env', '.environment', 'README.md'], ['README.md']),
    ['.env'],
  )
})

test('selectEnvFiles: empty dirs', () => {
  assert.deepEqual(selectEnvFiles([], ['.env']), [])
  assert.deepEqual(selectEnvFiles([], []), [])
})

// --- decideBranchDelete: basics (full matrix in subtask 3.3) ---

import { decideBranchDelete } from '../remove-guards.ts'

test('decideBranchDelete: not requested skips', () => {
  assert.deepEqual(
    decideBranchDelete({
      deleteBranchRequested: false,
      prState: 'MERGED',
      force: false,
    }),
    { action: 'skip', reason: 'delete_branch not requested' },
  )
})

test('decideBranchDelete: MERGED deletes without force', () => {
  assert.deepEqual(
    decideBranchDelete({
      deleteBranchRequested: true,
      prState: 'MERGED',
      force: false,
    }),
    { action: 'delete' },
  )
})

test('decideBranchDelete: OPEN refuses without force', () => {
  assert.deepEqual(
    decideBranchDelete({
      deleteBranchRequested: true,
      prState: 'OPEN',
      force: false,
    }),
    {
      action: 'refuse',
      reason: 'PR for branch is OPEN — refusing to delete an unmerged branch',
    },
  )
})

test('decideBranchDelete: NO_PR refuses unless force', () => {
  assert.deepEqual(
    decideBranchDelete({
      deleteBranchRequested: true,
      prState: 'NO_PR',
      force: false,
    }),
    {
      action: 'refuse',
      reason: 'no PR found for branch — refusing to delete an unmerged branch',
    },
  )
  assert.deepEqual(
    decideBranchDelete({
      deleteBranchRequested: true,
      prState: 'NO_PR',
      force: true,
    }),
    { action: 'delete' },
  )
})

// --- decideBranchDelete: full matrix (subtask 3.3) ---
// 5 prStates × deleteBranchRequested × force = 20 cases. Expected values
// are literals; refusal rows also pin the reason substring.

interface MatrixCase {
  prState: 'MERGED' | 'OPEN' | 'CLOSED' | 'NO_PR' | 'GH_MISSING'
  requested: boolean
  force: boolean
  action: 'delete' | 'refuse' | 'skip'
  reasonSubstr: string
}

const DECIDE_MATRIX: MatrixCase[] = [
  // deleteBranchRequested: false → always skip regardless of prState/force
  {
    prState: 'MERGED',
    requested: false,
    force: false,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'MERGED',
    requested: false,
    force: true,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'OPEN',
    requested: false,
    force: false,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'OPEN',
    requested: false,
    force: true,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'CLOSED',
    requested: false,
    force: false,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'CLOSED',
    requested: false,
    force: true,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'NO_PR',
    requested: false,
    force: false,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'NO_PR',
    requested: false,
    force: true,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'GH_MISSING',
    requested: false,
    force: false,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  {
    prState: 'GH_MISSING',
    requested: false,
    force: true,
    action: 'skip',
    reasonSubstr: 'delete_branch not requested',
  },
  // deleteBranchRequested: true, force: false → only MERGED deletes
  {
    prState: 'MERGED',
    requested: true,
    force: false,
    action: 'delete',
    reasonSubstr: '',
  },
  {
    prState: 'OPEN',
    requested: true,
    force: false,
    action: 'refuse',
    reasonSubstr: 'PR for branch is OPEN',
  },
  {
    prState: 'CLOSED',
    requested: true,
    force: false,
    action: 'refuse',
    reasonSubstr: 'PR for branch is CLOSED',
  },
  {
    prState: 'NO_PR',
    requested: true,
    force: false,
    action: 'refuse',
    reasonSubstr: 'no PR found for branch',
  },
  {
    prState: 'GH_MISSING',
    requested: true,
    force: false,
    action: 'refuse',
    reasonSubstr: 'gh CLI unavailable',
  },
  // deleteBranchRequested: true, force: true → force overrides everything
  {
    prState: 'MERGED',
    requested: true,
    force: true,
    action: 'delete',
    reasonSubstr: '',
  },
  {
    prState: 'OPEN',
    requested: true,
    force: true,
    action: 'delete',
    reasonSubstr: '',
  },
  {
    prState: 'CLOSED',
    requested: true,
    force: true,
    action: 'delete',
    reasonSubstr: '',
  },
  {
    prState: 'NO_PR',
    requested: true,
    force: true,
    action: 'delete',
    reasonSubstr: '',
  },
  {
    prState: 'GH_MISSING',
    requested: true,
    force: true,
    action: 'delete',
    reasonSubstr: '',
  },
]

for (const c of DECIDE_MATRIX) {
  const forceLabel = c.force ? 'force' : 'no force'
  test(`decideBranchDelete matrix: ${c.prState} + ${c.requested ? 'requested' : 'not requested'} + ${forceLabel} → ${c.action}`, () => {
    const decision = decideBranchDelete({
      deleteBranchRequested: c.requested,
      prState: c.prState,
      force: c.force,
    })
    assert.equal(decision.action, c.action)
    if (decision.action === 'refuse' || decision.action === 'skip') {
      assert.ok(
        decision.reason.includes(c.reasonSubstr),
        `reason "${decision.reason}" should contain "${c.reasonSubstr}"`,
      )
    }
  })
}

// --- selectEnvFiles: edge matrix (subtask 3.3) ---

test('selectEnvFiles: .env source-only → included', () => {
  assert.deepEqual(selectEnvFiles(['.env', 'README.md'], []), ['.env'])
})

test('selectEnvFiles: .env in both → excluded (never overwritten)', () => {
  assert.deepEqual(selectEnvFiles(['.env', '.env.local'], ['.env']), [
    '.env.local',
  ])
})

test('selectEnvFiles: .env.local source-only → included', () => {
  assert.deepEqual(selectEnvFiles(['.env', '.env.local'], ['.env']), [
    '.env.local',
  ])
})

test('selectEnvFiles: .env.production in both → excluded', () => {
  assert.deepEqual(
    selectEnvFiles(['.env', '.env.production'], ['.env.production']),
    ['.env'],
  )
})

test('selectEnvFiles: .environment excluded — not a dotenv file', () => {
  assert.deepEqual(selectEnvFiles(['.environment'], []), [])
})

// AIDEV-NOTE: '.env.example' starts with '.env.' so it IS copied —
// documented behavior: example files get copied too (missing-only).
test('selectEnvFiles: .env.example included — starts with .env. (documented behavior)', () => {
  assert.deepEqual(selectEnvFiles(['.env.example'], []), ['.env.example'])
})

test('selectEnvFiles: empty source → nothing to copy', () => {
  assert.deepEqual(selectEnvFiles([], ['.env', '.env.local']), [])
})

test('selectEnvFiles: empty target → all source .env* copied', () => {
  assert.deepEqual(
    selectEnvFiles(
      ['.env', '.env.local', '.env.production', 'README.md', 'src'],
      [],
    ),
    ['.env', '.env.local', '.env.production'],
  )
})

test('selectEnvFiles: no .env files at all in either dir → empty', () => {
  assert.deepEqual(
    selectEnvFiles(['README.md', 'package.json', 'src'], ['README.md']),
    [],
  )
})

// --- detectBootstrapPlan: gap cases (subtask 3.3) ---

test('detectBootstrapPlan: bun.lock + bun.lockb both present → single bun install, ambiguity noted', () => {
  const plan = detectBootstrapPlan(['bun.lock', 'bun.lockb'])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].label, 'bun install')
  assert.ok((plan.note ?? '').includes('multiple JS lockfiles'))
})

test('detectBootstrapPlan: go.mod + Cargo.toml, no JS lockfile → cargo fetch + go note', () => {
  const plan = detectBootstrapPlan(['go.mod', 'Cargo.toml'])
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0].label, 'cargo fetch')
  assert.ok((plan.note ?? '').includes('go:'))
})

// AIDEV-NOTE: create fixture captured live from `herdr worktree create`
// on herdr 0.8.2 (smoke test 4.2) — trimmed to load-bearing fields.
test('parseCreateResult: real herdr 0.8.2 create payload', () => {
  const stdout = JSON.stringify({
    id: 'cli:worktree:create',
    result: {
      type: 'worktree_created',
      workspace: {
        workspace_id: 'w27',
        label: 'wt-demo2',
        worktree: {
          checkout_path:
            '/home/geert/.herdr/worktrees/pi-my-rifle-ext/wt-demo2',
        },
      },
      worktree: {
        branch: 'wt-demo2',
        open_workspace_id: 'w27',
        path: '/home/geert/.herdr/worktrees/pi-my-rifle-ext/wt-demo2',
      },
    },
  })
  assert.deepEqual(parseCreateResult(stdout), {
    path: '/home/geert/.herdr/worktrees/pi-my-rifle-ext/wt-demo2',
    workspaceId: 'w27',
  })
})

test('parseCreateResult: non-JSON returns empty fields, never throws', () => {
  assert.deepEqual(parseCreateResult('not json'), {
    path: '',
    workspaceId: '',
  })
})
