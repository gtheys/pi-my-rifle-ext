// Unit tests for the PMR-XTQQ mode-aware writer seam (server/writer.ts) and
// the runServer config block. Routing is verified behaviorally against a
// temp agentDir: the full-writer path (recordRunEvent) writes the projection
// file, the journal-only path leaves it absent.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readConfigFile, resolveRunServerEnabled } from '../config.ts'
import {
  EXPECTED_SERVER_PROTOCOL_VERSION,
  pidFilePath,
} from '../server/lifecycle.ts'
import { createDaemonAliveProbe, createEventWriter } from '../server/writer.ts'

async function tmpAgentDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'pi-flow-writer-'))
}

// 'run-start' mutates the projection (a 'note' event does not), so the
// full-writer route is observable via the projection file.
function runStartEvent(ref: string) {
  return {
    kind: 'run-start' as const,
    at: new Date().toISOString(),
    ref,
    mode: 'personal' as const,
    trackRef: ref,
  }
}

function noteEvent(ref: string) {
  return {
    kind: 'note' as const,
    at: new Date().toISOString(),
    ref,
    text: 'writer seam test',
  }
}

function paths(agentDir: string, ref: string) {
  const statePath = path.join(agentDir, 'pi-flow', 'runs', `${ref}.json`)
  return {
    statePath,
    journalPath: path.join(agentDir, 'pi-flow', 'runs', `${ref}.journal.jsonl`),
  }
}

/** Fake a live, version-matching daemon pidfile pointing at this process. */
async function seedLivePidfile(agentDir: string): Promise<void> {
  await mkdir(path.dirname(pidFilePath(agentDir)), { recursive: true })
  await writeFile(
    pidFilePath(agentDir),
    JSON.stringify({
      pid: process.pid,
      version: EXPECTED_SERVER_PROTOCOL_VERSION,
      startedAt: new Date().toISOString(),
    }),
    'utf8',
  )
}

test('writer.record routes journal-only while the daemon probe reports alive', async () => {
  const agentDir = await tmpAgentDir()
  try {
    await seedLivePidfile(agentDir)
    const writer = createEventWriter(agentDir, createDaemonAliveProbe(agentDir))
    await writer.record(noteEvent('PMR-WR01'))
    const { statePath, journalPath } = paths(agentDir, 'PMR-WR01')
    // Journal-only route: journal appended, projection untouched.
    const journal = await readFile(journalPath, 'utf8')
    assert.match(journal, /PMR-WR01/)
    await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('writer.record uses the full writer when the daemon is absent', async () => {
  const agentDir = await tmpAgentDir()
  try {
    const writer = createEventWriter(agentDir, createDaemonAliveProbe(agentDir))
    await writer.record(runStartEvent('PMR-WR02'))
    const { statePath, journalPath } = paths(agentDir, 'PMR-WR02')
    // Full-writer route: projection written.
    const state = await readFile(statePath, 'utf8')
    assert.match(state, /PMR-WR02/)
    const journal = await readFile(journalPath, 'utf8')
    assert.match(journal, /PMR-WR02/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('writer.record falls back to the full writer when runServer is disabled', async () => {
  const agentDir = await tmpAgentDir()
  try {
    // A live pidfile exists, but the kill switch must make the probe report
    // absent → today's full-writer path permanently (plan decision 9).
    await seedLivePidfile(agentDir)
    const writer = createEventWriter(
      agentDir,
      createDaemonAliveProbe(agentDir, () => false),
    )
    await writer.record(runStartEvent('PMR-WR03'))
    const { statePath } = paths(agentDir, 'PMR-WR03')
    const state = await readFile(statePath, 'utf8')
    assert.match(state, /PMR-WR03/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('writer.record swallows io errors (best-effort convention)', async () => {
  // agentDir points at a FILE — every fs op under it fails with ENOTDIR.
  const agentDir = await tmpAgentDir()
  const fileAsDir = path.join(agentDir, 'not-a-dir')
  try {
    await writeFile(fileAsDir, 'x', 'utf8')
    const writer = createEventWriter(
      fileAsDir,
      createDaemonAliveProbe(fileAsDir),
    )
    // Must not throw.
    await writer.record(noteEvent('PMR-WR04'))
    await writer.recordJournalOnly(noteEvent('PMR-WR04'))
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('writer.recordJournalOnly never touches the projection', async () => {
  const agentDir = await tmpAgentDir()
  try {
    const writer = createEventWriter(agentDir, createDaemonAliveProbe(agentDir))
    await writer.recordJournalOnly(noteEvent('PMR-WR05'))
    const { statePath, journalPath } = paths(agentDir, 'PMR-WR05')
    await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/)
    const journal = await readFile(journalPath, 'utf8')
    assert.match(journal, /PMR-WR05/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('createDaemonAliveProbe probe failure degrades to absent', async () => {
  const agentDir = await tmpAgentDir()
  try {
    // Probe fn that throws must be treated as "daemon absent", not crash.
    const writer = createEventWriter(agentDir, async () => {
      throw new Error('probe exploded')
    })
    await writer.record(runStartEvent('PMR-WR06'))
    const { statePath } = paths(agentDir, 'PMR-WR06')
    const state = await readFile(statePath, 'utf8')
    assert.match(state, /PMR-WR06/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

// runServer config block (plan decision 9 — kill switch)

test('config: runServer block parses and validates', async () => {
  const agentDir = await tmpAgentDir()
  try {
    const file = path.join(agentDir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({ workRoots: [], runServer: { enabled: false } }),
      'utf8',
    )
    const cfg = await readConfigFile(file)
    assert.equal(cfg.runServer?.enabled, false)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('config: runServer.enabled defaults to undefined (treated as true)', async () => {
  const agentDir = await tmpAgentDir()
  try {
    const file = path.join(agentDir, 'config.json')
    await writeFile(file, JSON.stringify({ workRoots: [] }), 'utf8')
    const cfg = await readConfigFile(file)
    assert.equal(cfg.runServer?.enabled, undefined)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('resolveRunServerEnabled: absent/undefined/true enabled, only explicit false kills', () => {
  // The derivation both the session_start init and the /flow start sync use.
  assert.equal(resolveRunServerEnabled({ workRoots: [] }), true)
  assert.equal(resolveRunServerEnabled({ workRoots: [], runServer: {} }), true)
  assert.equal(
    resolveRunServerEnabled({ workRoots: [], runServer: { enabled: true } }),
    true,
  )
  assert.equal(
    resolveRunServerEnabled({ workRoots: [], runServer: { enabled: false } }),
    false,
  )
})

test('config: invalid runServer.enabled → clear throw mentioning the property', async () => {
  const agentDir = await tmpAgentDir()
  try {
    const file = path.join(agentDir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({ workRoots: [], runServer: { enabled: 'yes' } }),
      'utf8',
    )
    await assert.rejects(readConfigFile(file), /runServer/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
