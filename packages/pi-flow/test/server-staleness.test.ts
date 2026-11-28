// AIDEV-NOTE: PMR-7B8M rev 1 unit tests for server/staleness.ts — the
// session-side daemon staleness verdict (MAIN-checkout HEAD equality), the git
// seams, and the warning text. All edges are faked: StalenessDeps closures
// return fixed verdicts, StalenessExec returns recorded {stdout, code} shapes or
// throws. Expected strings are independent literals (never recomputed through
// the implementation) because the message text is a contract shared with the
// reconcile and notify surfaces (1.3/1.4).
// AIDEV-NOTE: PMR-7B8M rev 2 — the deps seam is `mainCheckout` (path + HEAD
// from ONE `git worktree list --porcelain` call), and the matrix gained the
// repo-identity guard: a daemon spawned from another repo, and a pidfile whose
// repo identity is unverifiable, are both SILENT (cross-repo false positives
// were the rev-1 blocker — the daemon is one global process serving every repo).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProbeResult } from '../server/lifecycle.ts'
import {
  checkDaemonStaleness,
  type DaemonStaleness,
  daemonStalenessMessage,
  type MainCheckout,
  resolveHeadSha,
  resolveMainCheckout,
  type StalenessDeps,
  type StalenessExec,
  sessionStalenessDeps,
  warnDaemonStaleness,
} from '../server/staleness.ts'

const PID = 4242
const DAEMON_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
/** The session repo's main worktree — the same literal the porcelain fixture
 *  below prints, so a fake probe and a fake exec agree about "this repo". */
const MAIN_PATH = '/repo/main'
/** Some OTHER repo's main worktree (cross-repo daemon, rev 2). */
const OTHER_PATH = '/home/user/Code/other-repo'
/** 40 characters, valid length, NOT lowercase hex. */
const NOT_HEX_SHA = 'Z'.repeat(40)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeDepsResult {
  deps: StalenessDeps
  calls: string[]
}

/** Fake deps with a probe: alive pidfile carrying DAEMON_SHA at MAIN_PATH, main
 *  checkout MAIN_PATH/HEAD_SHA (so the default verdict is STALE — main differs
 *  from the daemon SHA but the repo identity matches). */
function fakeDeps(
  input: { probe?: ProbeResult; mainCheckout?: MainCheckout | null } = {},
): FakeDepsResult {
  let probe: ProbeResult = {
    alive: true,
    pid: PID,
    gitSha: DAEMON_SHA,
    mainWorktree: MAIN_PATH,
  }
  if (input.probe !== undefined) {
    probe = input.probe
  }
  let main: MainCheckout | null = { path: MAIN_PATH, headSha: HEAD_SHA }
  if (input.mainCheckout !== undefined) {
    main = input.mainCheckout
  }
  const calls: string[] = []
  return {
    calls,
    deps: {
      probe: async () => {
        calls.push('probe')
        return probe
      },
      mainCheckout: async () => {
        calls.push('mainCheckout')
        return main
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

/** Multi-block `git worktree list --porcelain` fixture: main first, then a
 *  linked worktree (the realistic case for a session running in a worktree). */
function porcelain(mainSha: string, linkedSha: string): string {
  return [
    `worktree ${MAIN_PATH}`,
    `HEAD ${mainSha}`,
    'branch refs/heads/main',
    '',
    'worktree /repo/.wt/feature',
    `HEAD ${linkedSha}`,
    'detached',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// checkDaemonStaleness — decision matrix (rev 1: equality vs main HEAD;
// rev 2: repo identity is checked BEFORE the SHA verdict)
// ---------------------------------------------------------------------------

test('staleness: pidfile SHA equals main HEAD → fresh, silent', async () => {
  const { deps, calls } = fakeDeps({
    probe: {
      alive: true,
      pid: PID,
      gitSha: DAEMON_SHA,
      mainWorktree: MAIN_PATH,
    },
    mainCheckout: { path: MAIN_PATH, headSha: DAEMON_SHA },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'fresh' })
  // Main checkout is resolved BEFORE the pidfile is read: outside a repo there
  // is nothing to compare against.
  assert.deepEqual(calls, ['mainCheckout', 'probe'])
})

test('staleness: pidfile SHA differs from main HEAD → stale with pid + both SHAs', async () => {
  // The Nov 26 incident shape: the daemon predates main's forward move, so the
  // daemon SHA is an ANCESTOR of main HEAD — ancestry said "fresh", equality
  // must say stale.
  const { deps } = fakeDeps()
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, {
    kind: 'stale',
    pid: PID,
    daemonSha: DAEMON_SHA,
    mainHeadSha: HEAD_SHA,
  })
})

test('staleness: alive pidfile without gitSha → unknown/no-gitsha', async () => {
  const { deps, calls } = fakeDeps({
    probe: { alive: true, pid: PID },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'no-gitsha' })
  assert.deepEqual(calls, ['mainCheckout', 'probe'])
})

test('staleness: daemon not alive → unchecked/daemon-not-running', async () => {
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
    assert.deepEqual(calls, ['mainCheckout', 'probe'])
  }
})

test('staleness: unresolvable main checkout (outside a repo) → unchecked/no-repo, probe skipped', async () => {
  const { deps, calls } = fakeDeps({ mainCheckout: null })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-repo' })
  // With no main checkout there is nothing to compare, so the pidfile is
  // never read.
  assert.deepEqual(calls, ['mainCheckout'])
})

test('staleness: no-repo wins over a dead daemon (check order is pinned)', async () => {
  const { deps } = fakeDeps({
    mainCheckout: null,
    probe: { alive: false, reason: 'no-pidfile' },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-repo' })
})

test('staleness: an empty-string gitSha in the pidfile is treated as no-gitsha', async () => {
  // parsePidfile keeps any string, so staleness must not treat '' as a SHA.
  const { deps, calls } = fakeDeps({
    probe: { alive: true, pid: PID, gitSha: '', mainWorktree: MAIN_PATH },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'no-gitsha' })
  assert.deepEqual(calls, ['mainCheckout', 'probe'])
})

// --- rev 2: the repo-identity guard (validate review P1, the blocker) ---

test('staleness: probe mainWorktree differs from the session main worktree → unchecked/other-repo', async () => {
  // The rev-1 false positive: the global daemon was spawned from another repo,
  // so its SHA can never equal this repo's main HEAD. Silent, never a warning.
  const { deps, calls } = fakeDeps({
    probe: {
      alive: true,
      pid: PID,
      gitSha: DAEMON_SHA,
      mainWorktree: OTHER_PATH,
    },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'other-repo' })
  assert.deepEqual(calls, ['mainCheckout', 'probe'])
})

test('staleness: other-repo wins over a differing SHA (identity precedes the SHA verdict)', async () => {
  // Same SHAs as the STALE row above, only the recorded repo differs — the
  // guard order is the whole fix, so it is pinned here explicitly.
  const { deps } = fakeDeps({
    probe: {
      alive: true,
      pid: PID,
      gitSha: DAEMON_SHA,
      mainWorktree: OTHER_PATH,
    },
    mainCheckout: { path: MAIN_PATH, headSha: HEAD_SHA },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'other-repo' })
})

test('staleness: pidfile gitSha without mainWorktree → unchecked/no-gitroot, silent', async () => {
  // An intermediate build (rev 1) recorded a SHA but no repo identity: that SHA
  // could belong to ANY repo, so warning would re-create the cross-repo false
  // positive. Never guess.
  const { deps, calls } = fakeDeps({
    probe: { alive: true, pid: PID, gitSha: DAEMON_SHA },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-gitroot' })
  assert.deepEqual(calls, ['mainCheckout', 'probe'])
})

test('staleness: empty-string mainWorktree counts as absent → unchecked/no-gitroot', async () => {
  const { deps } = fakeDeps({
    probe: { alive: true, pid: PID, gitSha: DAEMON_SHA, mainWorktree: '' },
  })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unchecked', reason: 'no-gitroot' })
})

test('staleness: no-gitsha wins over no-gitroot (the pre-feature pidfile still warns)', async () => {
  // Both fields missing = a daemon predating PMR-7B8M entirely: known
  // same-machine migration case, actionable warning (rev 2 keeps it).
  const { deps } = fakeDeps({ probe: { alive: true, pid: PID } })
  const got = await checkDaemonStaleness(deps)
  assert.deepEqual(got, { kind: 'unknown', pid: PID, reason: 'no-gitsha' })
})

// ---------------------------------------------------------------------------
// daemonStalenessMessage — the single source for all warning surfaces
// ---------------------------------------------------------------------------

test('message: stale verdict names both short SHAs, the main checkout, and the kill command', async () => {
  const got = daemonStalenessMessage({
    kind: 'stale',
    pid: PID,
    daemonSha: DAEMON_SHA,
    mainHeadSha: HEAD_SHA,
  })
  assert.equal(
    got,
    'daemon is running stale code — started from aaaaaaa, the main checkout is at bbbbbbb. Restart: kill 4242 — the daemon is re-ensured at the next /flow start.',
  )
  if (got === null) {
    assert.fail('stale verdict must produce warning text')
  }
  // Acceptance keywords (ISC-2) — pinned separately from the exact text so a
  // reword that drops one still fails loudly here.
  assert.ok(got.includes('kill 4242'))
  assert.ok(got.includes('the main checkout is at'))
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

test('message: fresh and unchecked verdicts produce nothing', async () => {
  const silent: DaemonStaleness[] = [
    { kind: 'fresh' },
    { kind: 'unchecked', reason: 'daemon-not-running' },
    { kind: 'unchecked', reason: 'no-repo' },
    // Rev 2 — the repo-identity verdicts are silent on every surface.
    { kind: 'unchecked', reason: 'other-repo' },
    { kind: 'unchecked', reason: 'no-gitroot' },
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
    mainHeadSha: HEAD_SHA,
  })
  if (got === null) {
    assert.fail('stale verdict must produce warning text')
  }
  assert.ok(!got.includes(DAEMON_SHA))
  assert.ok(!got.includes(HEAD_SHA))
})

// ---------------------------------------------------------------------------
// resolveHeadSha (spawn-side provenance only)
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
// resolveMainCheckout (rev 1: the staleness reference; rev 2: path + HEAD from
// ONE porcelain call, so the repo-identity comparison is plumbing-consistent)
// ---------------------------------------------------------------------------

test('resolveMainCheckout: first block is the main worktree, linked blocks are ignored', async () => {
  const { exec, calls } = fakeExec({
    stdout: porcelain(HEAD_SHA, DAEMON_SHA),
    code: 0,
  })
  assert.deepEqual(await resolveMainCheckout(exec), {
    path: MAIN_PATH,
    headSha: HEAD_SHA,
  })
  assert.deepEqual(calls, [
    {
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      options: {},
    },
  ])
})

test('resolveMainCheckout: single-block output (main only) → its path and HEAD', async () => {
  const { exec } = fakeExec({
    stdout: `worktree ${MAIN_PATH}\nHEAD ${HEAD_SHA}\ndetached\n`,
    code: 0,
  })
  assert.deepEqual(await resolveMainCheckout(exec), {
    path: MAIN_PATH,
    headSha: HEAD_SHA,
  })
})

test('resolveMainCheckout: a linked-worktree cwd still yields the main block', async () => {
  // Git resolves the worktree list from the cwd, so a session running in a
  // worktree gets the main checkout's path AND HEAD first.
  const { exec, calls } = fakeExec({
    stdout: porcelain(HEAD_SHA, DAEMON_SHA),
    code: 0,
  })
  assert.deepEqual(await resolveMainCheckout(exec, '/repo/.wt/feature'), {
    path: MAIN_PATH,
    headSha: HEAD_SHA,
  })
  assert.deepEqual(calls[0]?.options, { cwd: '/repo/.wt/feature' })
})

test('resolveMainCheckout: path from a later block is never used', async () => {
  // Guards the "first block only" rule the rev-2 repo-identity comparison
  // depends on: a linked worktree must never be mistaken for the main one.
  const { exec } = fakeExec({
    stdout: porcelain(HEAD_SHA, DAEMON_SHA),
    code: 0,
  })
  const got = await resolveMainCheckout(exec)
  assert.deepEqual(got, { path: MAIN_PATH, headSha: HEAD_SHA })
  // Explicitly: the linked worktree's path never surfaces.
  assert.notEqual(got?.path, '/repo/.wt/feature')
})

test('resolveMainCheckout: non-zero exit (not a repo / broken git) → null', async () => {
  const { exec } = fakeExec({
    stdout: 'fatal: not a git repository\n',
    code: 128,
  })
  assert.equal(await resolveMainCheckout(exec), null)
})

test('resolveMainCheckout: exec throwing → null, never throws', async () => {
  const { exec } = fakeExec({ throws: 'spawn git EACCES' })
  assert.equal(await resolveMainCheckout(exec), null)
})

test('resolveMainCheckout: non-hex / short HEAD → null', async () => {
  for (const stdout of [
    `worktree ${MAIN_PATH}\nHEAD ${NOT_HEX_SHA}\n`,
    `worktree ${MAIN_PATH}\nHEAD abc1234\n`,
    `worktree ${MAIN_PATH}\nHEAD \n`,
  ]) {
    const { exec } = fakeExec({ stdout, code: 0 })
    assert.equal(await resolveMainCheckout(exec), null)
  }
})

test('resolveMainCheckout: unborn HEAD (no HEAD line in the first block) → null', async () => {
  // A fresh repo with no commits lists the worktree but has no HEAD yet.
  const { exec } = fakeExec({
    stdout: `worktree ${MAIN_PATH}\nbranch refs/heads/master\n\n`,
    code: 0,
  })
  assert.equal(await resolveMainCheckout(exec), null)
})

test('resolveMainCheckout: no worktree line → null (path identity is required)', async () => {
  const { exec } = fakeExec({ stdout: `HEAD ${HEAD_SHA}\n`, code: 0 })
  assert.equal(await resolveMainCheckout(exec), null)
})

test('resolveMainCheckout: empty worktree path → null', async () => {
  const { exec } = fakeExec({
    stdout: `worktree \nHEAD ${HEAD_SHA}\n`,
    code: 0,
  })
  assert.equal(await resolveMainCheckout(exec), null)
})

test('resolveMainCheckout: empty output → null', async () => {
  const { exec } = fakeExec({ stdout: '', code: 0 })
  assert.equal(await resolveMainCheckout(exec), null)
})

// ---------------------------------------------------------------------------
// sessionStalenessDeps — wiring
// ---------------------------------------------------------------------------

test('sessionDeps: mainCheckout runs through the injected exec with cwd', async () => {
  const { exec, calls } = fakeExec({
    stdout: porcelain(HEAD_SHA, DAEMON_SHA),
    code: 0,
  })
  const deps = sessionStalenessDeps(exec, '/tmp/fake-agent', '/tmp/checkout')
  assert.deepEqual(await deps.mainCheckout(), {
    path: MAIN_PATH,
    headSha: HEAD_SHA,
  })
  assert.deepEqual(
    calls.map((c) => c.args),
    [['worktree', 'list', '--porcelain']],
  )
  assert.deepEqual(calls[0]?.options, { cwd: '/tmp/checkout' })
})

test('sessionDeps: probe reads the pidfile under the given agent dir (missing → not alive)', async () => {
  const { exec } = fakeExec({ stdout: porcelain(HEAD_SHA, DAEMON_SHA) })
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
  const { deps } = fakeDeps()
  const notes: Array<{ message: string; level: string }> = []
  await warnDaemonStaleness(deps, (message, level) => {
    notes.push({ message, level })
  })
  assert.equal(notes.length, 1)
  assert.equal(notes[0]?.level, 'warning')
  assert.equal(
    notes[0]?.message,
    'pi-flow: daemon is running stale code — started from aaaaaaa, the main checkout is at bbbbbbb. Restart: kill 4242 — the daemon is re-ensured at the next /flow start.',
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

test('warn: fresh and unchecked verdicts notify nothing', async () => {
  // Every silent shape from the decision matrix — none of them may produce a
  // notification (ISC-5 fresh, dead daemon / no repo silent; rev 2 adds the
  // cross-repo and unverifiable-identity cases).
  const silent: Array<Parameters<typeof fakeDeps>[0]> = [
    {
      probe: {
        alive: true,
        pid: PID,
        gitSha: DAEMON_SHA,
        mainWorktree: MAIN_PATH,
      },
      mainCheckout: { path: MAIN_PATH, headSha: DAEMON_SHA },
    },
    { probe: { alive: false, reason: 'no-pidfile' } },
    { probe: { alive: false, reason: 'version-mismatch', pid: PID } },
    { probe: { alive: false, reason: 'dead-process', pid: PID } },
    { probe: { alive: false, reason: 'malformed-pidfile' } },
    { mainCheckout: null },
    // Rev 2: a daemon from another repo must never warn, whatever its SHA.
    {
      probe: {
        alive: true,
        pid: PID,
        gitSha: DAEMON_SHA,
        mainWorktree: OTHER_PATH,
      },
    },
    // Rev 2: a rev-1 pidfile (SHA, no repo identity) must never warn either.
    { probe: { alive: true, pid: PID, gitSha: DAEMON_SHA } },
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
