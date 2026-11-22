import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  deriveBranch,
  parseBranchInput,
  personalBranch,
  slugify,
} from '../worktree/branch.ts'

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

test('personalBranch: injects validated ref', () => {
  assert.equal(
    personalBranch('Add Save Button & Export!', 'feat', 'PMR-AB12'),
    'feat/PMR-AB12-add-save-button-export',
  )
})

test('personalBranch: null ref stays bare', () => {
  assert.equal(personalBranch('docs', 'docs', null), 'docs/docs')
})

test('personalBranch: letter-suffix ref accepted', () => {
  assert.equal(
    personalBranch('prefix personal branch', 'feat', 'PMR-902B'),
    'feat/PMR-902B-prefix-personal-branch',
  )
})

test('personalBranch: lowercase ref throws', () => {
  assert.throws(
    () => personalBranch('x', 'feat', 'pmr-ab12'),
    /Invalid flow ref 'pmr-ab12'/,
  )
})

test('personalBranch: malformed ref throws', () => {
  assert.throws(
    () => personalBranch('x', 'feat', 'PMR-'),
    /Invalid flow ref 'PMR-'/,
  )
})

test('deriveBranch: personal kind threads flowRef', async () => {
  const pi = {} as unknown as ExtensionAPI
  const result = await deriveBranch(pi, {
    kind: 'personal',
    name: 'Add Save Button & Export!',
    type: 'feat',
    flowRef: 'PMR-AB12',
  })
  assert.deepEqual(result, {
    branch: 'feat/PMR-AB12-add-save-button-export',
    source: 'personal',
  })
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
} from '../worktree/herdr.ts'

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

import { detectBootstrapPlan, selectEnvFiles } from '../worktree/bootstrap.ts'

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

import {
  decideAutoBranchDelete,
  decideBranchDelete,
  describePruneFailure,
} from '../worktree/remove-guards.ts'

test('describePruneFailure: publickey failure classified as skip', () => {
  const note = describePruneFailure(
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
  )
  assert.match(note, /^prune skipped:/)
  assert.match(note, /publickey/)
  assert.doesNotMatch(note, /failed/)
})

test('describePruneFailure: other failures keep the non-fatal failure note', () => {
  const note = describePruneFailure('fatal: unable to connect')
  assert.equal(
    note,
    'git fetch --prune failed (non-fatal): fatal: unable to connect',
  )
})

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

// --- decideAutoBranchDelete: full matrix (subtask 3.3, PMR-81SX phase 3) ---
// Auto-cleanup path never refuses/skips: delete or keep (branch or all).
// Personal-mode merged-proof failure keeps worktree AND branch (keep-all);
// work-mode unproven states keep only the branch (keep-branch).

test('decideAutoBranchDelete: personal + merged-proof → delete', () => {
  assert.deepEqual(
    decideAutoBranchDelete({
      mode: 'personal',
      prState: 'NO_PR',
      localMergedProof: true,
    }),
    { action: 'delete' },
  )
})

test('decideAutoBranchDelete: personal + merged-proof failure → keep-all naming the ancestor check', () => {
  const decision = decideAutoBranchDelete({
    mode: 'personal',
    prState: 'NO_PR',
    localMergedProof: false,
  })
  assert.equal(decision.action, 'keep-all')
  // assert.equal above narrows the action to 'keep-all' — a `!== 'delete'`
  // comparison here is a tsc-fatal no-overlap check; keep only the shape pin.
  assert.ok('reason' in decision)
  assert.match(decision.reason, /merge-base --is-ancestor/)
})

for (const prState of [
  'MERGED',
  'OPEN',
  'CLOSED',
  'GH_MISSING',
  'NO_PR',
] as const) {
  const expected =
    prState === 'MERGED'
      ? { action: 'delete' as const }
      : { action: 'keep-branch' as const }
  test(`decideAutoBranchDelete: work + ${prState} → ${expected.action}`, () => {
    const decision = decideAutoBranchDelete({
      mode: 'work',
      prState,
      localMergedProof: false,
    })
    assert.equal(decision.action, expected.action)
  })
}

test('decideAutoBranchDelete: work keep reasons are branch-only (keep-branch, never keep-all)', () => {
  for (const prState of ['OPEN', 'CLOSED', 'GH_MISSING', 'NO_PR'] as const) {
    const decision = decideAutoBranchDelete({
      mode: 'work',
      prState,
      localMergedProof: false,
    })
    assert.equal(decision.action, 'keep-branch', prState)
    // assert.equal above narrows the action — see the keep-all note above.
    assert.ok('reason' in decision)
    assert.ok(decision.reason.length > 0, prState)
  }
})

test('decideAutoBranchDelete: force deletes regardless of mode/proof/state', () => {
  // personal + failed proof + force
  assert.deepEqual(
    decideAutoBranchDelete({
      mode: 'personal',
      prState: 'NO_PR',
      localMergedProof: false,
      force: true,
    }),
    { action: 'delete' },
  )
  // work + OPEN + force
  assert.deepEqual(
    decideAutoBranchDelete({
      mode: 'work',
      prState: 'OPEN',
      localMergedProof: false,
      force: true,
    }),
    { action: 'delete' },
  )
})

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

// --- worktree tool: bind action (PMR-8JVY) ---

import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getFlowWorktree,
  NO_ACTIVE_FLOW_WARNING,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import worktreeExtension from '../worktree/index.ts'
import { mkTmpDir } from './tmpdir.ts'

type BindExecute = (
  toolCallId: string,
  params: {
    action: string
    path?: string
    branch?: string
    name?: string
    type?: string
    cwd?: string
    force?: boolean
  },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: Record<string, unknown>,
) => Promise<{ content: { type: string; text: string }[] }>

// AIDEV-NOTE: PMR-MQT2 — bind validates against `herdr worktree list`;
// the mock exec serves the given worktrees as that command's JSON.
function makeWorktreeTool(
  herdrWorktrees: { path: string; branch: string }[] = [],
  opts?: {
    exec?: (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => Promise<{ code: number; stdout: string; stderr: string }>
    deps?: { effects?: unknown }
  },
): BindExecute {
  const tools: { name: string; execute: BindExecute }[] = []
  const defaultExec = async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      result: {
        worktrees: herdrWorktrees.map((w) => ({
          ...w,
          is_linked: true,
        })),
      },
    }),
  })
  const mockPi = {
    exec: opts?.exec ?? defaultExec,
    registerTool: (options: unknown) => {
      tools.push(options as { name: string; execute: BindExecute })
    },
  } as unknown as ExtensionAPI
  const ext = worktreeExtension as unknown as (
    pi: ExtensionAPI,
    deps?: unknown,
  ) => void
  ext(mockPi, opts?.deps)
  const tool = tools.find((t) => t.name === 'worktree')
  assert.ok(tool, 'worktree tool registered')
  return tool.execute
}

// AIDEV-NOTE: PMR-MQT2 — flow state is module-global; reset after every
// test so a failing assertion cannot leak a ref/binding into later tests.
afterEach(() => {
  setActiveFlowRef(null)
})

const bindCtx = {
  cwd: '/tmp/main-checkout',
  hasUI: false,
  mode: 'tui',
}

test('worktree bind: requires path and branch', async () => {
  const execute = makeWorktreeTool()
  const result = await execute(
    'call-1',
    { action: 'bind' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /requires 'path' and 'branch'/)
})

test('worktree bind: rejects a nonexistent path', async () => {
  const execute = makeWorktreeTool()
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-2',
    {
      action: 'bind',
      path: '/tmp/definitely-not-here-pmr-8jvy',
      branch: 'fix/x',
    },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /No directory at/)
})

test('worktree bind: refuses without an active flow ref', async () => {
  const execute = makeWorktreeTool()
  const dir = mkTmpDir('wt-bind-')
  setActiveFlowRef(null)
  const result = await execute(
    'call-3',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /No active flow ref/)
  assert.match(result.content[0]?.text ?? '', /\/flow/)
  assert.equal(getFlowWorktree(), null, 'no binding without an active ref')
})

test('setFlowWorktree: reports skipped bind when no flow is active (create path)', () => {
  setActiveFlowRef(null)
  assert.equal(setFlowWorktree('/tmp/x', 'fix/x'), false)
  assert.equal(getFlowWorktree(), null)
  assert.match(NO_ACTIVE_FLOW_WARNING, /NOT bound/)
  assert.match(NO_ACTIVE_FLOW_WARNING, /\/flow/)
  setActiveFlowRef('PMR-TEST')
  assert.equal(setFlowWorktree('/tmp/x', 'fix/x'), true)
})

test('worktree bind: binds the worktree to the active flow ref', async () => {
  const dir = mkTmpDir('wt-bind-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }])
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-4',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /Bound worktree/)
  assert.doesNotMatch(result.content[0]?.text ?? '', /replacing/)
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-TEST',
    path: dir,
    branch: 'fix/x',
  })
})

test('worktree bind: resolves a relative path against the session cwd', async () => {
  const dir = mkTmpDir('wt-bind-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }])
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-5',
    { action: 'bind', path: path.basename(dir), branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    { ...bindCtx, cwd: tmpdir() },
  )
  assert.match(result.content[0]?.text ?? '', /Bound worktree/)
  assert.equal(getFlowWorktree()?.path, dir)
})

test('worktree bind: rejects a path herdr does not know', async () => {
  const dir = mkTmpDir('wt-bind-')
  const execute = makeWorktreeTool([])
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-6',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /No Herdr worktree found/)
  assert.equal(getFlowWorktree(), null)
})

test('worktree bind: rejects a branch mismatch and reports the actual branch', async () => {
  const dir = mkTmpDir('wt-bind-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/actual' }])
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-7',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /fix\/actual/)
  assert.equal(getFlowWorktree(), null)
})

test('worktree bind: reports a replaced binding', async () => {
  const dir = mkTmpDir('wt-bind-')
  const execute = makeWorktreeTool([{ path: dir, branch: 'fix/x' }])
  setActiveFlowRef('PMR-TEST')
  setFlowWorktree('/tmp/old-binding', 'fix/old')
  const result = await execute(
    'call-8',
    { action: 'bind', path: dir, branch: 'fix/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(
    result.content[0]?.text ?? '',
    /replacing previous binding \/tmp\/old-binding/,
  )
})

// --- worktree tool: effect declarations (PMR-VDVJ phase 5) ---

import type { EffectDeclarationRecord, EffectJournal } from '../run-state.ts'

const BASE_SHA = `${'a'.repeat(39)}b`

interface CapturedDeclaration {
  ref: string
  effect: string
  command: string
  recipe: string[]
  headSha?: string
}

// AIDEV-NOTE: fake journal — records declarations in memory, never touches
// the real journal file; `declareOk` flips the fail-closed gate per test.
function makeFakeEffects(declareOk: boolean): EffectJournal & {
  declarations: CapturedDeclaration[]
} {
  const declarations: CapturedDeclaration[] = []
  const journal = {
    declarations,
    declare: async (input: {
      ref: string
      effect: string
      command: string
      recipe: string[]
      headSha?: string
    }) => {
      declarations.push({
        ref: input.ref,
        effect: input.effect,
        command: input.command,
        recipe: input.recipe,
        headSha: input.headSha,
      })
      if (!declareOk) {
        return { ok: false as const, reason: 'journal offline' }
      }
      return { ok: true as const, effectId: 'deadbeef1234' }
    },
    find: async (_query: {
      ref: string
      effect: string
      headSha?: string
    }): Promise<EffectDeclarationRecord | null> => null,
  }
  return journal as EffectJournal & { declarations: CapturedDeclaration[] }
}

// AIDEV-NOTE: routed exec fake for the create path — serves the exact
// commands createFlow issues (git introspection, herdr preflight/list,
// herdr worktree create) and records every herdr call so tests can assert
// create was or was not invoked.
function makeCreateExec(): {
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  herdrCalls: string[]
} {
  const herdrCalls: string[] = []
  const exec = async (
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (command === 'herdr') {
      herdrCalls.push(`herdr ${args.join(' ')}`)
      if (args[1] === 'create') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            result: {
              worktree: {
                open_workspace_id: 'w27',
                path: '/tmp/herdr-wt/feat-x',
              },
            },
          }),
        }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { worktrees: [] } }),
      }
    }
    if (command === 'git' && args[0] === 'worktree') {
      return {
        code: 0,
        stderr: '',
        stdout: `worktree /tmp/main-checkout\nHEAD ${BASE_SHA}\nbranch refs/heads/main\n`,
      }
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--abbrev-ref') {
        return { code: 0, stderr: '', stdout: 'main\n' }
      }
      return { code: 0, stderr: '', stdout: `${BASE_SHA}\n` }
    }
    return { code: 0, stderr: '', stdout: '' }
  }
  return { exec, herdrCalls }
}

function makeRemoveExec(workspaceId: string): {
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  herdrCalls: string[]
} {
  const herdrCalls: string[] = []
  const exec = async (
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (command === 'herdr') {
      herdrCalls.push(`herdr ${args.join(' ')}`)
      if (args[1] === 'list') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            result: {
              worktrees: [
                {
                  path: '/tmp/herdr-wt/feat-x',
                  branch: 'feat/x',
                  workspace_id: workspaceId,
                  is_linked_worktree: true,
                },
              ],
            },
          }),
        }
      }
      return { code: 0, stderr: '', stdout: '' }
    }
    if (command === 'git' && args[0] === 'worktree') {
      return {
        code: 0,
        stderr: '',
        stdout: 'worktree /tmp/main-checkout\nbranch refs/heads/main\n',
      }
    }
    if (
      command === 'git' &&
      args[0] === 'rev-parse' &&
      args[1] === '--abbrev-ref'
    ) {
      return { code: 0, stderr: '', stdout: 'feat/x\n' }
    }
    return { code: 0, stderr: '', stdout: '' }
  }
  return { exec, herdrCalls }
}

test('worktree create: failing declare refuses before herdr create and clears flow base', async () => {
  const { exec, herdrCalls } = makeCreateExec()
  const configCalls: string[] = []
  const routedExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    if (command === 'git' && args[0] === 'config') {
      configCalls.push(args.join(' '))
    }
    return exec(command, args, options)
  }
  const effects = makeFakeEffects(false)
  const execute = makeWorktreeTool([], { exec: routedExec, deps: { effects } })
  const result = await execute(
    'call-e1',
    { action: 'create', branch: 'feat/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /refus/i)
  assert.match(result.content[0]?.text ?? '', /journal offline/)
  assert.match(result.content[0]?.text ?? '', /fail-closed/i)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree create')),
    false,
    'herdr worktree create must NOT run when declare fails',
  )
  assert.ok(
    configCalls.some((c) => c.includes('--unset branch.feat/x.flowbase')),
    'flow base must be cleared (git config --unset) after refused create',
  )
})

test('worktree create: succeeding declare mirrors herdr argv and behaves as today', async () => {
  const { exec, herdrCalls } = makeCreateExec()
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  const result = await execute(
    'call-e2',
    { action: 'create', branch: 'feat/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /Worktree ready: feat\/x/)
  assert.ok(
    herdrCalls.some((c) => c.startsWith('herdr worktree create')),
    'herdr worktree create runs when declare succeeds',
  )
  assert.equal(effects.declarations.length, 1)
  const decl = effects.declarations[0]
  assert.equal(decl.effect, 'worktree-create')
  assert.equal(decl.headSha, undefined)
  assert.ok(decl.recipe.length > 0)
  assert.equal(
    decl.command,
    `herdr worktree create --cwd ${bindCtx.cwd} --branch feat/x --label featx --base ${BASE_SHA}`,
  )
})

test('worktree create: declaration lands under the active flow ref, else worktree-ops', async () => {
  const active = makeCreateExec()
  const activeEffects = makeFakeEffects(true)
  const executeActive = makeWorktreeTool([], {
    exec: active.exec,
    deps: { effects: activeEffects },
  })
  setActiveFlowRef('PMR-FLOWREF')
  await executeActive(
    'call-e3',
    { action: 'create', branch: 'feat/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.equal(activeEffects.declarations[0]?.ref, 'PMR-FLOWREF')

  const idle = makeCreateExec()
  const idleEffects = makeFakeEffects(true)
  const executeIdle = makeWorktreeTool([], {
    exec: idle.exec,
    deps: { effects: idleEffects },
  })
  setActiveFlowRef(null)
  await executeIdle(
    'call-e4',
    { action: 'create', branch: 'feat/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.equal(idleEffects.declarations[0]?.ref, 'worktree-ops')
})

// AIDEV-NOTE: PMR-902B — injection seam: createFlow reads getActiveFlowRef()
// and threads it into the personal branch input, so name+type yields
// <type>/<REF>-<slug> during a flow and the bare <type>/<slug> otherwise.
// Literal/jira modes ignore the ref, which is why the 'feat/x' fixtures above
// stay green with a flow active.
test('worktree create: name+type injects the active flow ref into the branch', async () => {
  const { exec, herdrCalls } = makeCreateExec()
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-r1',
    { action: 'create', name: 'Add save button', type: 'feat' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(
    result.content[0]?.text ?? '',
    /Worktree ready: feat\/PMR-TEST-add-save-button/,
  )
  assert.ok(
    herdrCalls.some((c) =>
      c.includes('--branch feat/PMR-TEST-add-save-button'),
    ),
    `herdr worktree create must receive the ref-prefixed branch, got: ${herdrCalls.join(' | ')}`,
  )
  // Label default keeps working on the prefixed branch (no brackets, 5-word cap).
  assert.ok(
    herdrCalls.some((c) => c.includes('--label featpmr-test-add-save-button')),
    `label must derive from the prefixed branch, got: ${herdrCalls.join(' | ')}`,
  )
})

test('worktree create: name+type without an active flow stays bare (ISC-2)', async () => {
  const { exec, herdrCalls } = makeCreateExec()
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  setActiveFlowRef(null)
  const result = await execute(
    'call-r2',
    { action: 'create', name: 'Add save button' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(
    result.content[0]?.text ?? '',
    /Worktree ready: feat\/add-save-button/,
  )
  assert.ok(
    herdrCalls.some((c) => c.includes('--branch feat/add-save-button')),
    `herdr worktree create must receive the bare branch, got: ${herdrCalls.join(' | ')}`,
  )
})

test('worktree create: literal branch ignores the active flow ref', async () => {
  const { exec, herdrCalls } = makeCreateExec()
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  setActiveFlowRef('PMR-TEST')
  const result = await execute(
    'call-r3',
    { action: 'create', branch: 'feat/x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /Worktree ready: feat\/x/)
  assert.ok(
    herdrCalls.some((c) => c.includes('--branch feat/x ')),
    `literal branch must pass through untouched, got: ${herdrCalls.join(' | ')}`,
  )
})

test('worktree remove: failing declare leaves worktree intact (no herdr remove)', async () => {
  const { exec, herdrCalls } = makeRemoveExec('w27')
  const effects = makeFakeEffects(false)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  const result = await execute(
    'call-e5',
    { action: 'remove', cwd: '/tmp/herdr-wt/feat-x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /refus/i)
  assert.match(result.content[0]?.text ?? '', /journal offline/)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
    false,
    'herdr worktree remove must NOT run when declare fails',
  )
})

test('worktree remove: succeeding declare mirrors herdr argv and removes as today', async () => {
  const { exec, herdrCalls } = makeRemoveExec('w27')
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  const result = await execute(
    'call-e6',
    { action: 'remove', cwd: '/tmp/herdr-wt/feat-x' },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.match(result.content[0]?.text ?? '', /Removed worktree at/)
  assert.ok(herdrCalls.includes('herdr worktree remove --workspace w27'))
  assert.equal(effects.declarations.length, 1)
  const decl = effects.declarations[0]
  assert.equal(decl.effect, 'worktree-remove')
  assert.equal(decl.command, 'herdr worktree remove --workspace w27')
  assert.ok(decl.recipe.length > 0)
})

test('worktree remove: force appends --force to the declared command', async () => {
  const { exec } = makeRemoveExec('w27')
  const effects = makeFakeEffects(true)
  const execute = makeWorktreeTool([], { exec, deps: { effects } })
  await execute(
    'call-e7',
    { action: 'remove', cwd: '/tmp/herdr-wt/feat-x', force: true },
    new AbortController().signal,
    undefined,
    bindCtx,
  )
  assert.equal(
    effects.declarations[0]?.command,
    'herdr worktree remove --workspace w27 --force',
  )
})

// --- cleanupFlowWorktree (PMR-81SX phase 5, subtask 5.3) ---

import type { FlowWorktree } from '../flow/worktree-context.ts'
import { cleanupFlowWorktree } from '../worktree/index.ts'

const CLEANUP_WT_PATH = '/tmp/herdr-wt/feat-x'
const CLEANUP_MAIN_CWD = '/tmp/main-checkout'
const CLEANUP_BRANCH = 'feat/x'
const CLEANUP_WORKSPACE_ID = 'w27'

interface CleanupExecOpts {
  dirty?: string
  agents?: Array<{
    agent: string
    agent_status: string
    workspace_id: string
    cwd: string
    pane_id?: string
  }>
  agentListFails?: boolean
  mergeBaseOk?: boolean
  prState?: string
  // Simulate gh being absent entirely (`gh pr view` fails with command-not-found).
  ghMissing?: boolean
}

// AIDEV-NOTE: routed exec fake serving every command cleanupFlowWorktree /
// removeWorktreeCore / clearFlowBase issue: git status (dirty guard), herdr
// agent list (in-flight guard), herdr worktree list (preflight + target),
// git worktree list --porcelain (main checkout), merge-base (personal
// merged-proof), gh pr view (work mode), rev-parse (branch capture +
// reviewed-at), git branch -D, git fetch --prune, git config (flow-base
// clear). herdr worktree remove, branch -D, and config calls are recorded
// WITH their cwd so tests can assert the main-checkout chore attribution.
function makeCleanupExec(opts: CleanupExecOpts = {}): {
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  herdrCalls: string[]
  configCalls: Array<{ args: string; cwd: string | undefined }>
  branchDeleteCalls: Array<{ args: string; cwd: string | undefined }>
} {
  const herdrCalls: string[] = []
  const configCalls: Array<{ args: string; cwd: string | undefined }> = []
  const branchDeleteCalls: Array<{ args: string; cwd: string | undefined }> = []
  // AIDEV-NOTE: PMR-81SX fix round — the gh fake defaults to NO_PR, the
  // realistic state for personal mode (pushes are blocked, so no PR can
  // ever exist). The MERGED default masked the P0 where the core's manual
  // NO_PR refusal vetoed auto deletes; work-mode tests set prState
  // explicitly.
  const prState = opts.prState ?? 'NO_PR'
  let mergeBaseCode = 0
  if (opts.mergeBaseOk !== true) {
    mergeBaseCode = 1
  }
  const exec = async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const cwd = options?.cwd
    if (command === 'git' && args[0] === 'status') {
      return { code: 0, stdout: opts.dirty ?? '', stderr: '' }
    }
    if (command === 'herdr' && args[0] === 'agent' && args[1] === 'list') {
      if (opts.agentListFails === true) {
        return { code: 1, stdout: '', stderr: 'herdr agent list exploded' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { agents: opts.agents ?? [] } }),
      }
    }
    if (command === 'herdr') {
      herdrCalls.push(`herdr ${args.join(' ')}`)
      if (args[1] === 'remove') {
        return { code: 0, stdout: '', stderr: '' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          result: {
            worktrees: [
              {
                path: CLEANUP_WT_PATH,
                branch: CLEANUP_BRANCH,
                workspace_id: CLEANUP_WORKSPACE_ID,
                is_linked_worktree: true,
              },
            ],
          },
        }),
      }
    }
    if (command === 'git' && args[0] === 'worktree') {
      return {
        code: 0,
        stderr: '',
        stdout: `worktree ${CLEANUP_MAIN_CWD}\nbranch refs/heads/main\n`,
      }
    }
    if (command === 'git' && args[0] === 'merge-base') {
      return { code: mergeBaseCode, stdout: '', stderr: '' }
    }
    if (command === 'gh') {
      if (opts.ghMissing === true) {
        return { code: 127, stdout: '', stderr: 'bash: gh: command not found' }
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ state: prState }),
      }
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--abbrev-ref') {
        return { code: 0, stderr: '', stdout: `${CLEANUP_BRANCH}\n` }
      }
      return { code: 0, stderr: '', stdout: `${BASE_SHA}\n` }
    }
    if (command === 'git' && args[0] === 'branch' && args[1] === '-D') {
      branchDeleteCalls.push({ args: args.join(' '), cwd })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'fetch') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'config') {
      configCalls.push({ args: args.join(' '), cwd })
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, herdrCalls, configCalls, branchDeleteCalls }
}

function makeCleanupInput(
  mode: 'work' | 'personal',
  overrides?: Partial<{
    worktree: FlowWorktree | undefined
    ref: string
    // Explicit binding ref override — defaults to matching `ref` so tests
    // only get the ref-mismatch invariant when they ask for it.
    worktreeRef: string
  }>,
): {
  ref: string
  mode: 'work' | 'personal'
  worktree: FlowWorktree | undefined
  cwd: string
  annotate: (ref: string, body: string) => Promise<void>
} & { annotateCalls: Array<{ ref: string; body: string }> } {
  const annotateCalls: Array<{ ref: string; body: string }> = []
  const annotate = async (ref: string, body: string) => {
    annotateCalls.push({ ref, body })
  }
  let worktree: FlowWorktree | undefined = {
    ref: overrides?.worktreeRef ?? overrides?.ref ?? 'PMR-CLN',
    path: CLEANUP_WT_PATH,
    branch: CLEANUP_BRANCH,
  }
  if (overrides !== undefined && 'worktree' in overrides) {
    worktree = overrides.worktree
  }
  return {
    ref: overrides?.ref ?? 'PMR-CLN',
    mode,
    worktree,
    cwd: CLEANUP_MAIN_CWD,
    annotate,
    annotateCalls,
  }
}

test('cleanupFlowWorktree: no binding is a no-op touching nothing', async () => {
  const { exec } = makeCleanupExec()
  const executed: string[] = []
  const recordingExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    executed.push(`${command} ${args.join(' ')}`)
    return exec(command, args, options)
  }
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal', { worktree: undefined })
  const summary = await cleanupFlowWorktree(
    { exec: recordingExec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.deepEqual(summary, {
    action: 'noop',
    reason: 'no flow worktree bound',
  })
  assert.equal(executed.length, 0, 'no-op must not exec anything')
  assert.equal(effects.declarations.length, 0)
  assert.equal(input.annotateCalls.length, 0)
})

test('cleanupFlowWorktree: dirty worktree defers before any agent probe or removal', async () => {
  const { exec, herdrCalls, configCalls, branchDeleteCalls } = makeCleanupExec({
    dirty: ' M src/foo.ts\n',
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'deferred')
  assert.match(summary.reason, /dirty/)
  assert.equal(
    herdrCalls.length,
    0,
    'dirty guard must short-circuit before herdr probes',
  )
  assert.equal(effects.declarations.length, 0, 'no effect declared when dirty')
  assert.equal(branchDeleteCalls.length, 0)
  assert.equal(configCalls.length, 0)
  // PMR-W6C4: the deferred outcome is human-visible on the flow ticket.
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0]?.body ?? '', /cleanup deferred/)
  assert.match(input.annotateCalls[0]?.body ?? '', /dirty/)
})

test('cleanupFlowWorktree: live agent in the worktree workspace defers', async () => {
  const { exec, herdrCalls, branchDeleteCalls } = makeCleanupExec({
    agents: [
      {
        agent: 'pi',
        agent_status: 'working',
        workspace_id: CLEANUP_WORKSPACE_ID,
        cwd: CLEANUP_WT_PATH,
      },
    ],
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'deferred')
  assert.match(summary.reason, /in-flight/)
  assert.match(summary.reason, /state: working/)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
    false,
    'no removal while an agent may be live',
  )
  assert.equal(branchDeleteCalls.length, 0)
  assert.equal(effects.declarations.length, 0)
  // PMR-W6C4: the deferred outcome is human-visible on the flow ticket.
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0]?.body ?? '', /cleanup deferred/)
  assert.match(input.annotateCalls[0]?.body ?? '', /in-flight/)
})

test('cleanupFlowWorktree: the session own herdr agent does not self-match the guard', async () => {
  // PMR-F5HB: when the flow session itself runs INSIDE the worktree, its own
  // agent row (same workspace/cwd) must not defer cleanup forever — the
  // guard excludes the agent whose pane_id matches HERDR_PANE_ID.
  const { exec, herdrCalls } = makeCleanupExec({
    mergeBaseOk: true,
    agents: [
      {
        agent: 'pi',
        agent_status: 'working',
        pane_id: 'pane-self',
        workspace_id: CLEANUP_WORKSPACE_ID,
        cwd: CLEANUP_WT_PATH,
      },
    ],
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const previous = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = `${CLEANUP_WORKSPACE_ID}:pane-self`
  try {
    const summary = await cleanupFlowWorktree(
      { exec } as unknown as ExtensionAPI,
      effects,
      input,
    )
    assert.equal(summary.action, 'removed')
    assert.equal(
      herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
      true,
      'own-agent self-match must not defer the removal',
    )
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = previous
  }
})

test('cleanupFlowWorktree: a different agent on another pane still defers', async () => {
  const { exec, herdrCalls } = makeCleanupExec({
    agents: [
      {
        agent: 'worker',
        agent_status: 'working',
        pane_id: 'pane-child',
        workspace_id: CLEANUP_WORKSPACE_ID,
        cwd: CLEANUP_WT_PATH,
      },
    ],
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const previous = process.env.HERDR_PANE_ID
  process.env.HERDR_PANE_ID = `${CLEANUP_WORKSPACE_ID}:pane-self`
  try {
    const summary = await cleanupFlowWorktree(
      { exec } as unknown as ExtensionAPI,
      effects,
      input,
    )
    assert.equal(summary.action, 'deferred')
    assert.match(summary.reason, /in-flight/)
    assert.equal(
      herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
      false,
      'a non-self agent still defers cleanup',
    )
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID
    else process.env.HERDR_PANE_ID = previous
  }
})

test('cleanupFlowWorktree: unrecognized agent_status defers (unknown-means-live)', async () => {
  const { exec, herdrCalls } = makeCleanupExec({
    agents: [
      {
        agent: 'pi',
        agent_status: 'mysterious-zombie',
        workspace_id: CLEANUP_WORKSPACE_ID,
        cwd: CLEANUP_WT_PATH,
      },
    ],
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'deferred')
  assert.match(summary.reason, /in-flight/)
  assert.match(summary.reason, /state: mysterious-zombie/)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
    false,
  )
  // PMR-W6C4: the deferred outcome is human-visible on the flow ticket.
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0]?.body ?? '', /cleanup deferred/)
})

test('cleanupFlowWorktree: agentList failure defers fail-closed', async () => {
  const { exec, herdrCalls } = makeCleanupExec({ agentListFails: true })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'deferred')
  assert.match(summary.reason, /agent list unavailable/)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
    false,
  )
  assert.equal(effects.declarations.length, 0)
  // PMR-W6C4: the fail-closed defer is human-visible on the flow ticket.
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0]?.body ?? '', /cleanup deferred/)
  assert.match(input.annotateCalls[0]?.body ?? '', /agent list unavailable/)
})

test('cleanupFlowWorktree: personal + merged-proof removes with the explicit flow ref', async () => {
  const { exec, herdrCalls, configCalls, branchDeleteCalls } = makeCleanupExec({
    mergeBaseOk: true,
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal', { ref: 'PMR-EXPLICIT' })
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'removed')
  assert.match(summary.reason, /removed/)
  // Explicit-ref assertion on the fake journal — never 'worktree-ops'.
  assert.equal(effects.declarations.length, 1)
  const decl = effects.declarations[0]
  assert.equal(decl.ref, 'PMR-EXPLICIT')
  assert.notEqual(decl.ref, 'worktree-ops')
  assert.equal(decl.effect, 'worktree-remove')
  assert.equal(
    decl.command,
    `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
  )
  assert.ok(
    herdrCalls.includes(
      `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
    ),
    'herdr removal executed',
  )
  assert.equal(branchDeleteCalls.length, 1, 'branch -D runs exactly once')
  assert.equal(branchDeleteCalls[0].args, `branch -D ${CLEANUP_BRANCH}`)
  assert.equal(branchDeleteCalls[0].cwd, CLEANUP_MAIN_CWD)
  // clearFlowBase unsets both keys against the MAIN checkout cwd.
  assert.deepEqual(
    configCalls.map((c) => ({ args: c.args, cwd: c.cwd })),
    [
      {
        args: `config --unset branch.${CLEANUP_BRANCH}.flowbase`,
        cwd: CLEANUP_MAIN_CWD,
      },
      {
        args: `config --unset branch.${CLEANUP_BRANCH}.flowbasesha`,
        cwd: CLEANUP_MAIN_CWD,
      },
    ],
  )
  assert.equal(input.annotateCalls.length, 1)
  assert.equal(input.annotateCalls[0].ref, 'PMR-EXPLICIT')
  assert.match(input.annotateCalls[0].body, /branch deleted/)
  // Personal-mode removed annotation must not carry work-mode wording.
  assert.doesNotMatch(input.annotateCalls[0].body, /work mode/)
})

test('cleanupFlowWorktree: personal + failed merged-proof keeps all and annotates', async () => {
  const { exec, herdrCalls, configCalls, branchDeleteCalls } = makeCleanupExec({
    mergeBaseOk: false,
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'kept-all')
  assert.match(summary.reason, /merge-base --is-ancestor/)
  assert.equal(
    herdrCalls.some((c) => c.startsWith('herdr worktree remove')),
    false,
    'worktree kept',
  )
  assert.equal(branchDeleteCalls.length, 0, 'branch kept')
  assert.equal(configCalls.length, 0, 'no flow-base clear on keep-all')
  assert.equal(effects.declarations.length, 0)
  assert.equal(input.annotateCalls.length, 1)
  assert.equal(input.annotateCalls[0].ref, 'PMR-CLN')
  assert.match(input.annotateCalls[0].body, /worktree kept/)
  assert.match(input.annotateCalls[0].body, /reviewed-at/)
})

test('cleanupFlowWorktree: work + OPEN PR removes worktree but keeps the branch', async () => {
  const { exec, herdrCalls, configCalls, branchDeleteCalls } = makeCleanupExec({
    prState: 'OPEN',
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('work')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'removed')
  assert.ok(
    herdrCalls.includes(
      `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
    ),
  )
  assert.equal(branchDeleteCalls.length, 0, 'OPEN PR keeps the branch')
  assert.deepEqual(
    configCalls.map((c) => c.args),
    [
      `config --unset branch.${CLEANUP_BRANCH}.flowbase`,
      `config --unset branch.${CLEANUP_BRANCH}.flowbasesha`,
    ],
  )
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0].body, /branch kept/)
})

test('cleanupFlowWorktree: work + MERGED PR removes worktree and deletes the branch', async () => {
  const { exec, herdrCalls, branchDeleteCalls } = makeCleanupExec({
    prState: 'MERGED',
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('work')
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'removed')
  assert.ok(
    herdrCalls.includes(
      `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
    ),
  )
  assert.equal(branchDeleteCalls.length, 1)
  assert.equal(branchDeleteCalls[0].args, `branch -D ${CLEANUP_BRANCH}`)
  assert.equal(branchDeleteCalls[0].cwd, CLEANUP_MAIN_CWD)
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0].body, /branch deleted/)
})

// PMR-81SX fix round P0 regression: personal mode has NO gh PR by design
// (pushes are blocked) — the auto delete decision must pass into the core
// verbatim so the manual NO_PR refusal never vetoes the removal.
test('cleanupFlowWorktree: personal + merged-proof + NO_PR still removes (P0 regression)', async () => {
  const { exec, herdrCalls, branchDeleteCalls } = makeCleanupExec({
    mergeBaseOk: true,
    prState: 'NO_PR',
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal', { ref: 'PMR-CLN' })
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'removed')
  assert.ok(
    herdrCalls.includes(
      `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
    ),
    'worktree removed despite NO_PR',
  )
  assert.equal(branchDeleteCalls.length, 1, 'branch -D executed')
  assert.equal(branchDeleteCalls[0].args, `branch -D ${CLEANUP_BRANCH}`)
  assert.equal(branchDeleteCalls[0].cwd, CLEANUP_MAIN_CWD)
  assert.equal(effects.declarations.length, 1)
  assert.equal(effects.declarations[0].ref, 'PMR-CLN')
  assert.equal(effects.declarations[0].effect, 'worktree-remove')
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0].body, /branch deleted/)
  assert.doesNotMatch(input.annotateCalls[0].body, /work mode/)
})

// Same regression with gh entirely absent (GH_MISSING) — the manual guard
// refuses on GH_MISSING too, the injected auto decision must not.
test('cleanupFlowWorktree: personal + merged-proof + gh absent still removes', async () => {
  const { exec, herdrCalls, branchDeleteCalls } = makeCleanupExec({
    mergeBaseOk: true,
    ghMissing: true,
  })
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal', { ref: 'PMR-CLN' })
  const summary = await cleanupFlowWorktree(
    { exec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'removed')
  assert.ok(
    herdrCalls.includes(
      `herdr worktree remove --workspace ${CLEANUP_WORKSPACE_ID}`,
    ),
    'worktree removed despite gh being absent',
  )
  assert.equal(branchDeleteCalls.length, 1)
  assert.equal(branchDeleteCalls[0].args, `branch -D ${CLEANUP_BRANCH}`)
  assert.equal(effects.declarations.length, 1)
  assert.equal(effects.declarations[0].ref, 'PMR-CLN')
})

// PMR-81SX fix round P1: after a supersede, a stale binding from the prior
// flow must never be removed (or branch -D'd) under the new flow's ref.
test('cleanupFlowWorktree: binding ref mismatch is a no-op with zero side-effects', async () => {
  const { exec } = makeCleanupExec({ mergeBaseOk: true })
  const executed: string[] = []
  const recordingExec = async (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    executed.push(`${command} ${args.join(' ')}`)
    return exec(command, args, options)
  }
  const effects = makeFakeEffects(true)
  const input = makeCleanupInput('personal', {
    ref: 'PMR-NEWFLOW',
    worktreeRef: 'PMR-CLN',
  })
  const summary = await cleanupFlowWorktree(
    { exec: recordingExec } as unknown as ExtensionAPI,
    effects,
    input,
  )
  assert.equal(summary.action, 'noop')
  assert.match(summary.reason, /belongs to flow PMR-CLN, not PMR-NEWFLOW/)
  assert.equal(executed.length, 0, 'ref mismatch must not exec anything')
  assert.equal(effects.declarations.length, 0, 'no effect declared')
  // PMR-W6C4: the stale-binding noop is safety-relevant — it annotates (the
  // only annotated noop; the trivial no-binding noop stays silent).
  assert.equal(input.annotateCalls.length, 1)
  assert.match(input.annotateCalls[0]?.body ?? '', /cleanup noop/)
  assert.match(input.annotateCalls[0]?.body ?? '', /belongs to flow PMR-CLN/)
})
