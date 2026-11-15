// PMR-2HFC — after the retry budget is exhausted, further failing reports are
// refused WITHOUT writing another aven note. Fake `aven` on PATH counts
// `note` invocations; the avenWorkspace override (project config in the
// session cwd) skips ref resolution so the note call is the only aven call.
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import { recordRunEvent } from '../run-state.ts'
import {
  createAttemptLedger,
  registerRunAttemptTool,
} from '../tools/run-attempt.ts'

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-run-attempt-'))
const BIN_DIR = path.join(ROOT, 'bin')
const COUNT_FILE = path.join(ROOT, 'notes.txt')
const SESSION_CWD = path.join(ROOT, 'session')
mkdirSync(BIN_DIR)
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: path.join(ROOT, 'ws') }),
)
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\n[ "$1" = note ] && echo n >> "${COUNT_FILE}"\nexit 0\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

type Execute = (
  id: string,
  params: { ref: string; result: { ok: boolean; lastError?: string } },
) => Promise<{
  isError?: boolean
  content: { text: string }[]
  details?: { status: string }
}>

// AIDEV-NOTE: PMR-XTQQ 4.2 — capture helper + fake-aven scoping so the new
// two-sessions tests can run against a temp agentDir without touching the
// real one and with isolated note counts.
function captureTool(ledger?: Parameters<typeof registerRunAttemptTool>[1]) {
  let execute: Execute | undefined
  registerRunAttemptTool(
    {
      registerTool: (tool: { execute: Execute }) => {
        execute = tool.execute
      },
    } as unknown as ExtensionAPI,
    ledger,
  )
  assert.ok(execute)
  return execute
}

function withFakeAven(fn: () => Promise<void>): Promise<void> {
  return (async () => {
    writeFileSync(COUNT_FILE, '')
    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${BIN_DIR}:${previousPath}`
    setAvenSessionCwd(SESSION_CWD)
    try {
      await fn()
    } finally {
      process.env.PATH = previousPath
      setAvenSessionCwd(undefined)
    }
  })()
}

function noteCount(): number {
  try {
    return readFileSync(COUNT_FILE, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

const FAIL = { ok: false, lastError: 'red' }

// AIDEV-NOTE: PMR-XTQQ 4.2 — recordRunEvent only journals when the projection
// changes, and an attempt-record without a prior run-start never projects, so
// the two-sessions tests seed a run-start exactly like a real /flow run does.
function seedRunStart(agentDir: string, ref: string): Promise<void> {
  return recordRunEvent(agentDir, {
    kind: 'run-start',
    at: new Date().toISOString(),
    ref,
    mode: 'personal',
  })
}

// AIDEV-NOTE: PMR-XTQQ 4.2 — two fresh tool instances on the SAME journal
// share one budget: instance B seeds its count from instance A's journaled
// attempt-record snapshots and refuses at the old count; the escalation
// note stays exactly once across the simulated restart.
test('seeded budget refuses at the journaled count across instances', async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-attempt-'))
  try {
    await withFakeAven(async () => {
      await seedRunStart(agentDir, 'PMR-SEED1')
      const first = captureTool(createAttemptLedger(agentDir))
      const statuses: boolean[] = []
      for (let i = 0; i < 3; i++) {
        const r = await first(`s${i}`, {
          ref: 'PMR-SEED1',
          result: FAIL,
        })
        statuses.push(r.isError === true)
      }
      assert.deepEqual(statuses, [false, false, true])
      assert.equal(noteCount(), 1)
      const second = captureTool(createAttemptLedger(agentDir))
      const refused = await second('s0', { ref: 'PMR-SEED1', result: FAIL })
      assert.equal(refused.isError, true)
      assert.match(refused.content[0]?.text ?? '', /already exhausted/)
      assert.equal(noteCount(), 1, 'no second escalation note across restart')
    })
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

// AIDEV-NOTE: PMR-XTQQ 4.2 — a journaled 'passed' snapshot resets the durable
// count to 0: a third fresh instance starts a fresh budget.
test('journaled pass resets the durable budget', async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-attempt-'))
  try {
    await withFakeAven(async () => {
      await seedRunStart(agentDir, 'PMR-SEED2')
      const first = captureTool(createAttemptLedger(agentDir))
      const r1 = await first('s0', { ref: 'PMR-SEED2', result: FAIL })
      assert.equal(r1.details?.status, 'retry')
      const second = captureTool(createAttemptLedger(agentDir))
      const r2 = await second('s0', {
        ref: 'PMR-SEED2',
        result: { ok: true },
      })
      assert.equal(r2.details?.status, 'passed')
      const third = captureTool(createAttemptLedger(agentDir))
      const statuses: boolean[] = []
      for (let i = 0; i < 3; i++) {
        const r = await third(`s${i}`, { ref: 'PMR-SEED2', result: FAIL })
        statuses.push(r.isError === true)
      }
      assert.deepEqual(statuses, [false, false, true])
    })
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

// AIDEV-NOTE: PMR-XTQQ 4.2 — the budget must never BRICK the tool: a ledger
// whose io throws degrades to today's in-memory-only behavior.
test('ledger io failure degrades to in-memory behavior', async () => {
  const throwing = {
    seed: () => Promise.reject(new Error('io down')),
    record: () => Promise.reject(new Error('io down')),
  }
  await withFakeAven(async () => {
    const execute = captureTool(throwing)
    const statuses: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const r = await execute(`s${i}`, { ref: 'PMR-IOFAIL', result: FAIL })
      statuses.push(r.isError === true)
    }
    assert.deepEqual(statuses, [false, false, true, true])
  })
})

test('exhausted budget refuses further attempts without a second note', async () => {
  let execute: Execute | undefined
  // AIDEV-NOTE: PMR-XTQQ 4.2 — fresh temp agentDir ledger: empty journal →
  // null seed → identical in-memory behavior, and the journaled snapshots
  // land in the temp dir instead of the real agent dir.
  registerRunAttemptTool(
    {
      registerTool: (tool: { execute: Execute }) => {
        execute = tool.execute
      },
    } as unknown as ExtensionAPI,
    createAttemptLedger(
      mkdtempSync(path.join(os.tmpdir(), 'pi-flow-attempt-')),
    ),
  )
  assert.ok(execute)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SESSION_CWD)
  // AIDEV-NOTE: PMR-XTQQ 4.2 — isolate from the other tests' escalation notes.
  writeFileSync(COUNT_FILE, '')
  try {
    const fail = { ref: 'PMR-TEST', result: { ok: false, lastError: 'red' } }
    const statuses: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const r = await execute(`t${i}`, fail)
      statuses.push(r.isError === true)
    }
    assert.deepEqual(statuses, [false, false, true, true, true])
    const notes = readFileSync(COUNT_FILE, 'utf8').split('\n').filter(Boolean)
    assert.equal(notes.length, 1, 'escalation note written exactly once')
    const refused = await execute('t-last', fail)
    assert.match(refused.content[0]?.text ?? '', /already exhausted/)
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

after(() => rmSync(ROOT, { recursive: true, force: true }))
