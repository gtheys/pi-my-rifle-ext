import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { healFlowBinding, recoveryCommand } from '../flow/binding-heal.ts'
import { type DurableRefDeps, deriveFlowRefs } from '../flow/durable-refs.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
  setBindingChangeListener,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import type { FlowRunEvent } from '../run-state.ts'
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

// AIDEV-NOTE: PMR-DRKH — deriveFlowRefs scans pending records for live,
// repo-matching refs. Sorted parked-before-active; never throws.
describe('deriveFlowRefs', () => {
  const PENDING_DIR = '/agent/pi-flow/pending'
  const GIT_ROOT = '/repo'

  function runStartEvent(ref: string) {
    return {
      kind: 'run-start' as const,
      at: '2026-11-20T00:00:00Z',
      ref,
      mode: 'work' as const,
    }
  }

  function inputEvent(ref: string, gitRoot: string) {
    return {
      kind: 'run-input' as const,
      at: '2026-11-20T00:01:00Z',
      ref,
      input: { mode: 'work' as const, gitRoot, workRoots: [] },
    }
  }

  function loopEvent(
    ref: string,
    status: 'running' | 'paused' | 'halted' | 'done',
    awaitingOutcome: boolean,
  ) {
    return {
      kind: 'loop-state' as const,
      at: '2026-11-20T00:02:00Z',
      ref,
      loop: {
        phase: 'implement' as const,
        awaitingOutcome,
        blockerRetries: 0,
        validateStartedAt: '2026-11-20T00:00:00Z',
        status,
      },
    }
  }

  function makeDeps(overrides?: {
    names?: string[]
    journals?: Record<string, unknown[]>
    readdirThrows?: boolean
  }) {
    const journals = overrides?.journals ?? {}
    const deps: DurableRefDeps = {
      pendingDir: PENDING_DIR,
      agentDir: '/agent',
      gitRoot: GIT_ROOT,
      io: {
        readdir: async () => {
          if (overrides?.readdirThrows === true) {
            throw new Error('boom')
          }
          return overrides?.names ?? []
        },
        readFile: async (p) => {
          const m = /\/([^/]+)\.journal\.jsonl$/.exec(p)
          if (m === null) throw new Error(`unexpected path ${p}`)
          const events = journals[m[1]]
          if (events === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          }
          return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
        },
      },
      readRunEvents: async (agentDir, ref, maybeIo) => {
        const io = maybeIo ?? {
          readFile: async () => {
            throw new Error('no io provided')
          },
        }
        const journalPath = `${agentDir}/pi-flow/runs/${ref}.journal.jsonl`
        let raw: string
        try {
          raw = await io.readFile(journalPath)
        } catch {
          return null
        }
        const events: FlowRunEvent[] = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length === 0) continue
          try {
            events.push(JSON.parse(trimmed) as FlowRunEvent)
          } catch {
            // torn/corrupt line — skipped, mirrors the real journal reader
          }
        }
        return events
      },
    }
    return deps
  }

  test('keeps refs whose latest input gitRoot matches and loop is non-terminal', async () => {
    const refs = await deriveFlowRefs(
      makeDeps({
        names: ['PMR-LIVE.json', 'PMR-GONE.json'],
        journals: {
          'PMR-LIVE': [
            runStartEvent('PMR-LIVE'),
            inputEvent('PMR-LIVE', GIT_ROOT),
            loopEvent('PMR-LIVE', 'running', false),
          ],
          'PMR-GONE': [
            runStartEvent('PMR-GONE'),
            inputEvent('PMR-GONE', '/other-repo'),
            loopEvent('PMR-GONE', 'running', false),
          ],
        },
      }),
    )
    assert.deepEqual(refs, ['PMR-LIVE'])
  })

  test('skips consumed records', async () => {
    const refs = await deriveFlowRefs(
      makeDeps({
        names: ['PMR-LIVE.json', 'PMR-OLD.consumed.json'],
        journals: {
          'PMR-LIVE': [
            runStartEvent('PMR-LIVE'),
            inputEvent('PMR-LIVE', GIT_ROOT),
            loopEvent('PMR-LIVE', 'paused', false),
          ],
          'PMR-OLD': [
            runStartEvent('PMR-OLD'),
            inputEvent('PMR-OLD', GIT_ROOT),
            loopEvent('PMR-OLD', 'running', true),
          ],
        },
      }),
    )
    assert.deepEqual(refs, ['PMR-LIVE'])
  })

  test('excludes terminal runs (halted/done)', async () => {
    const refs = await deriveFlowRefs(
      makeDeps({
        names: ['PMR-HALT.json', 'PMR-DONE.json', 'PMR-LIVE.json'],
        journals: {
          'PMR-HALT': [
            runStartEvent('PMR-HALT'),
            inputEvent('PMR-HALT', GIT_ROOT),
            loopEvent('PMR-HALT', 'halted', false),
          ],
          'PMR-DONE': [
            runStartEvent('PMR-DONE'),
            inputEvent('PMR-DONE', GIT_ROOT),
            loopEvent('PMR-DONE', 'done', false),
          ],
          'PMR-LIVE': [
            runStartEvent('PMR-LIVE'),
            inputEvent('PMR-LIVE', GIT_ROOT),
            loopEvent('PMR-LIVE', 'running', false),
          ],
        },
      }),
    )
    assert.deepEqual(refs, ['PMR-LIVE'])
  })

  test('sorts parked (awaitingOutcome) before paused/running', async () => {
    const refs = await deriveFlowRefs(
      makeDeps({
        names: ['PMR-ACTIVE.json', 'PMR-PARKED.json'],
        journals: {
          'PMR-ACTIVE': [
            runStartEvent('PMR-ACTIVE'),
            inputEvent('PMR-ACTIVE', GIT_ROOT),
            loopEvent('PMR-ACTIVE', 'running', false),
          ],
          'PMR-PARKED': [
            runStartEvent('PMR-PARKED'),
            inputEvent('PMR-PARKED', GIT_ROOT),
            loopEvent('PMR-PARKED', 'running', true),
          ],
        },
      }),
    )
    assert.deepEqual(refs, ['PMR-PARKED', 'PMR-ACTIVE'])
  })

  test('skips candidates with missing journals (ENOENT)', async () => {
    const refs = await deriveFlowRefs(
      makeDeps({
        names: ['PMR-LIVE.json', 'PMR-NOJOURNAL.json'],
        journals: {
          'PMR-LIVE': [
            runStartEvent('PMR-LIVE'),
            inputEvent('PMR-LIVE', GIT_ROOT),
            loopEvent('PMR-LIVE', 'paused', false),
          ],
        },
      }),
    )
    assert.deepEqual(refs, ['PMR-LIVE'])
  })

  test('skips candidates with corrupt journal JSON', async () => {
    const deps = makeDeps({
      names: ['PMR-LIVE.json', 'PMR-CORRUPT.json'],
      journals: {
        'PMR-LIVE': [
          runStartEvent('PMR-LIVE'),
          inputEvent('PMR-LIVE', GIT_ROOT),
          loopEvent('PMR-LIVE', 'paused', false),
        ],
      },
    })
    const origReadFile = deps.io.readFile
    deps.io.readFile = async (p) => {
      if (p.endsWith('PMR-CORRUPT.journal.jsonl')) {
        return '{not json\n'
      }
      return origReadFile(p)
    }
    const refs = await deriveFlowRefs(deps)
    assert.deepEqual(refs, ['PMR-LIVE'])
  })

  test('never throws — readdir failure yields an empty list', async () => {
    const refs = await deriveFlowRefs(makeDeps({ readdirThrows: true }))
    assert.deepEqual(refs, [])
  })
})
