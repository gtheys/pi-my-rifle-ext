import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ReviewDeps,
  resolveReviewWorktree,
} from '../tools/code-review-parse.ts'

const REPO_ROOT = '/repo/main'
const WORKTREE = '/worktrees/fix-external-worktree'
const COMMON_GIT_DIR = '/repo/main/.git'
const BRANCH = 'fix/external-worktree'

function externalWorktreeDeps(): ReviewDeps {
  return {
    getFlowWorktree: () => null,
    avenShowFull: async () => '',
    herdrWorktreeList: async () => [],
    exec: async (_cmd, args) => {
      const candidate = args[1] ?? ''
      if (args.includes('--show-toplevel')) {
        return { code: 0, stdout: `${candidate}\n`, stderr: '' }
      }
      if (args.includes('--git-common-dir')) {
        return { code: 0, stdout: `${COMMON_GIT_DIR}\n`, stderr: '' }
      }
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: `${BRANCH}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: () => true,
    repoRoot: REPO_ROOT,
  }
}

test('resolveReviewWorktree: binding accepts an external worktree of the session repo', async () => {
  const deps = externalWorktreeDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-ABC1',
    path: WORKTREE,
    branch: BRANCH,
  })

  const result = await resolveReviewWorktree('PMR-ABC1', deps)

  assert.deepEqual(result, {
    path: WORKTREE,
    branch: BRANCH,
    source: 'binding',
  })
})

test('resolveReviewWorktree: aven note accepts an external worktree of the session repo', async () => {
  const deps = externalWorktreeDeps()
  deps.avenShowFull = async () => `note id=n1
body<<EOF
worktree: ${WORKTREE}
branch: ${BRANCH}
EOF
`

  const result = await resolveReviewWorktree('PMR-ABC1', deps)

  assert.deepEqual(result, {
    path: WORKTREE,
    branch: BRANCH,
    source: 'note',
  })
})

test('resolveReviewWorktree: Herdr discovery accepts an external worktree of the session repo', async () => {
  const deps = externalWorktreeDeps()
  deps.avenShowFull = async () =>
    'PMR-ABC1 status=todo title="fix(pi-flow): external worktree"\n'
  deps.herdrWorktreeList = async () => [
    {
      path: WORKTREE,
      branch: BRANCH,
      label: BRANCH,
      workspaceId: 'w1',
      isLinked: true,
    },
  ]

  const result = await resolveReviewWorktree('PMR-ABC1', deps)

  assert.deepEqual(result, {
    path: WORKTREE,
    branch: BRANCH,
    source: 'herdr',
  })
})

test('resolveReviewWorktree: external worktree from a different repository is rejected', async () => {
  const deps = externalWorktreeDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-ABC1',
    path: WORKTREE,
    branch: BRANCH,
  })
  const baseExec = deps.exec
  deps.exec = async (cmd, args, opts) => {
    if (args.includes('--git-common-dir') && args[1] === WORKTREE) {
      return { code: 0, stdout: '/other/repo/.git\n', stderr: '' }
    }
    return baseExec(cmd, args, opts)
  }

  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /different repository/,
  )
})

test('resolveReviewWorktree: external worktree branch mismatch is rejected', async () => {
  const deps = externalWorktreeDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-ABC1',
    path: WORKTREE,
    branch: 'fix/expected-branch',
  })

  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /branch mismatch: expected fix\/expected-branch, HEAD is fix\/external-worktree/,
  )
})
