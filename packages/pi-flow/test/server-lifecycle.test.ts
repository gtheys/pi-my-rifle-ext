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
} {
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
  return {
    pidfile: state.pidfile,
    killed: state.killed,
    spawns: state.spawns,
    spawnThrows: state.spawnThrows,
    logFdsOpened: state.logFdsOpened,
    readFile: async (_p: string) => {
      return state.pidfile
    },
    isProcessAlive: (_pid: number) => true,
    kill: (pid: number) => {
      state.killed.push(pid)
    },
    spawn: (cmd, args, opts) => {
      if (state.spawnThrows !== null) throw new Error(state.spawnThrows)
      state.spawns.push({
        cmd,
        args,
        detached: opts.detached,
        env: opts.env as Record<string, string | undefined>,
      })
      // Fake daemon: immediately write the fresh pidfile like the real one.
      const pid = 4242
      state.pidfile = `${JSON.stringify({ pid, version: '1', startedAt: 'now', agentDir: AGENT_DIR })}\n`
      return { pid, unref: () => undefined }
    },
    mkdir: async () => undefined,
    openLogFd: (p: string) => {
      state.logFdsOpened.push(p)
      return 7
    },
    closeFd: () => undefined,
    sleep: async () => undefined,
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

test('EXPECTED_SERVER_PROTOCOL_VERSION matches the daemon pin', () => {
  assert.equal(EXPECTED_SERVER_PROTOCOL_VERSION, '1')
})
