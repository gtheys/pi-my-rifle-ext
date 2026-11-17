// AIDEV-NOTE: PMR-XTQQ unit tests for server/lifecycle.ts. All fs/process
// edges are faked (in-memory pidfile, recording spawn/kill, instant sleep) —
// no real spawns, no real signals, no real clock waits in this suite.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EXPECTED_SERVER_PROTOCOL_VERSION,
  ensureDaemon,
  type LifecycleIo,
  type ProbeResult,
  probeDaemon,
  spawnLockPath,
} from '../server/lifecycle.ts'

const AGENT_DIR = '/tmp/fake-agent'
const LOG_PATH = `${AGENT_DIR}/pi-flow/server.log`

/** Fresh fake io: empty filesystem, everything alive, instant sleeps. */
function makeIo(pidfile: string | null): LifecycleIo & {
  pidfile: string | null
  killed: number[]
  spawns: Array<{
    cmd: string
    args: string[]
    detached: boolean
    env: Record<string, string | undefined>
  }>
  spawnThrows: string | null
  logFdsOpened: string[]
  /** PMR-HRGJ fake filesystem for the spawn-lock seam (path → contents). */
  files: Map<string, string>
  renames: Array<{ from: string; to: string }>
  unlinks: string[]
} {
  const files = new Map<string, string>()
  const renames: Array<{ from: string; to: string }> = []
  const unlinks: string[] = []
  const state = {
    pidfile,
    killed: [] as number[],
    spawns: [] as Array<{
      cmd: string
      args: string[]
      detached: boolean
      env: Record<string, string | undefined>
    }>,
    spawnThrows: null as string | null,
    logFdsOpened: [] as string[],
  }
  const io = {
    pidfile: state.pidfile,
    killed: state.killed,
    spawns: state.spawns,
    spawnThrows: state.spawnThrows,
    logFdsOpened: state.logFdsOpened,
    files,
    renames,
    unlinks,
    readFile: async (p: string) => {
      // PMR-HRGJ: the pidfile is served from io.pidfile; anything else
      // (spawn-lock / temp claim) comes from the fake files map.
      if (p.endsWith('.pid')) {
        return io.pidfile
      } else {
        const contents = files.get(p)
        if (contents === undefined) return null
        return contents
      }
    },
    isProcessAlive: (_pid: number) => true,
    kill: (pid: number) => {
      state.killed.push(pid)
    },
    spawn: (
      cmd: string,
      args: string[],
      opts: {
        detached: boolean
        stdio: ['ignore', number, number]
        env: NodeJS.ProcessEnv
      },
    ) => {
      if (state.spawnThrows !== null) throw new Error(state.spawnThrows)
      state.spawns.push({
        cmd,
        args,
        detached: opts.detached,
        env: opts.env as Record<string, string | undefined>,
      })
      // Fake daemon: immediately write the fresh pidfile like the real one.
      const pid = 4242
      io.pidfile = `${JSON.stringify({ pid, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
      return { pid, unref: () => undefined }
    },
    mkdir: async () => undefined,
    openLogFd: (p: string) => {
      state.logFdsOpened.push(p)
      return 7
    },
    closeFd: () => undefined,
    sleep: async () => undefined,
    // Default: unknown mtime → old pidfile → normal respawn decision
    // (keeps the pre-spawn-in-progress behavior for existing tests).
    statMtimeMs: async () => null,
    now: () => Date.now(),
    // PMR-HRGJ fake lock primitives over the in-memory files map.
    tryCreateExclusive: async (p: string, content: string) => {
      if (files.has(p)) return false
      files.set(p, content)
      return true
    },
    renameOver: async (from: string, to: string) => {
      const contents = files.get(from)
      if (contents === undefined) return false
      files.set(to, contents)
      files.delete(from)
      renames.push({ from, to })
      return true
    },
    unlinkFile: async (p: string) => {
      files.delete(p)
      unlinks.push(p)
    },
  }
  return io as LifecycleIo & {
    pidfile: string | null
    killed: number[]
    spawns: Array<{
      cmd: string
      args: string[]
      detached: boolean
      env: Record<string, string | undefined>
    }>
    spawnThrows: string | null
    logFdsOpened: string[]
    files: Map<string, string>
    renames: Array<{ from: string; to: string }>
    unlinks: string[]
  }
}

// --- probeDaemon ---

test('probe: missing pidfile → alive:false, reason no-pidfile', async () => {
  const io = makeIo(null)
  const res: ProbeResult = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) assert.equal(res.reason, 'no-pidfile')
})

test('probe: garbage pidfile → alive:false, reason malformed-pidfile, never throws', async () => {
  const io = makeIo('not json at all {{{')
  const res = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) assert.equal(res.reason, 'malformed-pidfile')
})

test('probe: pidfile with non-numeric pid → malformed-pidfile', async () => {
  const io = makeIo('{"pid":"abc","version":"1"}')
  const res = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) assert.equal(res.reason, 'malformed-pidfile')
})

test('probe: dead pid → alive:false, reason dead-process', async () => {
  const io = makeIo('{"pid":999,"version":"1"}')
  io.isProcessAlive = (pid: number) => pid !== 999
  const res = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) assert.equal(res.reason, 'dead-process')
})

test('probe: alive + matching version → alive:true with pid', async () => {
  const io = makeIo('{"pid":123,"version":"1"}')
  const res = await probeDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { alive: true, pid: 123 })
})

test('probe: alive but old version → alive:false, reason version-mismatch, pid surfaced', async () => {
  const io = makeIo('{"pid":123,"version":"0"}')
  const res = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) {
    assert.equal(res.reason, 'version-mismatch')
    assert.equal(res.pid, 123)
  }
})

test('probe: readFile rejection degrades to no-pidfile (never throws)', async () => {
  const io = makeIo('{"pid":1,"version":"1"}')
  io.readFile = async () => {
    throw new Error('EACCES')
  }
  const res = await probeDaemon(AGENT_DIR, io)
  assert.equal(res.alive, false)
  if (!res.alive) assert.equal(res.reason, 'no-pidfile')
})

// --- ensureDaemon ---

test('ensure: alive + matching version → already-running, no spawn, no kill', async () => {
  const io = makeIo('{"pid":123,"version":"1"}')
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'already-running', pid: 123 })
  assert.equal(io.spawns.length, 0)
  assert.equal(io.killed.length, 0)
})

test('ensure: dead-pid pidfile → respawn decision (spawn called)', async () => {
  const io = makeIo('{"pid":999,"version":"1"}')
  io.isProcessAlive = (pid: number) => pid !== 999
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  // SIGTERM is best-effort; ESRCH on the dead pid is swallowed by the io seam.
  assert.deepEqual(io.killed, [999])
  assert.equal(io.spawns.length, 1)
  const spawn = io.spawns[0]
  assert.equal(spawn.detached, true)
  assert.equal(spawn.env.PI_FLOW_AGENT_DIR, AGENT_DIR)
  assert.ok(spawn.args[0].endsWith('daemon.ts'))
  assert.deepEqual(io.logFdsOpened, [LOG_PATH])
})

test('ensure: alive-but-old-version → kill (SIGTERM) + respawn decision', async () => {
  const io = makeIo('{"pid":123,"version":"0"}')
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  assert.deepEqual(io.killed, [123])
  assert.equal(io.spawns.length, 1)
})

test('ensure: spawn throws → status spawn-failed, never throws', async () => {
  const io = makeIo('{"pid":999,"version":"1"}')
  io.isProcessAlive = (pid: number) => pid !== 999
  io.spawn = () => {
    throw new Error('ENOENT')
  }
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.equal(res.status, 'spawn-failed')
  if (res.status === 'spawn-failed') assert.ok(res.reason.includes('ENOENT'))
})

test('ensure: pidfile never appears → spawn-timeout within bounded poll', async () => {
  const io = makeIo('{"pid":999,"version":"1"}')
  io.isProcessAlive = (pid: number) => pid !== 999
  // Fake spawn that does NOT write a pidfile.
  io.spawn = () => ({ pid: 4242, unref: () => undefined })
  let polls = 0
  io.sleep = async () => {
    polls += 1
  }
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.equal(res.status, 'spawn-timeout')
  assert.ok(polls > 0)
  // Bounded: 2000ms budget / 50ms interval = 40 polls max.
  assert.ok(polls <= 40)
})

test('ensure: stale pidfile cleaned before spawn check — fresh pidfile from fake spawn wins', async () => {
  // The fake spawn overwrites the pidfile; ensure must accept the new pid,
  // not confuse it with the stale one.
  const io = makeIo('{"pid":999,"version":"1"}')
  io.isProcessAlive = (pid: number) => pid !== 999
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
})

// --- spawn-in-progress window (fresh dead-pid pidfile) ---

/** Fake clock: now() is a counter advanced by sleep(ms) so instant sleeps
 * still terminate the bounded wait. */
function makeFakeClock(io: LifecycleIo, start = 1_000_000): void {
  let clock = start
  io.now = () => clock
  io.sleep = async (ms: number) => {
    clock += ms
  }
}

const DEAD_PIDFILE = '{"pid":999,"version":"1"}'

function deadUntil(pid: number): (pid: number) => boolean {
  return (candidate: number) => candidate !== pid
}

// AIDEV-NOTE: regression guard for the PMR-XTQQ review fix — a FRESH dead-pid
// pidfile must NOT trigger an immediate duplicate spawn.
test('ensure: recent dead-pid pidfile → spawn-in-progress, no spawn call', async () => {
  const io = makeIo(DEAD_PIDFILE)
  io.isProcessAlive = deadUntil(999)
  io.statMtimeMs = async () => 500_000
  makeFakeClock(io, 500_100) // age = 100ms → fresh
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawn-in-progress' })
  assert.equal(io.spawns.length, 0)
})

test('ensure: old dead-pid pidfile → normal respawn (spawn called)', async () => {
  const io = makeIo(DEAD_PIDFILE)
  io.isProcessAlive = deadUntil(999)
  io.statMtimeMs = async () => 500_000
  makeFakeClock(io, 560_000) // age = 60s → stale, no window
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  assert.equal(io.spawns.length, 1)
})

test('ensure: fresh dead-pid pidfile becomes live mid-wait → already-running, no spawn', async () => {
  const io = makeIo(DEAD_PIDFILE)
  io.isProcessAlive = (pid: number) => pid === 777 || pid !== 999
  io.statMtimeMs = async () => 500_000
  let clock = 500_100
  io.now = () => clock
  let ticks = 0
  io.sleep = async (ms: number) => {
    ticks += 1
    clock += ms
    if (ticks === 1) {
      // The racing spawn's daemon wrote a live pidfile.
      io.pidfile = `${JSON.stringify({ pid: 777, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
    }
  }
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'already-running', pid: 777 })
  assert.equal(io.spawns.length, 0)
})

test('ensure: statMtimeMs rejection degrades to respawn decision (never throws)', async () => {
  const io = makeIo(DEAD_PIDFILE)
  io.isProcessAlive = deadUntil(999)
  io.statMtimeMs = async () => {
    throw new Error('EACCES')
  }
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
})

test('EXPECTED_SERVER_PROTOCOL_VERSION matches the daemon pin', () => {
  assert.equal(EXPECTED_SERVER_PROTOCOL_VERSION, '1')
})

// --- PMR-HRGJ spawn lock (cross-process claim) ---

const LOCK_PATH = spawnLockPath(AGENT_DIR)

function lockClaim(
  io: ReturnType<typeof makeIo>,
  pid: number,
  at: number,
): void {
  io.files.set(LOCK_PATH, JSON.stringify({ pid, at }))
}

// AIDEV-NOTE: PMR-HRGJ done-when regression — two concurrent ensureDaemon
// calls sharing one fake IO with a genuinely exclusive tryCreateExclusive
// must produce exactly one spawn: the loser waits on the winner's claim.
test('ensure: two concurrent sessions → exactly one spawn, loser waits', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  const [a, b] = await Promise.all([
    ensureDaemon(AGENT_DIR, io),
    ensureDaemon(AGENT_DIR, io),
  ])
  assert.deepEqual(a, { status: 'spawned', pid: 4242 })
  assert.equal(b.status, 'already-running')
  assert.equal(
    io.spawns.length,
    1,
    'duplicate spawn must be prevented by the claim',
  )
  assert.equal(
    io.files.has(LOCK_PATH),
    false,
    'claim must be released after spawn',
  )
})

test('ensure: stale claim (dead claimant) → stolen via rename, spawn proceeds', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  lockClaim(io, 555, 999_000)
  io.isProcessAlive = deadUntil(555)
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  assert.equal(io.spawns.length, 1)
  assert.equal(io.renames.length, 1)
  assert.ok(
    io.renames[0].from.startsWith(LOCK_PATH),
    'steal renames a temp claim',
  )
  assert.ok(io.renames[0].from.endsWith('.tmp'))
  assert.equal(io.renames[0].to, LOCK_PATH)
  assert.equal(io.files.has(LOCK_PATH), false, 'claim released after spawn')
})

test('ensure: steal race — a contender whose rename landed second must not spawn', async () => {
  // A holds a stale claim (dead claimant). Two sessions steal it
  // concurrently: the faster contender's rename lands last, so the lock no
  // longer holds OUR claim when we check. Emulated by a renameOver that
  // reports success but leaves the stale claim content in place — exactly
  // what the lock looks like from the loser's side. The stealer must verify
  // its claim actually landed before spawning; without the read-back check
  // both contenders spawn (the exact double-spawn this ticket forbids).
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  lockClaim(io, 555, 999_000)
  io.isProcessAlive = deadUntil(555)
  const realRename = io.renameOver
  let renameLands = false
  io.renameOver = async (from: string, to: string) => {
    if (!renameLands) return true // "won" the rename, but C's claim replaced ours
    return realRename(from, to)
  }
  const lost = await ensureDaemon(AGENT_DIR, io)
  assert.equal(lost.status, 'spawn-in-progress')
  assert.equal(io.spawns.length, 0, 'lost stealer must not spawn')

  // A later session steals for real (the rename lands) and spawns normally.
  renameLands = true
  const won = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(won, { status: 'spawned', pid: 4242 })
  assert.equal(io.spawns.length, 1)
})

test('ensure: expired claim (live claimant, age > max) → stolen, spawn proceeds', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  lockClaim(io, 777, 1_000_000 - 6_000) // 6s old > 5s bound, claimant alive
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  assert.equal(io.spawns.length, 1)
  assert.equal(io.renames.length, 1)
})

test('ensure: live fresh claim → no spawn, no SIGTERM, spawn-in-progress', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  lockClaim(io, 777, 999_500) // alive + fresh (500ms old)
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawn-in-progress' })
  assert.equal(io.spawns.length, 0)
  assert.equal(io.killed.length, 0, 'loser must not SIGTERM under a live claim')
})

test('ensure: claim released on spawned and spawn-failed, KEPT on spawn-timeout', async () => {
  // spawned
  const ok = makeIo(null)
  await ensureDaemon(AGENT_DIR, ok)
  assert.equal(ok.files.has(LOCK_PATH), false)

  // PMR-HRGJ: spawn-timeout (spawn never writes a pidfile) — the claim is
  // deliberately KEPT: a slow child may still be >2s from writing its
  // pidfile, so releasing would let a contender spawn a duplicate. The 5s
  // SPAWN_IN_PROGRESS_MAX_AGE_MS age bound reclaims the claim instead.
  const timeout = makeIo(null)
  makeFakeClock(timeout, 2_000_000)
  timeout.spawn = () => ({ pid: 4242, unref: () => undefined })
  const timeoutRes = await ensureDaemon(AGENT_DIR, timeout)
  assert.equal(timeoutRes.status, 'spawn-timeout')
  assert.equal(
    timeout.files.has(LOCK_PATH),
    true,
    'timeout must keep the claim; the age bound reclaims it',
  )

  // spawn-failed (spawn throws; release still happens via finally)
  const failed = makeIo(null)
  failed.spawn = () => {
    throw new Error('ENOENT')
  }
  const failedRes = await ensureDaemon(AGENT_DIR, failed)
  assert.equal(failedRes.status, 'spawn-failed')
  assert.equal(failed.files.has(LOCK_PATH), false)
})

// PMR-HRGJ fix 1 (interleaving a): a stale pre-claim probe must not spawn
// over a daemon that came up in the probe→claim gap — re-probe after winning
// the claim and report already-running instead of spawning a duplicate.
test('ensure: daemon appears between probe and claim → already-running, no spawn', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  let pidfileReads = 0
  const baseRead = io.readFile
  io.readFile = async (p: string) => {
    if (p.endsWith('.pid')) {
      pidfileReads += 1
      if (pidfileReads === 1) return null
      // By the time the claim is won, a rival's daemon is live.
      io.pidfile = `${JSON.stringify({ pid: 777, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
    }
    return baseRead(p)
  }
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'already-running', pid: 777 })
  assert.equal(io.spawns.length, 0)
  assert.equal(
    io.files.has(LOCK_PATH),
    false,
    'claim released on the already-running re-probe path',
  )
})

// PMR-HRGJ fix 2: an empty lock file with a FRESH mtime means a winner is
// mid-write (between open('wx') and the content write) — contending is the
// only safe move; stealing would clobber the winner's fresh claim.
test('ensure: young empty lock → contend, no steal, no spawn', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 1_000_000)
  io.files.set(LOCK_PATH, '') // empty lock = winner mid-write
  io.statMtimeMs = async () => io.now() - 100 // 100ms old → fresh
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.equal(
    res.status === 'spawn-in-progress' || res.status === 'already-running',
    true,
    'contended status expected',
  )
  assert.equal(io.spawns.length, 0)
  assert.equal(io.renames.length, 0, 'a young empty lock must NOT be stolen')
  assert.deepEqual(io.files.get(LOCK_PATH), '')
})

// PMR-HRGJ fix 4 (+ fix 3): after a spawn-timeout the claim is kept; once it
// ages past the 5s bound (claimant alive, so age is the only reclaim path) a
// later ensureDaemon steals it, spawns, and releases its OWN claim.
test('ensure: spawn-timeout keeps claim until aged, then a later call steals and releases it', async () => {
  const timeout = makeIo(null)
  makeFakeClock(timeout, 2_000_000)
  timeout.spawn = () => ({ pid: 4242, unref: () => undefined })
  const timeoutRes = await ensureDaemon(AGENT_DIR, timeout)
  assert.equal(timeoutRes.status, 'spawn-timeout')
  assert.equal(timeout.files.has(LOCK_PATH), true)

  // Age the claim (claimant is us — alive — so only age can make it stale).
  await timeout.sleep(6_000)
  // This spawn DOES write the pidfile, so the stealing call succeeds.
  timeout.spawn = () => {
    timeout.pidfile = `${JSON.stringify({ pid: 4242, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
    return { pid: 4242, unref: () => undefined }
  }
  const stolen = await ensureDaemon(AGENT_DIR, timeout)
  assert.deepEqual(stolen, { status: 'spawned', pid: 4242 })
  assert.equal(timeout.renames.length, 1, 'aged claim stolen via rename')
  assert.equal(
    timeout.files.has(LOCK_PATH),
    false,
    'own claim released after the stolen-claim spawn',
  )
})

// PMR-HRGJ fix 3: a >5s-stalled winner whose poll loop finally succeeds must
// NOT delete a stealer's fresh claim — release is ownership-checked.
test('ensure: release is ownership-checked — stealer claim survives a stalled winner', async () => {
  const io = makeIo(null)
  let clock = 1_000_000
  io.now = () => clock
  let polls = 0
  io.sleep = async (ms: number) => {
    clock += ms
    polls += 1
    if (polls === 3) {
      // Mid-flight hijack: our claim ages out and a stealer takes the lock.
      clock += 6_000 // > SPAWN_IN_PROGRESS_MAX_AGE_MS (5s)
      io.files.set(LOCK_PATH, JSON.stringify({ pid: 999, at: clock }))
      // The stalled winner's child only THEN gets its pidfile written.
      io.pidfile = `${JSON.stringify({ pid: 4242, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
    }
  }
  // The fake spawn itself does NOT write the pidfile; it lands mid-poll above.
  io.spawn = () => ({ pid: 4242, unref: () => undefined })
  const res = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(res, { status: 'spawned', pid: 4242 })
  assert.equal(
    io.files.has(LOCK_PATH),
    true,
    'release must NOT unlink a claim we no longer own',
  )
  const leftover = JSON.parse(io.files.get(LOCK_PATH) ?? '{}') as {
    pid?: number
  }
  assert.equal(leftover.pid, 999, 'stealer claim intact')
})

test('ensure: released claim → a later ensureDaemon can spawn again', async () => {
  const io = makeIo(null)
  makeFakeClock(io, 3_000_000)
  const first = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(first, { status: 'spawned', pid: 4242 })
  io.pidfile = null
  const second = await ensureDaemon(AGENT_DIR, io)
  assert.deepEqual(second, { status: 'spawned', pid: 4242 })
  assert.equal(io.spawns.length, 2)
})
