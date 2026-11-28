import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type DurableRefDeps,
  deriveFlowRefs,
  deriveParkedCandidates,
} from '../flow/durable-refs.ts'
import { readRunEvents } from '../run-state.ts'

// AIDEV-NOTE: PMR-T9ZQ — rich candidate derivation for the parked-run resume
// picker. deriveParkedCandidates must share ONE scan with deriveFlowRefs, so
// these tests pin the mapping (phase/status/updatedAt/owner/hasWorktree),
// the shared base filters and parked-first order (the PMR-RRW9 bind-only
// owner filter is covered separately below). The fake io mirrors the
// real journal layout (<agentDir>/pi-flow/runs/<ref>.journal.jsonl) and the
// production readRunEvents is used unmodified — the picker reads the same
// projection the daemon writes.
const PENDING_DIR = '/agent/pi-flow/pending'
const AGENT_DIR = '/agent'
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

function phaseStartEvent(ref: string, phase: 'plan' | 'implement') {
  return {
    kind: 'phase-start' as const,
    at: '2026-11-20T00:02:00Z',
    ref,
    phase,
  }
}

function loopEvent(
  ref: string,
  status: 'running' | 'paused' | 'halted' | 'done',
  awaitingOutcome: boolean,
) {
  return {
    kind: 'loop-state' as const,
    at: '2026-11-20T00:03:00Z',
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

function effectDeclarationEvent(
  ref: string,
  effect: 'worktree-create' | 'git-push',
  effectId: string,
) {
  return {
    kind: 'effect-declaration' as const,
    at: '2026-11-20T00:04:00Z',
    ref,
    effect,
    effectId,
    command: `git ${effect}`,
    recipe: ['git', effect],
  }
}

function ownerSessionEvent(ref: string) {
  return ownerSessionEventFor(ref, '/agent/sessions/main.jsonl', 4242)
}

function ownerSessionEventFor(
  ref: string,
  sessionFile: string | null,
  pid: number,
) {
  return {
    kind: 'owner-session' as const,
    at: '2026-11-20T00:05:00Z',
    ref,
    sessionFile,
    pid,
  }
}

type Journal = Record<string, unknown[]>

function makeDeps(
  journals: Journal,
  options?: {
    readdirThrows?: boolean
    callerSessionFile?: string | null
    callerPid?: number
    pidAlive?: (pid: number) => boolean
  },
) {
  const deps: DurableRefDeps = {
    pendingDir: PENDING_DIR,
    agentDir: AGENT_DIR,
    gitRoot: GIT_ROOT,
    callerSessionFile: options?.callerSessionFile,
    callerPid: options?.callerPid,
    pidAlive: options?.pidAlive,
    io: {
      readdir: async () => {
        if (options?.readdirThrows === true) {
          throw new Error('boom')
        }
        return Object.keys(journals).map((ref) => `${ref}.json`)
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
    readRunEvents,
  }
  return deps
}

describe('deriveParkedCandidates', () => {
  test('maps phase, status, updatedAt, owner and hasWorktree for a parked run', async () => {
    const candidates = await deriveParkedCandidates(
      makeDeps({
        'PMR-PARKED': [
          runStartEvent('PMR-PARKED'),
          inputEvent('PMR-PARKED', GIT_ROOT),
          phaseStartEvent('PMR-PARKED', 'implement'),
          loopEvent('PMR-PARKED', 'running', true),
          effectDeclarationEvent('PMR-PARKED', 'worktree-create', 'e1'),
          ownerSessionEvent('PMR-PARKED'),
        ],
      }),
    )
    assert.deepEqual(candidates, [
      {
        ref: 'PMR-PARKED',
        phase: 'implement',
        status: 'running',
        updatedAt: '2026-11-20T00:04:00Z',
        hasWorktree: true,
        owner: {
          sessionFile: '/agent/sessions/main.jsonl',
          pid: 4242,
          at: '2026-11-20T00:05:00Z',
        },
      },
    ])
  })

  test('hasWorktree is false without any effect declaration', async () => {
    const candidates = await deriveParkedCandidates(
      makeDeps({
        'PMR-NOWT': [
          runStartEvent('PMR-NOWT'),
          inputEvent('PMR-NOWT', GIT_ROOT),
          phaseStartEvent('PMR-NOWT', 'plan'),
          loopEvent('PMR-NOWT', 'paused', false),
        ],
      }),
    )
    assert.deepEqual(candidates, [
      {
        ref: 'PMR-NOWT',
        phase: 'plan',
        status: 'paused',
        updatedAt: '2026-11-20T00:03:00Z',
        hasWorktree: false,
      },
    ])
  })

  test('hasWorktree is false when only other effects were declared', async () => {
    const candidates = await deriveParkedCandidates(
      makeDeps({
        'PMR-PUSH': [
          runStartEvent('PMR-PUSH'),
          inputEvent('PMR-PUSH', GIT_ROOT),
          phaseStartEvent('PMR-PUSH', 'implement'),
          loopEvent('PMR-PUSH', 'running', true),
          effectDeclarationEvent('PMR-PUSH', 'git-push', 'e2'),
        ],
      }),
    )
    assert.deepEqual(candidates, [
      {
        ref: 'PMR-PUSH',
        phase: 'implement',
        status: 'running',
        updatedAt: '2026-11-20T00:04:00Z',
        hasWorktree: false,
      },
    ])
  })

  test('owner is absent (no key) for runs journaled before the owner event', async () => {
    const candidates = await deriveParkedCandidates(
      makeDeps({
        'PMR-OLD': [
          runStartEvent('PMR-OLD'),
          inputEvent('PMR-OLD', GIT_ROOT),
          phaseStartEvent('PMR-OLD', 'implement'),
          loopEvent('PMR-OLD', 'running', true),
          effectDeclarationEvent('PMR-OLD', 'worktree-create', 'e3'),
        ],
      }),
    )
    assert.equal(candidates.length, 1)
    assert.equal('owner' in candidates[0], false)
    assert.deepEqual(Object.keys(candidates[0]).sort(), [
      'hasWorktree',
      'phase',
      'ref',
      'status',
      'updatedAt',
    ])
  })

  test('applies the same filters as deriveFlowRefs (gitRoot, terminal status)', async () => {
    const journals: Journal = {
      'PMR-PARKED': [
        runStartEvent('PMR-PARKED'),
        inputEvent('PMR-PARKED', GIT_ROOT),
        phaseStartEvent('PMR-PARKED', 'implement'),
        loopEvent('PMR-PARKED', 'running', true),
      ],
      'PMR-OTHER-REPO': [
        runStartEvent('PMR-OTHER-REPO'),
        inputEvent('PMR-OTHER-REPO', '/other-repo'),
        phaseStartEvent('PMR-OTHER-REPO', 'implement'),
        loopEvent('PMR-OTHER-REPO', 'running', true),
      ],
      'PMR-DONE': [
        runStartEvent('PMR-DONE'),
        inputEvent('PMR-DONE', GIT_ROOT),
        phaseStartEvent('PMR-DONE', 'implement'),
        loopEvent('PMR-DONE', 'done', false),
      ],
    }
    const candidates = await deriveParkedCandidates(makeDeps(journals))
    assert.deepEqual(
      candidates.map((c) => c.ref),
      ['PMR-PARKED'],
    )
    assert.deepEqual(
      candidates.map((c) => c.ref),
      await deriveFlowRefs(makeDeps(journals)),
    )
  })

  test('parked candidates sort before paused/running (same order as deriveFlowRefs)', async () => {
    const journals: Journal = {
      'PMR-ACTIVE': [
        runStartEvent('PMR-ACTIVE'),
        inputEvent('PMR-ACTIVE', GIT_ROOT),
        phaseStartEvent('PMR-ACTIVE', 'implement'),
        loopEvent('PMR-ACTIVE', 'running', false),
      ],
      'PMR-PAUSED': [
        runStartEvent('PMR-PAUSED'),
        inputEvent('PMR-PAUSED', GIT_ROOT),
        phaseStartEvent('PMR-PAUSED', 'plan'),
        loopEvent('PMR-PAUSED', 'paused', false),
      ],
      'PMR-PARKED': [
        runStartEvent('PMR-PARKED'),
        inputEvent('PMR-PARKED', GIT_ROOT),
        phaseStartEvent('PMR-PARKED', 'implement'),
        loopEvent('PMR-PARKED', 'running', true),
      ],
    }
    const candidates = await deriveParkedCandidates(makeDeps(journals))
    assert.deepEqual(
      candidates.map((c) => c.ref),
      ['PMR-PARKED', 'PMR-ACTIVE', 'PMR-PAUSED'],
    )
    assert.deepEqual(
      candidates.map((c) => c.ref),
      await deriveFlowRefs(makeDeps(journals)),
    )
  })

  test('skips candidates whose journal is missing and never throws on readdir failure', async () => {
    const candidates = await deriveParkedCandidates(
      makeDeps({
        'PMR-LIVE': [
          runStartEvent('PMR-LIVE'),
          inputEvent('PMR-LIVE', GIT_ROOT),
          phaseStartEvent('PMR-LIVE', 'implement'),
          loopEvent('PMR-LIVE', 'running', true),
        ],
        'PMR-NOJOURNAL': [],
      }),
    )
    assert.deepEqual(
      candidates.map((c) => c.ref),
      ['PMR-LIVE'],
    )
    assert.deepEqual(await deriveParkedCandidates(makeDeps({})), [])
    assert.deepEqual(
      await deriveParkedCandidates(
        makeDeps({ 'PMR-LIVE': [] }, { readdirThrows: true }),
      ),
      [],
    )
  })
})

// AIDEV-NOTE: PMR-RRW9 — bind-adoption is owner-scoped, the picker scan is
// not. deriveFlowRefs must skip pending records whose journaled owner is a
// LIVE session other than the caller (another session's live flow in the
// same repo is not a resume candidate), while dead-owner records (the
// cross-session restart case PMR-DRKH/PMR-T9ZQ were built for) and records
// owned by the calling session itself stay adoptable.
describe('deriveFlowRefs owner-scoped adoption', () => {
  test('skips a record owned by a live foreign session', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-FOREIGN': [
            runStartEvent('PMR-FOREIGN'),
            inputEvent('PMR-FOREIGN', GIT_ROOT),
            phaseStartEvent('PMR-FOREIGN', 'implement'),
            loopEvent('PMR-FOREIGN', 'running', false),
            ownerSessionEventFor(
              'PMR-FOREIGN',
              '/agent/sessions/other.jsonl',
              4242,
            ),
          ],
        },
        {
          callerSessionFile: '/agent/sessions/main.jsonl',
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, [])
  })

  test('still adopts a record whose owner pid is dead (restart case)', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-RESTART': [
            runStartEvent('PMR-RESTART'),
            inputEvent('PMR-RESTART', GIT_ROOT),
            phaseStartEvent('PMR-RESTART', 'implement'),
            loopEvent('PMR-RESTART', 'running', false),
            ownerSessionEventFor(
              'PMR-RESTART',
              '/agent/sessions/old.jsonl',
              4242,
            ),
          ],
        },
        {
          callerSessionFile: '/agent/sessions/main.jsonl',
          pidAlive: () => false,
        },
      ),
    )
    assert.deepEqual(refs, ['PMR-RESTART'])
  })

  test('still adopts a record owned by the calling session itself', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-SELF': [
            runStartEvent('PMR-SELF'),
            inputEvent('PMR-SELF', GIT_ROOT),
            phaseStartEvent('PMR-SELF', 'implement'),
            loopEvent('PMR-SELF', 'running', false),
            ownerSessionEventFor(
              'PMR-SELF',
              '/agent/sessions/main.jsonl',
              4242,
            ),
          ],
        },
        {
          callerSessionFile: '/agent/sessions/main.jsonl',
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, ['PMR-SELF'])
  })

  test('fail-closed: a live owner with no sessionFile is skipped', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-NOSESSION': [
            runStartEvent('PMR-NOSESSION'),
            inputEvent('PMR-NOSESSION', GIT_ROOT),
            phaseStartEvent('PMR-NOSESSION', 'implement'),
            loopEvent('PMR-NOSESSION', 'running', false),
            ownerSessionEventFor('PMR-NOSESSION', null, 4242),
          ],
        },
        {
          callerSessionFile: '/agent/sessions/main.jsonl',
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, [])
  })

  // AIDEV-NOTE: PMR-3N9N — self-owned headless exemption: a headless flow
  // journals owner.sessionFile null, so after a reload in the SAME process
  // the fail-closed rule above would refuse the caller's own live run. An
  // exact live self-PID match is the caller's identity proof; any other
  // live pid stays foreign.
  test('adopts a live self-owned headless run: null sessionFile, same pid as caller', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-SELFHEADLESS': [
            runStartEvent('PMR-SELFHEADLESS'),
            inputEvent('PMR-SELFHEADLESS', GIT_ROOT),
            phaseStartEvent('PMR-SELFHEADLESS', 'implement'),
            loopEvent('PMR-SELFHEADLESS', 'running', false),
            ownerSessionEventFor('PMR-SELFHEADLESS', null, 4242),
          ],
        },
        {
          callerSessionFile: null,
          callerPid: 4242,
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, ['PMR-SELFHEADLESS'])
  })

  test('fail-closed: a live headless owner with a different pid is skipped', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-FOREIGNHEADLESS': [
            runStartEvent('PMR-FOREIGNHEADLESS'),
            inputEvent('PMR-FOREIGNHEADLESS', GIT_ROOT),
            phaseStartEvent('PMR-FOREIGNHEADLESS', 'implement'),
            loopEvent('PMR-FOREIGNHEADLESS', 'running', false),
            ownerSessionEventFor('PMR-FOREIGNHEADLESS', null, 9999),
          ],
        },
        {
          callerSessionFile: null,
          callerPid: 4242,
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, [])
  })

  test('fail-closed: callerPid does not exempt a live owner with a foreign sessionFile', async () => {
    const refs = await deriveFlowRefs(
      makeDeps(
        {
          'PMR-FOREIGNFILE': [
            runStartEvent('PMR-FOREIGNFILE'),
            inputEvent('PMR-FOREIGNFILE', GIT_ROOT),
            phaseStartEvent('PMR-FOREIGNFILE', 'implement'),
            loopEvent('PMR-FOREIGNFILE', 'running', false),
            ownerSessionEventFor(
              'PMR-FOREIGNFILE',
              '/agent/sessions/other.jsonl',
              4242,
            ),
          ],
        },
        {
          callerSessionFile: '/agent/sessions/main.jsonl',
          callerPid: 4242,
          pidAlive: () => true,
        },
      ),
    )
    assert.deepEqual(refs, [])
  })

  test('deriveParkedCandidates keeps the wide scan for a foreign live owner', async () => {
    const journals: Journal = {
      'PMR-FOREIGN': [
        runStartEvent('PMR-FOREIGN'),
        inputEvent('PMR-FOREIGN', GIT_ROOT),
        phaseStartEvent('PMR-FOREIGN', 'implement'),
        loopEvent('PMR-FOREIGN', 'running', true),
        ownerSessionEventFor(
          'PMR-FOREIGN',
          '/agent/sessions/other.jsonl',
          4242,
        ),
      ],
    }
    const options = {
      callerSessionFile: '/agent/sessions/main.jsonl',
      pidAlive: () => true,
    }
    const candidates = await deriveParkedCandidates(makeDeps(journals, options))
    assert.deepEqual(
      candidates.map((c) => c.ref),
      ['PMR-FOREIGN'],
    )
    assert.deepEqual(await deriveFlowRefs(makeDeps(journals, options)), [])
  })
})
