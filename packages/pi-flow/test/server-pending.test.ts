// Unit tests for the PMR-XTQQ pending protocol module (server/pending.ts).
// Pure parse tests plus real-fs tests against temp dirs, including the
// exactly-once rename race between two concurrent consumers.
import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readRunEvents, recordRunEvent } from '../run-state.ts'
import {
  clearPending,
  consumePending,
  isParkedLoop,
  PENDING_SCHEMA,
  type PendingRecord,
  parsePendingRecord,
  sweepConsumed,
  writePending,
} from '../server/pending.ts'

async function tmpPendingDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-pending-'))
  await mkdir(path.join(dir, 'pending'), { recursive: true })
  return path.join(dir, 'pending')
}

function validRecord(ref: string): PendingRecord {
  return {
    schema: PENDING_SCHEMA,
    ref,
    phase: 'implement',
    createdAt: new Date().toISOString(),
    sourceAt: new Date().toISOString(),
  }
}

// Seed a parked loop-state journal for a ref under a real agentDir layout
// (<agentDir>/pi-flow/runs) so readRunEvents resolves it natively.
async function seedParkedJournal(
  agentDir: string,
  ref: string,
  parked: boolean,
) {
  const runs = path.join(agentDir, 'pi-flow', 'runs')
  await mkdir(runs, { recursive: true })
  await recordRunEvent(agentDir, {
    kind: 'run-start',
    at: new Date().toISOString(),
    ref,
    mode: 'personal',
  })
  let status: 'running' | 'paused' = 'paused'
  if (parked) {
    status = 'running'
  }
  await recordRunEvent(agentDir, {
    kind: 'loop-state',
    at: new Date().toISOString(),
    ref,
    loop: {
      phase: 'implement',
      awaitingOutcome: parked,
      blockerRetries: 0,
      validateStartedAt: new Date().toISOString(),
      status,
    },
  })
}

// Verify closure in the shape the real consumer (3.3) will use: read the
// journal from disk and check the latest loop-state snapshot is parked.
function journalVerifier(agentDir: string) {
  return async (record: PendingRecord): Promise<boolean> => {
    const events = await readRunEvents(agentDir, record.ref)
    if (events === null) return false
    let loop = null
    for (const event of events) {
      if (event.kind === 'loop-state') loop = event.loop
    }
    if (loop === null) return false
    return isParkedLoop(loop)
  }
}

test('parsePendingRecord accepts a strict valid record', () => {
  const raw = JSON.stringify(validRecord('PMR-XTQQ'))
  const parsed = parsePendingRecord(raw)
  assert.ok(parsed !== null)
  assert.equal(parsed.ref, 'PMR-XTQQ')
  assert.equal(parsed.schema, PENDING_SCHEMA)
  assert.equal(parsed.phase, 'implement')
})

test('parsePendingRecord returns null on garbage inputs without throwing', () => {
  assert.equal(parsePendingRecord('not json'), null)
  assert.equal(parsePendingRecord('{}'), null)
  assert.equal(parsePendingRecord(JSON.stringify({ schema: 'other' })), null)
  assert.equal(
    parsePendingRecord(
      JSON.stringify({ ...validRecord('PMR-XTQQ'), schema: 'x.y.z' }),
    ),
    null,
  )
  assert.equal(
    parsePendingRecord(JSON.stringify({ ...validRecord('PMR-XTQQ'), ref: 42 })),
    null,
  )
  assert.equal(
    parsePendingRecord(
      JSON.stringify({ ...validRecord('PMR-XTQQ'), phase: 'research' }),
    ),
    null,
  )
  assert.equal(
    parsePendingRecord(
      JSON.stringify({ ...validRecord('PMR-XTQQ'), extra: 1 }),
    ),
    null,
  )
  // ref with path separators is rejected by the filename charset guard
  assert.equal(parsePendingRecord(JSON.stringify(validRecord('../evil'))), null)
})

test('isParkedLoop only counts awaitingOutcome=true with status running', () => {
  assert.equal(
    isParkedLoop({
      phase: 'implement',
      awaitingOutcome: true,
      blockerRetries: 0,
      validateStartedAt: '',
      status: 'running',
    }),
    true,
  )
  assert.equal(
    isParkedLoop({
      phase: 'implement',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: '',
      status: 'running',
    }),
    false,
  )
  assert.equal(
    isParkedLoop({
      phase: 'implement',
      awaitingOutcome: true,
      blockerRetries: 0,
      validateStartedAt: '',
      status: 'paused',
    }),
    false,
  )
  assert.equal(isParkedLoop(undefined), false)
})

test('writePending + consumePending round trip on real fs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-flow-pending-root-'))
  const pendingDir = path.join(root, 'pi-flow', 'pending')
  await mkdir(pendingDir, { recursive: true })
  await seedParkedJournal(root, 'PMR-XTQQ', true)
  await writePending(pendingDir, validRecord('PMR-XTQQ'))

  const result = await consumePending(
    pendingDir,
    'PMR-XTQQ',
    journalVerifier(root),
  )
  assert.deepEqual(result, { consumed: true })
  // file is renamed, not deleted
  const consumed = await readFile(
    path.join(pendingDir, 'PMR-XTQQ.consumed.json'),
    'utf8',
  )
  assert.equal(parsePendingRecord(consumed)?.ref, 'PMR-XTQQ')
  await rm(root, { recursive: true, force: true })
})

test('two racing consumers consume exactly once (real fs rename race)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-flow-pending-race-'))
  const pendingDir = path.join(root, 'pi-flow', 'pending')
  await mkdir(pendingDir, { recursive: true })
  await seedParkedJournal(root, 'DP-71', true)
  await writePending(pendingDir, validRecord('DP-71'))

  const verify = journalVerifier(root)
  const [a, b] = await Promise.all([
    consumePending(pendingDir, 'DP-71', verify),
    consumePending(pendingDir, 'DP-71', verify),
  ])
  const consumed = [a, b].filter((r) => r.consumed)
  assert.equal(
    consumed.length,
    1,
    `exactly one winner: ${JSON.stringify([a, b])}`,
  )
  const names = await readdir(pendingDir)
  assert.deepEqual(names.sort(), ['DP-71.consumed.json'])
  await rm(root, { recursive: true, force: true })
})

test('stale record: verify-fail renames anyway and reports dropped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-flow-pending-stale-'))
  const pendingDir = path.join(root, 'pi-flow', 'pending')
  await mkdir(pendingDir, { recursive: true })
  // journal says paused — NOT parked → stale leftover
  await seedParkedJournal(root, 'PMR-OLD', false)
  await writePending(pendingDir, validRecord('PMR-OLD'))

  const result = await consumePending(
    pendingDir,
    'PMR-OLD',
    journalVerifier(root),
  )
  assert.deepEqual(result, { consumed: false, dropped: true })
  // renamed away so it can never be injected again
  const names = await readdir(pendingDir)
  assert.deepEqual(names, ['PMR-OLD.consumed.json'])
  await rm(root, { recursive: true, force: true })
})

test('missing pending file: ENOENT → consumed:false, no throw', async () => {
  const pendingDir = await tmpPendingDir()
  const result = await consumePending(pendingDir, 'PMR-NONE', async () => true)
  assert.deepEqual(result, { consumed: false })
  await rm(path.dirname(pendingDir), { recursive: true, force: true })
})

test('malformed pending file never throws; treated as dropped garbage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-flow-pending-bad-'))
  const pendingDir = path.join(root, 'pi-flow', 'pending')
  await mkdir(pendingDir, { recursive: true })
  await seedParkedJournal(root, 'PMR-BAD', true)
  await writeFile(path.join(pendingDir, 'PMR-BAD.json'), '{torn', 'utf8')

  const result = await consumePending(
    pendingDir,
    'PMR-BAD',
    journalVerifier(root),
  )
  assert.deepEqual(result, { consumed: false, dropped: true })
  await rm(root, { recursive: true, force: true })
})

test('invalid ref charset is rejected without touching the fs', async () => {
  const pendingDir = await tmpPendingDir()
  const result = await consumePending(pendingDir, '../escape', async () => true)
  assert.deepEqual(result, { consumed: false })
  assert.deepEqual(await readdir(pendingDir), [])
  await rm(path.dirname(pendingDir), { recursive: true, force: true })
})

test('clearPending removes the pending file, ignoring absence', async () => {
  const pendingDir = await tmpPendingDir()
  await writePending(pendingDir, validRecord('PMR-CLR'))
  await clearPending(pendingDir, 'PMR-CLR')
  assert.deepEqual(await readdir(pendingDir), [])
  // second call is a no-op
  await clearPending(pendingDir, 'PMR-CLR')
  await rm(path.dirname(pendingDir), { recursive: true, force: true })
})

test('sweepConsumed unlinks only .consumed.json files', async () => {
  const pendingDir = await tmpPendingDir()
  await writePending(pendingDir, validRecord('PMR-SWEEP'))
  await writeFile(path.join(pendingDir, 'PMR-SWEEP.consumed.json'), 'x', 'utf8')
  await writeFile(path.join(pendingDir, 'OTHER.consumed.json'), 'x', 'utf8')
  const swept = await sweepConsumed(pendingDir)
  assert.equal(swept, 2)
  assert.deepEqual(await readdir(pendingDir), ['PMR-SWEEP.json'])
  await rm(path.dirname(pendingDir), { recursive: true, force: true })
})
