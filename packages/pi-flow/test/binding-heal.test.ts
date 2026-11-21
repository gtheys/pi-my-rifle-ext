import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { healFlowBinding, recoveryCommand } from '../flow/binding-heal.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
  setBindingChangeListener,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import type { ReviewDeps } from '../tools/code-review-parse.ts'

// AIDEV-NOTE: PMR-DRKH — flow binding state is module-global; reset after
// every test so a failing assertion cannot leak a ref/binding into later tests.
afterEach(() => {
  setActiveFlowRef(null)
  setBindingChangeListener(null)
})

const NOTE_FIXTURE = `notes for PMR-ABC1

note id=n1 author=pi at=2026-01-01
body<<EOF
worktree: /repo/.worktrees/feat-a
branch: feat/alpha
EOF
`

function baseDeps(): ReviewDeps {
  return {
    getFlowWorktree: () => getFlowWorktree(),
    avenShowFull: async () => NOTE_FIXTURE,
    herdrWorktreeList: async () => [],
    exec: async (_cmd, args) => {
      if (args.includes('--git-common-dir')) {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' }
      }
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: 'feat/alpha\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: () => true,
    repoRoot: '/repo',
  }
}

test('heal: rebinds the resolved worktree when no live ref exists', async () => {
  const snapshots: unknown[] = []
  setBindingChangeListener((snapshot) => {
    snapshots.push(snapshot)
  })
  const result = await healFlowBinding('PMR-ABC1', baseDeps())
  assert.ok(result.ok)
  assert.equal(result.healed, true)
  assert.deepEqual(result.worktree, {
    path: '/repo/.worktrees/feat-a',
    branch: 'feat/alpha',
    source: 'note',
  })
  assert.equal(getActiveFlowRef(), 'PMR-ABC1')
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-ABC1',
    path: '/repo/.worktrees/feat-a',
    branch: 'feat/alpha',
  })
  assert.equal(snapshots.length, 2)
})

test('heal: live ref is a DIFFERENT ref — resolves ok, mutates nothing', async () => {
  setActiveFlowRef('PMR-OTHER')
  const result = await healFlowBinding('PMR-ABC1', baseDeps())
  assert.ok(result.ok)
  assert.equal(result.healed, false)
  assert.equal(getActiveFlowRef(), 'PMR-OTHER')
  assert.equal(getFlowWorktree(), null)
})

test('heal: same ref already correctly bound — idempotent, no mutation', async () => {
  setActiveFlowRef('PMR-ABC1')
  assert.equal(setFlowWorktree('/repo/.worktrees/feat-a', 'feat/alpha'), true)
  let notified = 0
  setBindingChangeListener(() => {
    notified += 1
  })
  const result = await healFlowBinding('PMR-ABC1', baseDeps())
  assert.ok(result.ok)
  assert.equal(result.healed, false)
  assert.equal(notified, 0)
  assert.deepEqual(getFlowWorktree(), {
    ref: 'PMR-ABC1',
    path: '/repo/.worktrees/feat-a',
    branch: 'feat/alpha',
  })
})

test('heal: resolver failure — ok:false, reason + recovery, nothing mutated', async () => {
  setActiveFlowRef('PMR-ABC1')
  const deps = baseDeps()
  deps.avenShowFull = async () => ''
  const result = await healFlowBinding('PMR-ABC1', deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /no worktree found for PMR-ABC1/)
    assert.equal(result.recovery, '/flow PMR-ABC1')
  }
  assert.equal(getActiveFlowRef(), 'PMR-ABC1')
  assert.equal(getFlowWorktree(), null)
})

test('recoveryCommand: returns the /flow command text', () => {
  assert.equal(recoveryCommand('PMR-ABC1'), '/flow PMR-ABC1')
})
