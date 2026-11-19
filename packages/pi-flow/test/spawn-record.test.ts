import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { collectSpawnNotes, parseSpawnNote } from '../flow/cost.ts'
import {
  isJournalOnlyEvent,
  journalPathFor,
  recordRunEvent,
  runStatePath,
} from '../run-state.ts'

type SpawnRecordEvent = Extract<
  import('../run-state.ts').FlowRunEvent,
  { kind: 'spawn-record' }
>

function spawnRecord(
  overrides: Partial<SpawnRecordEvent> = {},
): SpawnRecordEvent {
  const event: SpawnRecordEvent = {
    kind: 'spawn-record',
    at: '2026-11-19T12:00:00.000Z',
    ref: 'PMR-C998',
    childId: 'child-9',
    name: 'worker-2',
    spawnKind: 'spawn',
  }
  if (overrides.at !== undefined) event.at = overrides.at
  if (overrides.ref !== undefined) event.ref = overrides.ref
  if (overrides.childId !== undefined) event.childId = overrides.childId
  if (overrides.name !== undefined) event.name = overrides.name
  if (overrides.spawnKind !== undefined) event.spawnKind = overrides.spawnKind
  if (overrides.subtask !== undefined) event.subtask = overrides.subtask
  if (overrides.sessionFile !== undefined) {
    event.sessionFile = overrides.sessionFile
  }
  return event
}

function phaseStart(
  at: string,
  phase: import('../run-state.ts').FlowPhase,
): import('../run-state.ts').FlowRunEvent {
  return { kind: 'phase-start', at, ref: 'PMR-C998', phase }
}

test('spawn-record: parseSpawnNote rejects structured events, collectSpawnNotes yields the equivalent SpawnNote', () => {
  // Built exactly the way index.ts onFlowSpawn builds it (subtask /
  // sessionFile present only when defined).
  const event = spawnRecord({
    subtask: 'PMR-A1',
    sessionFile: '/sessions/child-9.jsonl',
  })

  // AIDEV-NOTE: PMR-C998 retired note-text emission — the structured event
  // carries no note text, so the legacy text parser must never match it
  // (serialization, ref, etc. are not spawn-note prose).
  assert.equal(parseSpawnNote(JSON.stringify(event), 'implement'), null)

  // The equivalent legacy note it would have replaced still parses.
  const legacy = parseSpawnNote(
    'subagent child-9 ("worker-2") spawn for subtask PMR-A1 — attribution env stamped, session="/sessions/child-9.jsonl"',
    'implement',
  )
  assert.ok(legacy !== null)

  const notes = collectSpawnNotes([
    phaseStart('2026-11-19T11:59:00.000Z', 'implement'),
    event,
  ])
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0], {
    childId: 'child-9',
    name: 'worker-2',
    kind: 'spawn',
    subtask: 'PMR-A1',
    sessionFile: '/sessions/child-9.jsonl',
    at: '2026-11-19T12:00:00.000Z',
    phase: 'implement',
  })
  // Same attribution fields as the legacy note would have produced.
  assert.equal(notes[0].childId, legacy.childId)
  assert.equal(notes[0].name, legacy.name)
  assert.equal(notes[0].kind, legacy.kind)
  assert.equal(notes[0].subtask, legacy.subtask)
  assert.equal(notes[0].sessionFile, legacy.sessionFile)
  assert.equal(notes[0].phase, legacy.phase)
})

test('spawn-record: legacy note-only journal still yields the same notes', () => {
  // Shapes copied from test/cost.test.ts — the pre-Phase-1 format.
  const events: import('../run-state.ts').FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-07T01:00:00Z',
      ref: 'R',
      mode: 'work',
    },
    phaseStart('2026-11-07T01:01:00Z', 'plan'),
    {
      kind: 'note',
      at: '2026-11-07T01:02:00Z',
      ref: 'R',
      text: 'subagent child-1 ("scout") spawn — attribution env stamped, session="/sessions/s1.jsonl"',
    },
    {
      kind: 'phase-complete',
      at: '2026-11-07T01:10:00Z',
      ref: 'R',
      phase: 'plan',
      label: 'done-plan',
    },
    phaseStart('2026-11-07T01:11:00Z', 'implement'),
    {
      kind: 'note',
      at: '2026-11-07T01:12:00Z',
      ref: 'R',
      text: 'subagent child-2 ("worker") spawn for subtask PMR-A1 — attribution env stamped',
    },
  ]
  const notes = collectSpawnNotes(events)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].childId, 'child-1')
  assert.equal(notes[0].name, 'scout')
  assert.equal(notes[0].kind, 'spawn')
  assert.equal(notes[0].subtask, null)
  assert.equal(notes[0].sessionFile, '/sessions/s1.jsonl')
  assert.equal(notes[0].phase, 'plan')
  assert.equal(notes[0].at, '2026-11-07T01:02:00Z')
  assert.equal(notes[1].childId, 'child-2')
  assert.equal(notes[1].name, 'worker')
  assert.equal(notes[1].subtask, 'PMR-A1')
  assert.equal(notes[1].sessionFile, null)
  assert.equal(notes[1].phase, 'implement')
  assert.equal(notes[1].at, '2026-11-07T01:12:00Z')
})

test('spawn-record: mixed journal rolls up structured and legacy notes', () => {
  const events: import('../run-state.ts').FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-19T10:00:00Z',
      ref: 'R',
      mode: 'work',
    },
    phaseStart('2026-11-19T10:01:00Z', 'plan'),
    // structured (new writer)
    spawnRecord({
      at: '2026-11-19T10:02:00Z',
      ref: 'R',
      childId: 'c-new',
      name: 'scout-new',
      spawnKind: 'spawn',
      sessionFile: '/sessions/new.jsonl',
    }),
    // legacy note (old journal tail)
    {
      kind: 'note',
      at: '2026-11-19T10:03:00Z',
      ref: 'R',
      text: 'subagent c-old ("scout-old") spawn — attribution env stamped, session="/sessions/old.jsonl"',
    },
    {
      kind: 'phase-complete',
      at: '2026-11-19T10:10:00Z',
      ref: 'R',
      phase: 'plan',
      label: 'done-plan',
    },
    phaseStart('2026-11-19T10:11:00Z', 'implement'),
    // structured without optional fields (subtask/sessionFile unknown)
    spawnRecord({
      at: '2026-11-19T10:12:00Z',
      ref: 'R',
      childId: 'c-bare',
      name: 'worker-bare',
      spawnKind: 'resume',
    }),
    // legacy note with subtask
    {
      kind: 'note',
      at: '2026-11-19T10:13:00Z',
      ref: 'R',
      text: 'subagent c-sub ("worker-sub") resume for subtask PMR-B2 — attribution env stamped',
    },
  ]
  const notes = collectSpawnNotes(events)
  assert.equal(notes.length, 4)

  assert.deepEqual(notes[0], {
    childId: 'c-new',
    name: 'scout-new',
    kind: 'spawn',
    subtask: null,
    sessionFile: '/sessions/new.jsonl',
    at: '2026-11-19T10:02:00Z',
    phase: 'plan',
  })
  assert.deepEqual(notes[1], {
    childId: 'c-old',
    name: 'scout-old',
    kind: 'spawn',
    subtask: null,
    sessionFile: '/sessions/old.jsonl',
    at: '2026-11-19T10:03:00Z',
    phase: 'plan',
  })
  assert.deepEqual(notes[2], {
    childId: 'c-bare',
    name: 'worker-bare',
    kind: 'resume',
    subtask: null,
    sessionFile: null,
    at: '2026-11-19T10:12:00Z',
    phase: 'implement',
  })
  assert.deepEqual(notes[3], {
    childId: 'c-sub',
    name: 'worker-sub',
    kind: 'resume',
    subtask: 'PMR-B2',
    sessionFile: null,
    at: '2026-11-19T10:13:00Z',
    phase: 'implement',
  })
})

test('spawn-record: recordRunEvent appends the journal line and never touches the projection', async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-spawn-record-'))
  const ref = 'PMR-C998'
  const statePath = runStatePath(agentDir, ref)
  assert.ok(statePath !== null)
  const journalPath = journalPathFor(statePath)

  const ioCalls: { op: string; path: string }[] = []
  const record = (op: string, p: string) => {
    ioCalls.push({ op, path: p })
  }
  const io = {
    readFile: async (p: string) => {
      record('readFile', p)
      const err = new Error('ENOENT') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
    appendFile: async (p: string, data: string) => {
      record('appendFile', p)
      await import('node:fs/promises').then((fs) =>
        fs.appendFile(p, data, 'utf8'),
      )
    },
    writeFile: async (p: string, _data: string) => {
      record('writeFile', p)
      throw new Error(
        'projection must not be rewritten for journal-only events',
      )
    },
    mkdir: async (dir: string, recursive: true) => {
      record('mkdir', dir)
      await import('node:fs/promises').then((fs) =>
        fs.mkdir(dir, { recursive }),
      )
    },
  }

  const event = spawnRecord({
    ref,
    subtask: 'PMR-A1',
    sessionFile: '/sessions/child-9.jsonl',
  })
  assert.equal(isJournalOnlyEvent(event), true)

  await recordRunEvent(agentDir, event, io)

  // Exactly one append to the journal, no projection writes.
  const appends = ioCalls.filter((c) => c.op === 'appendFile')
  assert.equal(appends.length, 1)
  assert.equal(appends[0].path, journalPath)
  assert.equal(
    ioCalls.some((c) => c.op === 'writeFile'),
    false,
  )
  // The projection file is READ (pre-existing behavior) but never written.
  const projectionWrites = ioCalls.filter(
    (c) => c.op !== 'readFile' && c.path === statePath,
  )
  assert.equal(projectionWrites.length, 0)

  // The journal line round-trips through collectSpawnNotes.
  const raw = await readFile(journalPath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  assert.equal(lines.length, 1)
  const parsed: unknown = JSON.parse(lines[0])
  assert.deepEqual(parsed, event)
  const notes = collectSpawnNotes([
    parsed as import('../run-state.ts').FlowRunEvent,
  ])
  assert.equal(notes.length, 1)
  assert.equal(notes[0].childId, 'child-9')
  assert.equal(notes[0].subtask, 'PMR-A1')
  assert.equal(notes[0].sessionFile, '/sessions/child-9.jsonl')
})
