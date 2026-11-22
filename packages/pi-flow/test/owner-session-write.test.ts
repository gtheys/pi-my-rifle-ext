// AIDEV-NOTE: PMR-T9ZQ 1.2 — owner-session WRITE sites (loop phase prompt).
// The event kind and its projection are pinned in run-state.test.ts (1.1);
// this file pins that the loop actually journals the event: once per phase
// prompt, with `process.pid` as the liveness carrier, with a null session
// file (unlike its journal-only `main-session` neighbour, which is skipped
// when no session file is known), and best-effort (a failing write never
// throws out of the loop). Fake-journal capture in the established
// loop-test seam style (see cost-main-session.test.ts).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createFlowLoop, type FlowLoopDeps } from '../flow/loop.ts'
import { createDaemonAliveProbe, createEventWriter } from '../server/writer.ts'

const REF = 'TP-1'
const SESSION_FILE = '/s/2026-11-07T07-00-00-000Z_aaaaaaaa-bbbb.jsonl'

interface Harness {
  deps: FlowLoopDeps
  events: Array<{ kind: string; [key: string]: unknown }>
  sent: string[]
}

function harness(sessionFile: string | null): Harness {
  const events: Harness['events'] = []
  const sent: string[] = []
  const deps: FlowLoopDeps = {
    notify: () => {},
    journal: (event) => {
      events.push(event as unknown as { kind: string; [key: string]: unknown })
    },
    readLabels: async () => [],
    readPlanState: async () => null,
    avenNote: async () => true,
    epicHasOpenChildren: async () => false,
    hasInFlightSubagent: () => false,
    sendPrompt: (prompt) => {
      sent.push(prompt)
    },
    getSessionFile: () => sessionFile,
    env: {},
  }
  return { deps, events, sent }
}

function startInput(phase = 'plan') {
  return {
    ref: REF,
    phase: phase as 'plan',
    promptInput: {
      mode: 'personal' as const,
      ref: REF,
      gitRoot: '/home/x/repo',
      workRoots: [],
    },
  }
}

function ownerEvents(h: Harness) {
  return h.events.filter((e) => e.kind === 'owner-session')
}

test('loop: phase prompt journals owner-session with the session file and this pid', async () => {
  const h = harness(SESSION_FILE)
  await createFlowLoop(h.deps).start(startInput())
  const owners = ownerEvents(h)
  assert.equal(owners.length, 1)
  const owner = owners[0]
  if (owner === undefined) return
  assert.equal(owner.ref, REF)
  assert.equal(owner.sessionFile, SESSION_FILE)
  assert.equal(owner.pid, process.pid)
  assert.equal(typeof owner.at, 'string')
  // The refresh annotates the phase prompt, so it lands after phase-start.
  const kinds = h.events.map((e) => e.kind)
  assert.ok(
    kinds.indexOf('phase-start') < kinds.indexOf('owner-session'),
    `owner-session must follow phase-start, got ${kinds.join(',')}`,
  )
})

test('loop: owner-session is journaled even with an unknown session file (pid carries liveness)', async () => {
  const h = harness(null)
  await createFlowLoop(h.deps).start(startInput())
  const owners = ownerEvents(h)
  assert.equal(owners.length, 1, 'owner-session must still be journaled')
  const owner = owners[0]
  if (owner === undefined) return
  assert.equal(owner.sessionFile, null)
  assert.equal(owner.pid, process.pid)
  // The journal-only main-session neighbour stays conditional.
  assert.equal(
    h.events.some((e) => e.kind === 'main-session'),
    false,
  )
})

test('loop: every phase prompt refreshes owner-session', async () => {
  const h = harness(SESSION_FILE)
  h.deps.readLabels = async () => ['planned']
  const loop = createFlowLoop(h.deps)
  await loop.start(startInput())
  await loop.onSettled()
  assert.equal(h.sent.length, 2, 'expected the implement prompt too')
  const owners = ownerEvents(h)
  assert.equal(owners.length, 2)
})

test('loop: a failing owner-session write never halts the run (production wiring)', async () => {
  // Production wires the loop's journal dep as `void journal(event)` over the
  // mode-aware writer (index.ts), and writer.record swallows io errors and
  // reports false. Mirror that wiring against an un writable agent dir: the
  // phase prompt must still be sent, the loop must stay active, and nothing
  // may reject.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-owner-best-'))
  const notADir = path.join(dir, 'file')
  writeFileSync(notADir, 'x', 'utf8')
  try {
    const writer = createEventWriter(notADir, createDaemonAliveProbe(notADir))
    const attempted: string[] = []
    const h = harness(SESSION_FILE)
    h.deps.journal = (event) => {
      attempted.push(event.kind)
      void writer.record(event)
    }
    const loop = createFlowLoop(h.deps)
    await loop.start(startInput())
    assert.equal(h.sent.length, 1, 'phase prompt still sent')
    assert.equal(loop.isActive(), true, 'run still armed')
    assert.equal(
      attempted.includes('owner-session'),
      true,
      'the owner-session write was still attempted',
    )
    // owner-session specifically: recording it against the broken dir reports
    // failure instead of throwing.
    const journaled = await writer.record({
      kind: 'owner-session',
      at: new Date().toISOString(),
      ref: REF,
      sessionFile: SESSION_FILE,
      pid: process.pid,
    })
    assert.equal(journaled, false, 'failed write is reported, not thrown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
