// AIDEV-NOTE: PMR-XTQQ subtask 1.4 — real-daemon integration test. Spawns the
// actual server/daemon.ts entry via process.execPath (type stripping must work
// on the running runtime) against a mkdtemp agent dir, mirroring the
// flow-viewer.test.mjs harness (seed journal BEFORE spawn so fs.watch attaches,
// poll ≤5s, SIGKILL + rmSync in finally). `pending/` is a phase-2 concept and
// the daemon does not create it yet — asserted here only as "its absence does
// not break startup" (see subtask report).
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

const DAEMON_SCRIPT = join(import.meta.dirname, '../server/daemon.ts')

test('real daemon: pidfile, projection, journal append pickup, stays alive', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-flow-daemon-it-'))
  const piFlowDir = join(agentDir, 'pi-flow')
  const runsDir = join(piFlowDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const ref = 'PMR-TEST'
  const journalFile = join(runsDir, `${ref}.journal.jsonl`)
  const projectionFile = join(runsDir, `${ref}.json`)
  const pidFile = join(piFlowDir, 'server.pid')

  // Journal must exist before spawn so fs.watch attaches.
  writeFileSync(
    journalFile,
    `${JSON.stringify({
      kind: 'run-start',
      at: '2026-11-15T01:00:00Z',
      ref,
      mode: 'personal',
    })}\n`,
  )

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    env: { ...process.env, PI_FLOW_AGENT_DIR: agentDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    // Pidfile appears with our child's pid.
    await waitFor(() => existsSync(pidFile), 'pidfile')
    const pidInfo = JSON.parse(readFileSync(pidFile, 'utf8'))
    assert.equal(pidInfo.pid, child.pid)

    // Seeded journal is reprojected.
    await waitFor(
      () => existsSync(projectionFile),
      'projection for seeded journal',
    )
    const projected = JSON.parse(readFileSync(projectionFile, 'utf8'))
    assert.equal(projected.ref, ref)
    assert.equal(projected.currentPhase, null)

    // A journal append after spawn is picked up within the poll window.
    const markerPhase = `probe${Math.random().toString(36).slice(2)}`
    appendFileSync(
      journalFile,
      `${JSON.stringify({
        kind: 'phase-start',
        at: new Date().toISOString(),
        ref,
        phase: markerPhase,
      })}\n`,
    )
    await waitFor(() => {
      if (!existsSync(projectionFile)) return false
      const state = JSON.parse(readFileSync(projectionFile, 'utf8'))
      return state.currentPhase === markerPhase
    }, 'projection reflects appended phase-start')

    // The daemon outlives its spawner: still running once the test's own
    // setup/await work has returned.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(child.exitCode, null, 'daemon exited prematurely')
    assert.equal(child.signalCode, null, 'daemon was signaled prematurely')

    // pending/ is not created by the phase-1 daemon; its absence must not
    // have broken anything (startup reached pidfile + projections above).
    assert.equal(existsSync(join(piFlowDir, 'pending')), false)
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

async function waitFor(predicate, what) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}
