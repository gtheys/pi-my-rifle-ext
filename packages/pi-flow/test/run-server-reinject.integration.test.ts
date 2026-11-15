// AIDEV-NOTE: PMR-XTQQ subtask 3.4 — end-to-end re-injection integration test.
// One test drives the full cross-process chain against a REAL daemon and the
// REAL fs, with only the sender faked:
//   park (seeded parked journal) → daemon writes pending/<ref>.json
//   → session A consumes (exactly one /flow injection, record renamed away)
//   → session B consumes again → no-op (ENOENT on the rename)
//   → daemon SIGKILLed, stale hand-written record whose verify fails is
//     dropped with the manual-rerun fallback notify, no injection.
// Harness mirrors run-server-integration.test.mjs (mkdtemp agent dir,
// PI_FLOW_AGENT_DIR, poll ≤5s, SIGKILL + rmSync in finally). sweepConsumed is
// exercised by its own suite (server-pending / 3.2 daemon test) so only a
// cheap direct call proves the consumed marker is sweepable here.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resumedMessage, resumeParkedRun } from '../server/consumer.ts'
import { defaultPendingIo, sweepConsumed } from '../server/pending.ts'

const DAEMON_SCRIPT = join(import.meta.dirname, '../server/daemon.ts')

interface SentMessage {
  text: string
}

test('re-injection loop: park → consume once → idempotent → stale dropped (real daemon)', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-flow-reinject-it-'))
  const piFlowDir = join(agentDir, 'pi-flow')
  const runsDir = join(piFlowDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const ref = 'PMR-REINJ'
  const journalFile = join(runsDir, `${ref}.journal.jsonl`)
  const pendingDir = join(piFlowDir, 'pending')
  const pendingFile = join(pendingDir, `${ref}.json`)
  const consumedFile = join(pendingDir, `${ref}.consumed.json`)

  // Seed a parked journal: run-start + loop-state awaitingOutcome=true.
  const appendEvent = (event: unknown) => {
    appendFileSync(journalFile, `${JSON.stringify(event)}\n`)
  }
  writeFileSync(
    journalFile,
    `${JSON.stringify({
      kind: 'run-start',
      at: '2026-11-15T01:00:00Z',
      ref,
      mode: 'personal',
    })}\n`,
  )
  appendEvent({
    kind: 'loop-state',
    at: '2026-11-15T01:00:01Z',
    ref,
    loop: {
      phase: 'plan',
      awaitingOutcome: true,
      blockerRetries: 0,
      validateStartedAt: '',
      status: 'running',
    },
  })

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: { ...process.env, PI_FLOW_AGENT_DIR: agentDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const sent: SentMessage[] = []
  const notifyLog: string[] = []

  const makeDeps = () => ({
    ref,
    agentDir,
    pendingDir,
    enabled: () => true,
    loopActive: () => false,
    latch: new Set<string>(),
    notify: (message: string, _level: 'info' | 'warning' | 'error') => {
      notifyLog.push(message)
    },
    send: (message: string) => {
      sent.push({ text: message })
    },
    io: defaultPendingIo,
  })

  try {
    // Daemon parks the run: pending/<ref>.json appears ≤5s.
    await waitFor(() => existsSync(pendingFile), 'pending record')
    const record = JSON.parse(readFileSync(pendingFile, 'utf8'))
    assert.equal(record.ref, ref)
    assert.equal(record.phase, 'plan')

    // --- Session A: consume + inject exactly once.
    await resumeParkedRun(makeDeps())
    assert.equal(sent.length, 1, 'session A must inject exactly once')
    assert.equal(sent[0].text, `/flow ${ref}`)
    assert.equal(
      notifyLog.some((m) => m === resumedMessage(ref)),
      true,
      'session A must notify the resumed message',
    )
    assert.equal(existsSync(pendingFile), false, 'pending record consumed')
    assert.equal(existsSync(consumedFile), true, 'consumed marker present')

    // --- Session B: fresh latch, record already consumed → no injection.
    await resumeParkedRun(makeDeps())
    assert.equal(sent.length, 1, 'session B must NOT inject again')

    // --- Degradation: daemon killed, stale leftover record with a journal
    // that advanced past parked → verify fails → dropped, no injection.
    child.kill('SIGKILL')
    await waitFor(
      () => child.signalCode === 'SIGKILL',
      'daemon killed after degradation setup',
    )
    mkdirSync(pendingDir, { recursive: true })
    writeFileSync(
      pendingFile,
      `${JSON.stringify({
        schema: 'gtheys.pi-flow.pending.v1',
        ref,
        phase: 'plan',
        createdAt: '2026-11-15T01:00:00Z',
        sourceAt: '2026-11-15T01:00:01Z',
      })}\n`,
    )
    appendEvent({
      kind: 'loop-state',
      at: new Date().toISOString(),
      ref,
      loop: {
        phase: 'plan',
        awaitingOutcome: false,
        blockerRetries: 0,
        validateStartedAt: '',
        status: 'done',
      },
    })
    await resumeParkedRun(makeDeps())
    assert.equal(sent.length, 1, 'stale record must NOT inject')
    assert.equal(existsSync(pendingFile), false, 'stale record dropped')
    assert.equal(
      existsSync(consumedFile),
      true,
      'stale record renamed to consumed',
    )

    // Cheap sweep proof (sweep has its own suites): the dropped marker goes.
    const swept = await sweepConsumed(pendingDir, defaultPendingIo)
    assert.ok(swept >= 1, 'consumed marker must be sweepable')
    assert.equal(existsSync(consumedFile), false, 'consumed marker swept')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(agentDir, { recursive: true, force: true })
  }
  if (stderr.includes('PI_FLOW_AGENT_DIR must be set')) {
    throw new Error(`daemon rejected env: ${stderr}`)
  }
})

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}
