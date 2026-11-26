// AIDEV-NOTE: PMR-7B8M unit tests for server/staleness.ts — the session-side
// daemon staleness verdict, the git seams, and the warning text. All edges are
// faked: StalenessDeps closures return fixed verdicts, StalenessExec returns
// recorded {stdout, code} shapes or throws. Expected strings are independent
// literals (never recomputed through the implementation) because the message
// text is a contract shared with the reconcile and notify surfaces (1.3/1.4).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProbeResult } from '../server/lifecycle.ts'
import {
  checkDaemonStaleness,
  type DaemonStaleness,
  daemonStalenessMessage,
  mergeBaseIsAncestor,
  resolveHeadSha,
  type StalenessDeps,
  type StalenessExec,
  sessionStalenessDeps,
  warnDaemonStaleness,
} from '../server/staleness.ts'

const PID = 4242
const DAEMON_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
/** 40 characters, valid length, NOT lowercase hex. */
const NOT_HEX_SHA = 'Z'.repeat(40)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeDepsResult {
  deps: StalenessDeps
  calls: string[]
}

/** Fake deps with a probe: alive pidfile carrying DAEMON_SHA, HEAD_SHA repo,
 *  ancestor verdict defaulting to true (fresh). */
function fakeDeps(input: {
  probe?: ProbeResult
  head?: string | null
  ancestor?: boolean | null
}): FakeDepsResult {
  let probe: ProbeResult = { alive: true, pid: PID, gitSha: DAEMON_SHA }
  if (input.probe !== undefined) {
    probe = input.probe
  }
  let head: string | null = HEAD_SHA
  if (input.head !== undefined) {
    head = input.head
  }
  let ancestor: boolean | null = true
  if (input.ancestor !== undefined) {
    ancestor = input.ancestor
  }
  const calls: string[] = []
  return {
    calls,
    deps: {
      probe: async () => {
        calls.push('probe')
        return probe
      },
      headSha: async () => {
        calls.push('headSha')
        return head
      },
      isAncestor: async (daemonSha: string, headSha: string) => {
        calls.push(`isAncestor:${daemonSha}:${headSha}`)
        return ancestor
      },
    },
  }
}

interface FakeExecResult {
  exec: StalenessExec
  calls: Array<{
    command: string
    args: string[]
    options?: { cwd?: string }
  }>
}

/** Fake pi.exec-shaped seam: returns one canned result, or throws. */
function fakeExec(input: {
  stdout?: string
  code?: number
  throws?: string
}): FakeExecResult {
  const calls: FakeExecResult['calls'] = []
  const exec: StalenessExec = async (command, args, options) => {
    calls.push({ command, args, options })
    if (input.throws !== undefined) {
      throw new Error(input.throws)
    }
    let stdout = ''
    if (input.stdout !== undefined) {
      stdout = input.stdout
    }
    let code = 0
    if (input.code !== undefined) {
      code = input.code
    }
    return { stdout, code }
  }
  return { exec, calls }
}

// ---------------------------------------------------------------------------
// checkDaemonStaleness — decision matrix
// ---------------------------------------------------------------------------

test('staleness: HEAD descends from daemon SHA (ancestor=true) → fresh', async () => {
  const { deps, calls } = fakeDeps({ ancestor: true })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'fresh' })
  // Ancestry must be asked daemon→head, not the other way around: reversing
  // the arguments would invert the verdict.
  assert.deepEqual(calls, [
    'headSha',
    'probe',
    `isAncestor:${DAEMON_SHA}:${HEAD_SHA}`,
  ])
})

test('staleness: HEAD does not descend (ancestor=false) → stale with pid + both SHAs', async () => {
  const { deps } = fakeDeps({ ancestor: false })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, {
    kind: 'stale',
    pid: PID,
    daemonSha: DAEMON_SHA,
    headSha: HEAD_SHA,
  })
})

test('staleness: merge-base cannot judge (ancestor=null) → unknown/git-error', async () => {
  const { deps } = fakeDeps({ ancestor: null })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'git-error' })
})

test('staleness: alive pidfile without gitSha → unknown/no-gitsha', async () => {
  const { deps, calls } = fakeDeps({
    probe: { alive: true, pid: PID },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'no-gitsha' })
  // Nothing to compare against — ancestry must never be probed here.
  assert.deepEqual(calls, ['headSha', 'probe'])
})

test('staleness: daemon not alive → unchecked/daemon-not-running, no git calls', async () => {
  const probes: ProbeResult[] = [
    { alive: false, reason: 'no-pidfile' },
    { alive: false, reason: 'dead-process', pid: PID },
    { alive: false, reason: 'malformed-pidfile' },
    { alive: false, reason: 'version-mismatch', pid: PID },
  ]
  for (const probe of probes) {
    const { deps, calls } = fakeDeps({ probe })
    const got = await checkDaemonStaleness(deps)
    assert.deepEqual(got, { kind: 'unchecked', reason: 'daemon-not-running' })
    assert.deepEqual(calls, ['headSha', 'probe'])
  }
})

test('staleness: no resolvable HEAD (outside a repo) → unchecked/no-repo, probe skipped', async () => {
  const { deps, calls } = fakeDeps({ head: null })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-repo' })
  // HEAD is resolved first: with no checkout there is nothing to compare,
  // so the pidfile is never read.
  assert.deepEqual(calls, ['headSha'])
})

test('staleness: no-repo wins over a dead daemon (check order is pinned)', async () => {
  const { deps } = fakeDeps({
    head: null,
    probe: { alive: false, reason: 'no-pidfile' },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-repo' })
})

test('staleness: an empty-string gitSha in the pidfile is treated as no-gitsha', async () => {
  // parsePidfile keeps any string, so staleness must not treat '' as a SHA.
  const { deps, calls } = fakeDeps({
    probe: { alive: true, pid: PID, gitSha: '' },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'no-gitsha' })
  assert.deepEqual(calls, ['headSha', 'probe'])
})

// ---------------------------------------------------------------------------
// daemonStalenessMessage — the single source for all warning surfaces
// ---------------------------------------------------------------------------

test('message: stale verdict names both short SHAs and the kill command', async () => {
  const got = daemonStalenessMessage({
    kind: 'stale',
    pid: PID,
    daemonSha: DAEMON_SHA,
    headSha: HEAD_SHA,
  })
  assert.equal(
    got,
    'daemon is running stale code — started from aaaaaaa, this checkout is at bbbbbbb. Restart: kill 4242 — the daemon is re-ensured at the next /flow start.',
  )
  if (got === null) {
    assert.fail('stale verdict must produce warning text')
  }
  // Acceptance keywords (ISC-2) — pinned separately from the exact text so a
  // reword that drops one still fails loudly here.
  assert.ok(got.includes('kill 4242'))
  assert.ok(got.includes('aaaaaaa'))
  assert.ok(got.includes('bbbbbbb'))
  assert.ok(got.includes('re-ensured at the next /flow start'))
})

test('message: no-gitsha verdict says predates staleness tracking + restart recommended', async () => {
  const got = daemonStalenessMessage({
    kind: 'unknown',
    pid: PID,
    reason: 'no-gitsha',
  })
  assert.equal(
    got,
    'daemon predates staleness tracking (pidfile has no git SHA) — restart recommended: kill 4242 — the daemon is re-ensured at the next /flow start.',
  )
  if (got === null) {
    assert.fail('no-gitsha verdict must produce warning text')
  }
  // Acceptance keywords (ISC-4).
  assert.ok(got.includes('predates staleness tracking'))
  assert.ok(got.includes('restart recommended'))
  assert.ok(got.includes('kill 4242'))
})

test('message: fresh, git-error and unchecked verdicts produce nothing', async () => {
  const silent: DaemonStaleness[] = [
    { kind: 'fresh' },
    { kind: 'unknown', pid: PID, reason: 'git-error' },
    { kind: 'unchecked', reason: 'daemon-not-running' },
    { kind: 'unchecked', reason: 'no-repo' },
  ]
  for (const st of silent) {
    assert.equal(daemonStalenessMessage(st), null)
  }
})

test('message: full 40-hex SHAs are never printed, only the 7-char prefix', async () => {
  const got = daemonStalenessMessage({
    kind: 'stale',
    pid: PID,
    daemonSha: DAEMON_SHA,
    headSha: HEAD_SHA,
  })
  if (got === null) {
    assert.fail('stale verdict must produce warning text')
  }
  assert.ok(!got.includes(DAEMON_SHA))
  assert.ok(!got.includes(HEAD_SHA))
})

// ---------------------------------------------------------------------------
// resolveHeadSha
// ---------------------------------------------------------------------------

test('resolveHeadSha: 40-hex stdout (with newline) → the SHA', async () => {
  const { exec, calls } = fakeExec({ stdout: `${HEAD_SHA}\n` })
  assert.equal(await resolveHeadSha(exec), HEAD_SHA)
  assert.deepEqual(calls, [
    { command: 'git', args: ['rev-parse', 'HEAD'], options: {} },
  ])
})

test('resolveHeadSha: cwd is forwarded to exec', async () => {
  const { exec, calls } = fakeExec({ stdout: `${HEAD_SHA}\n` })
  await resolveHeadSha(exec, '/tmp/checkout')
  assert.deepEqual(calls[0]?.options, { cwd: '/tmp/checkout' })
})

test('resolveHeadSha: short output is not a HEAD → null', async () => {
  const { exec } = fakeExec({ stdout: 'abc1234\n' })
  assert.equal(await resolveHeadSha(exec), null)
})

test('resolveHeadSha: wrong alphabet (uppercase) → null', async () => {
  const { exec } = fakeExec({ stdout: `${NOT_HEX_SHA}\n` })
  assert.equal(await resolveHeadSha(exec), null)
})

test('resolveHeadSha: git failure text is not a SHA → null', async () => {
  const { exec } = fakeExec({
    stdout:
      'fatal: not a git repository (or any of the parent directories): .git\n',
    code: 128,
  })
  assert.equal(await resolveHeadSha(exec), null)
})

test('resolveHeadSha: exec throwing (missing git binary) → null, never throws', async () => {
  const { exec } = fakeExec({ throws: 'ENOENT: git' })
  assert.equal(await resolveHeadSha(exec), null)
})

// ---------------------------------------------------------------------------
// mergeBaseIsAncestor
// ---------------------------------------------------------------------------

test('mergeBaseIsAncestor: exit 0 → true, args in daemon-then-head order', async () => {
  const { exec, calls } = fakeExec({ code: 0 })
  assert.equal(await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA), true)
  assert.deepEqual(calls, [
    {
      command: 'git',
      args: ['merge-base', '--is-ancestor', DAEMON_SHA, HEAD_SHA],
      options: {},
    },
  ])
})

test('mergeBaseIsAncestor: exit 1 → false', async () => {
  const { exec } = fakeExec({ code: 1 })
  assert.equal(await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA), false)
})

test('mergeBaseIsAncestor: exit 128 → null (cannot judge, stays silent)', async () => {
  const { exec } = fakeExec({
    stdout: '',
    code: 128,
  })
  assert.equal(await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA), null)
})

test('mergeBaseIsAncestor: any other non-zero exit → null', async () => {
  const { exec } = fakeExec({ code: 2 })
  assert.equal(await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA), null)
})

test('mergeBaseIsAncestor: exec throwing → null, never throws', async () => {
  const { exec } = fakeExec({ throws: 'spawn git EACCES' })
  assert.equal(await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA), null)
})

test('mergeBaseIsAncestor: cwd is forwarded to exec', async () => {
  const { exec, calls } = fakeExec({ code: 0 })
  await mergeBaseIsAncestor(exec, DAEMON_SHA, HEAD_SHA, '/tmp/checkout')
  assert.deepEqual(calls[0]?.options, { cwd: '/tmp/checkout' })
})

// ---------------------------------------------------------------------------
// sessionStalenessDeps — wiring
// ---------------------------------------------------------------------------

test('sessionDeps: headSha and isAncestor run through the injected exec with cwd', async () => {
  const { exec, calls } = fakeExec({ stdout: `${HEAD_SHA}\n`, code: 0 })
  const deps = sessionStalenessDeps(exec, '/tmp/fake-agent', '/tmp/checkout')
  assert.equal(await deps.headSha(), HEAD_SHA)
  assert.equal(await deps.isAncestor(DAEMON_SHA, HEAD_SHA), true)
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['rev-parse', 'HEAD'],
      ['merge-base', '--is-ancestor', DAEMON_SHA, HEAD_SHA],
    ],
  )
  assert.deepEqual(calls[0]?.options, { cwd: '/tmp/checkout' })
  assert.deepEqual(calls[1]?.options, { cwd: '/tmp/checkout' })
})

test('sessionDeps: probe reads the pidfile under the given agent dir (missing → not alive)', async () => {
  const { exec } = fakeExec({ stdout: `${HEAD_SHA}\n` })
  const deps = sessionStalenessDeps(
    exec,
    '/tmp/pi-flow-staleness-test-missing-agent-dir',
  )
  const probe = await deps.probe()
  assert.equal(probe.alive, false)
})

// ---------------------------------------------------------------------------
// warnDaemonStaleness — probe + notify
// ---------------------------------------------------------------------------

test('warn: stale verdict notifies once with the pi-flow prefix at warning level', async () => {
  const { deps } = fakeDeps({ ancestor: false })
  const notes: Array<{ message: string; level: string }> = []
  await warnDaemonStaleness(deps, (message, level) => {
    notes.push({ message, level })
  })
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.level, 'warning')
  assert.equal(
    notes[0]?.message,
    'pi-flow: daemon is running stale code — started from aaaaaaa, this checkout is at bbbbbbb. Restart: kill 4242 — the daemon is re-ensured at the next /flow start.',
  )
})

test('warn: no-gitsha verdict notifies with the restart-recommended text', async () => {
  const { deps } = fakeDeps({ probe: { alive: true, pid: PID } })
  const notes: Array<{ message: string; level: string }> = []
  await warnDaemonStaleness(deps, (message, level) => {
    notes.push({ message, level })
  })
  assert.deepEqual(notes, [
    {
      level: 'warning',
      message:
        'pi-flow: daemon predates staleness tracking (pidfile has no git SHA) — restart recommended: kill 4242 — the daemon is re-ensured at the next /flow start.',
    },
  ])
})

test('warn: fresh, git-error and unchecked verdicts notify nothing', async () => {
  // Every silent shape from the decision matrix — none of them may produce a
  // notification (ISC-5 fresh, ISC-7 git-error, dead daemon / no repo silent).
  const silent: Array<Parameters<typeof fakeDeps>[0]> = [
    { ancestor: true },
    { ancestor: null },
    { probe: { alive: false, reason: 'no-pidfile' } },
    { probe: { alive: false, reason: 'version-mismatch', pid: PID } },
    { probe: { alive: false, reason: 'dead-process', pid: PID } },
    { probe: { alive: false, reason: 'malformed-pidfile' } },
    { head: null },
  ]
  for (const input of silent) {
    const { deps } = fakeDeps(input)
    const notes: string[] = []
    await warnDaemonStaleness(deps, (message) => {
      notes.push(message)
    })
    assert.deepEqual(notes, [])
  }
})

test('warn: a throwing exec (broken git) stays silent and does not reject', async () => {
  const { exec } = fakeExec({ throws: 'ENOENT: git' })
  const deps = sessionStalenessDeps(
    exec,
    '/tmp/pi-flow-staleness-test-missing-agent-dir',
  )
  const notes: string[] = []
  await warnDaemonStaleness(deps, (message) => {
    notes.push(message)
  })
  assert.deepEqual(notes, [])
})
