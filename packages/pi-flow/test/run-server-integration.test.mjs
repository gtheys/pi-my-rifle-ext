// AIDEV-NOTE: PMR-XTQQ subtask 1.4 — real-daemon integration test. Spawns the
// actual server/daemon.ts entry via process.execPath (type stripping must work
// on the running runtime) against a mkdtemp agent dir, mirroring the
// flow-viewer.test.mjs harness (seed journal BEFORE spawn so fs.watch attaches,
// poll ≤5s, SIGKILL + rmSync in finally). The second test (subtask 3.2)
// exercises pending maintenance: a parked loop-state produces
// pending/<ref>.json, a terminal snapshot clears it, and a stray
// <ref>.consumed.json is swept.
// AIDEV-NOTE: PMR-7B8M — the daemon records its spawner's checkout SHA and
// (rev 2) repo identity in server.pid (via PI_FLOW_DAEMON_GIT_SHA /
// PI_FLOW_DAEMON_GIT_ROOT) so later sessions can warn about staleness — and
// stay silent for a daemon that belongs to another repo: the first test asserts
// both land in the pidfile, the no-runs dir test asserts both keys stay absent
// when the spawn env carried none.
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
    env: {
      ...process.env,
      PI_FLOW_AGENT_DIR: agentDir,
      // PMR-7B8M ISC-1: the spawn-side checkout SHA must land in the pidfile.
      PI_FLOW_DAEMON_GIT_SHA: 'a'.repeat(40),
      // PMR-7B8M rev 2: so must the repo identity (main-worktree path).
      PI_FLOW_DAEMON_GIT_ROOT: agentDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    // Pidfile appears with our child's pid (torn-write tolerant read,
    // PMR-572Y).
    let pidInfo = null
    await waitFor(() => {
      pidInfo = readJsonTolerant(pidFile)
      return pidInfo !== null
    }, 'pidfile')
    assert.equal(pidInfo?.pid, child.pid)
    assert.equal(
      pidInfo?.gitSha,
      'a'.repeat(40),
      'pidfile must record the spawn env git SHA (ISC-1)',
    )
    assert.equal(
      pidInfo?.gitRoot,
      agentDir,
      'pidfile must record the spawn env git root (rev 2, repo identity)',
    )

    // Seeded journal is reprojected (torn-write tolerant read, PMR-572Y).
    let projected = null
    await waitFor(() => {
      projected = readJsonTolerant(projectionFile)
      return projected !== null
    }, 'projection for seeded journal')
    assert.equal(projected?.ref, ref)
    assert.equal(projected?.currentPhase, null)

    // A journal append after spawn is picked up within the poll window.
    // Marker must be a guard-valid phase (PHASES vocabulary): the daemon's
    // projection only surfaces vocabulary it can validate, so a junk string
    // would never appear in currentPhase and the wait would time out.
    const markerPhase = 'plan'
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
      // Torn-write tolerant read (PMR-572Y): a mid-rewrite projection parses
      // as "not ready yet", the poll retries.
      const state = readJsonTolerant(projectionFile)
      return state?.currentPhase === markerPhase
    }, 'projection reflects appended phase-start')

    // The daemon outlives its spawner: still running once the test's own
    // setup/await work has returned.
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(child.exitCode, null, 'daemon exited prematurely')
    assert.equal(child.signalCode, null, 'daemon was signaled prematurely')

    // pending/ is created harmlessly at daemon startup (spec phase-1
    // acceptance); its presence must not have broken anything (startup
    // reached pidfile + projections above).
    await waitFor(() => existsSync(join(piFlowDir, 'pending')), 'pending dir')
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

test('real daemon: parked loop-state creates pending record, terminal snapshot clears it, consumed swept', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-flow-daemon-it-'))
  const piFlowDir = join(agentDir, 'pi-flow')
  const runsDir = join(piFlowDir, 'runs')
  mkdirSync(runsDir, { recursive: true })

  const ref = 'PMR-PEND'
  const journalFile = join(runsDir, `${ref}.journal.jsonl`)
  const pendingFile = join(piFlowDir, 'pending', `${ref}.json`)
  const consumedFile = join(piFlowDir, 'pending', `${ref}.consumed.json`)

  const appendEvent = (event) => {
    appendFileSync(journalFile, `${JSON.stringify(event)}\n`)
  }
  appendEvent({
    kind: 'run-start',
    at: '2026-11-15T01:00:00Z',
    ref,
    mode: 'personal',
  })
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
  child.stderr.setEncoding('utf8')

  try {
    // Pending record appears ≤5s from the parked journal.
    await waitFor(() => existsSync(pendingFile), 'pending record')
    const record = JSON.parse(readFileSync(pendingFile, 'utf8'))
    assert.equal(record.ref, ref)
    assert.equal(record.phase, 'plan')
    assert.equal(record.sourceAt, '2026-11-15T01:00:01Z')

    // A fake consumed marker (left from an earlier consume) is swept.
    mkdirSync(join(piFlowDir, 'pending'), { recursive: true })
    writeFileSync(consumedFile, '{}\n')
    await waitFor(() => !existsSync(consumedFile), 'consumed sweep')

    // Terminal loop-state appended AFTER spawn clears the pending record.
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
    await waitFor(() => !existsSync(pendingFile), 'pending record cleared')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(agentDir, { recursive: true, force: true })
  }
})

// AIDEV-NOTE: PMR-7B8M 1.8 — 20s ceiling, was 5s: under the root all-workspaces
// parallel suite (the flow_land gate command) the real-daemon spawn + first
// projection can exceed 5s on a loaded machine — reproduced identically on main
// (cab2428), so a pre-existing load flake, not a feature regression. Same class
// as the PMR-572Y torn-write note below ("refused a landing"). The 100ms poll
// is unchanged: green runs finish just as fast, only the failure ceiling moves.
async function waitFor(predicate, what) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// AIDEV-NOTE: PMR-572Y — the daemon writes pidfiles and projections with a
// truncating fs.writeFile, so a poll read (or a read right after existsSync
// flips) can catch a torn or empty file mid-write; under full-suite load that
// once crashed this suite's JSON.parse with "Unexpected end of input" and
// refused a landing. Parse failures are NOT daemon bugs — the daemon's own
// journal read already skips torn tails (readRunEvents, PMR-EA8X) — so the
// test treats an unparsable read as "not ready yet" and lets the poll retry.
const readJsonTolerant = (file) => {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// AIDEV-NOTE: PMR-XTQQ review-blocker regression — the daemon MUST stay alive
// when runs/ does not exist at startup (the default first-/flow path): the
// ref'd 1s poll is the keepalive backstop when fs.watch fails with ENOENT.
// The old code unref'd the poll timer and exited within milliseconds after
// writing its pidfile. Also proves the degraded-to-poll path picks up a
// journal created AFTER startup (watcher can't be attached to it).
test('real daemon: no runs/ dir at startup → stays alive on poll, picks up later-created journal', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-flow-daemon-it-'))
  // Deliberately NO pi-flow/ dir at all.
  const piFlowDir = join(agentDir, 'pi-flow')
  const runsDir = join(piFlowDir, 'runs')
  const pidFile = join(piFlowDir, 'server.pid')

  const ref = 'PMR-LATE'
  const journalFile = join(runsDir, `${ref}.journal.jsonl`)
  const projectionFile = join(runsDir, `${ref}.json`)

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    // PMR-7B8M: no PI_FLOW_DAEMON_GIT_SHA in the spawn env → the pidfile keeps
    // the pre-feature shape (no gitSha key at all), and it is stripped from the
    // inherited environment so a polluted parent cannot leak through the spread.
    // Rev 2 adds the identical treatment for PI_FLOW_DAEMON_GIT_ROOT.
    env: (() => {
      const env = { ...process.env, PI_FLOW_AGENT_DIR: agentDir }
      delete env.PI_FLOW_DAEMON_GIT_SHA
      delete env.PI_FLOW_DAEMON_GIT_ROOT
      return env
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    // Pidfile appears even though runs/ never existed (torn-write tolerant
    // read, PMR-572Y).
    let pidInfo = null
    await waitFor(() => {
      pidInfo = readJsonTolerant(pidFile)
      return pidInfo !== null
    }, 'pidfile')
    assert.equal(pidInfo?.pid, child.pid)
    assert.equal(
      pidInfo?.gitSha,
      undefined,
      'pidfile must omit gitSha when the spawn env carried none',
    )
    assert.equal(
      pidInfo?.gitRoot,
      undefined,
      'pidfile must omit gitRoot when the spawn env carried none',
    )
    assert.equal(
      'gitRoot' in (pidInfo ?? {}),
      false,
      'gitRoot key must be absent, not undefined (rev 2)',
    )

    // THE BLOCKER: daemon must STILL be alive after 1.5s with no runs/ dir
    // (old code exited code 0 within milliseconds).
    await sleep(1_500)
    assert.equal(child.exitCode, null, 'daemon exited while runs/ missing')
    assert.equal(child.signalCode, null, 'daemon was signaled prematurely')

    // Create the journal AFTER startup (fs.watch never attached to runs/) —
    // the poll scan must pick it up and produce the projection ≤5s.
    mkdirSync(runsDir, { recursive: true })
    writeFileSync(
      journalFile,
      `${JSON.stringify({
        kind: 'run-start',
        at: '2026-11-15T01:00:00Z',
        ref,
        mode: 'personal',
      })}\n`,
    )
    await waitFor(
      () => existsSync(projectionFile),
      'projection for post-startup journal (poll backstop)',
    )

    // Marker must be a guard-valid phase (PHASES vocabulary) — same reason
    // as the first daemon test above; junk strings never reach the
    // projection's currentPhase.
    const markerPhase = 'plan'
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
      // Torn-write tolerant read (PMR-572Y): a mid-rewrite projection parses
      // as "not ready yet", the poll retries.
      const state = readJsonTolerant(projectionFile)
      return state?.currentPhase === markerPhase
    }, 'projection reflects appended phase-start')

    assert.equal(child.exitCode, null, 'daemon exited after journal pickup')
    assert.equal(child.signalCode, null, 'daemon was signaled after pickup')
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

// AIDEV-NOTE: (b) pidfile cleanup — a clean SIGTERM shutdown unlinks
// server.pid best-effort; SIGKILL (used by the other tests) intentionally
// leaves it, liveness probing is the source of truth.
test('real daemon: SIGTERM shutdown removes pidfile and exits cleanly', async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-flow-daemon-it-'))
  const piFlowDir = join(agentDir, 'pi-flow')
  const runsDir = join(piFlowDir, 'runs')
  mkdirSync(runsDir, { recursive: true })
  const pidFile = join(piFlowDir, 'server.pid')

  const ref = 'PMR-TERM'
  writeFileSync(
    join(runsDir, `${ref}.journal.jsonl`),
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

  try {
    await waitFor(() => existsSync(pidFile), 'pidfile')
    child.kill('SIGTERM')
    await waitFor(() => !existsSync(pidFile), 'pidfile removal on SIGTERM')
    await waitFor(() => child.exitCode !== null, 'daemon exit')
    assert.equal(child.exitCode, 0)
    assert.equal(child.signalCode, null, 'daemon should exit cleanly')
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    rmSync(agentDir, { recursive: true, force: true })
  }
})
