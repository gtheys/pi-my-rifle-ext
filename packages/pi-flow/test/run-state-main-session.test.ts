import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { collectMainSessionFiles } from '../flow/cost.ts'
import {
  type FlowRunEvent,
  recordRunEvent,
  runStatePath,
} from '../run-state.ts'

// Regression: recordRunEvent used to skip the journal append whenever the
// projection was unchanged, which dropped every 'main-session' event.
test('main-session events reach the journal through the REAL writer and do not rewrite the projection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-ms-'))
  try {
    const at = '2026-11-07T08:39:07.000Z'
    const ref = 'PMR-MS'
    await recordRunEvent(dir, { kind: 'run-start', at, ref, mode: 'personal' })
    await recordRunEvent(dir, {
      kind: 'phase-start',
      at,
      ref,
      phase: 'plan',
    })
    const statePath = runStatePath(dir, ref)
    assert.ok(statePath !== null)
    const before = readFileSync(statePath, 'utf8')
    await recordRunEvent(dir, {
      kind: 'main-session',
      at,
      ref,
      sessionFile: '/s/main.jsonl',
    })
    const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
    const events: FlowRunEvent[] = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      events.map((e) => e.kind),
      ['run-start', 'phase-start', 'main-session'],
    )
    assert.deepEqual(collectMainSessionFiles(events), ['/s/main.jsonl'])
    assert.equal(readFileSync(statePath, 'utf8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
