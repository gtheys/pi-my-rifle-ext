// AIDEV-NOTE: PMR-0KMQ — the deviation gate's cwd must be the VERIFIED bound
// flow worktree (resolveReviewWorktree: binding → aven note → herdr, each
// candidate verified per PMR-9XR0), never the raw binding path (PMR-7ZEE) or
// a silent ctx.cwd fallback. Mirrors test/code-review-external-worktree.test.ts:
// fake ReviewDeps, no real git.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReviewDeps } from '../tools/code-review-parse.ts'
import { resolveDeviationCwd } from '../tools/deviation.ts'

const REPO_ROOT = '/repo/main'
const WORKTREE = '/worktrees/fix-external-worktree'
const COMMON_GIT_DIR = '/repo/main/.git'
const FOREIGN_COMMON_DIR = '/elsewhere/.git'
const BRANCH = 'fix/external-worktree'
const REF = 'PMR-TEST1'

function depsWith(overrides?: {
  candidateCommonDir?: string
  headBranch?: string
}): ReviewDeps {
  const candidateCommonDir = overrides?.candidateCommonDir ?? COMMON_GIT_DIR
  const headBranch = overrides?.headBranch ?? BRANCH
  return {
    getFlowWorktree: () => null,
    avenShowFull: async () => '',
    herdrWorktreeList: async () => [],
    exec: async (_cmd, args) => {
      if (args.includes('--git-common-dir')) {
        const probePath = args[1] ?? ''
        let dir = candidateCommonDir
        if (probePath === REPO_ROOT) {
          dir = COMMON_GIT_DIR
        }
        return { code: 0, stdout: `${dir}\n`, stderr: '' }
      }
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: `${headBranch}\n`, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: () => true,
    repoRoot: REPO_ROOT,
  }
}

test('resolveDeviationCwd: binding source resolves the verified worktree cwd', async () => {
  const deps = depsWith()
  deps.getFlowWorktree = () => ({
    ref: REF,
    path: WORKTREE,
    branch: BRANCH,
  })

  const result = await resolveDeviationCwd(REF, deps)

  assert.deepEqual(result, { ok: true, cwd: WORKTREE })
})

test('resolveDeviationCwd: aven note source resolves the verified worktree cwd', async () => {
  const deps = depsWith()
  deps.avenShowFull = async () => `note id=n1
body<<EOF
worktree: ${WORKTREE}
branch: ${BRANCH}
EOF
`

  const result = await resolveDeviationCwd(REF, deps)

  assert.deepEqual(result, { ok: true, cwd: WORKTREE })
})

test('resolveDeviationCwd: herdr source resolves the verified worktree cwd', async () => {
  // AIDEV-NOTE: PMR-902B — the title-derived herdr expectation is
  // ref-prefixed (`fix/<REF>-<slug>`), matching the branch createFlow makes
  // during a personal flow, so HEAD must echo that branch to verify.
  const herdrBranch = 'fix/PMR-TEST1-external-worktree'
  const deps = depsWith({ headBranch: herdrBranch })
  deps.avenShowFull = async () =>
    'PMR-TEST1 status=todo title="fix(pi-flow): external worktree"\n'
  deps.herdrWorktreeList = async () => [
    {
      path: WORKTREE,
      branch: herdrBranch,
      label: herdrBranch,
      workspaceId: 'w1',
      isLinked: true,
    },
  ]

  const result = await resolveDeviationCwd(REF, deps)

  assert.deepEqual(result, { ok: true, cwd: WORKTREE })
})

test('resolveDeviationCwd: foreign-repo candidate is rejected with the resolver reason', async () => {
  const deps = depsWith({ candidateCommonDir: FOREIGN_COMMON_DIR })
  deps.getFlowWorktree = () => ({
    ref: REF,
    path: WORKTREE,
    branch: BRANCH,
  })

  const result = await resolveDeviationCwd(REF, deps)

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /belongs to a different repository/)
    assert.match(result.reason, new RegExp(WORKTREE.replaceAll('/', '\\/')))
  }
})

test('resolveDeviationCwd: branch-mismatch candidate is rejected with the resolver reason', async () => {
  const deps = depsWith({ headBranch: 'some/other-branch' })
  deps.getFlowWorktree = () => ({
    ref: REF,
    path: WORKTREE,
    branch: BRANCH,
  })

  const result = await resolveDeviationCwd(REF, deps)

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /branch mismatch/)
    assert.match(result.reason, /expected fix\/external-worktree/)
  }
})
