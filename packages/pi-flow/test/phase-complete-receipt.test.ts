// Tests for flow_phase_complete receipt journaling (PMR-4S6V): the tool
// records a 'flow_phase_complete' command receipt in the ReceiptJournal
// after a successful fresh label write AND on the already-complete fast
// path, best-effort — a throwing journal must never fail the tool.
// Stateful fake `aven` on PATH (edit mutates a state file that `show`
// reads back), same pattern as aven-workspace-cwd.test.ts.
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { setAvenSessionCwd } from '../index.ts'
import type { ReceiptJournal, ReceiptQuery } from '../run-state.ts'
import { registerPhaseCompleteTool } from '../tools/phase-complete.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-pc-bin-'))
const LABEL_STATE = path.join(BIN_DIR, 'labels.txt')
const EDIT_FAILS = path.join(BIN_DIR, 'edit-fails')
// `aven edit <ref> --label <label>` appends the label to LABEL_STATE (or
// exits non-zero when EDIT_FAILS exists, to simulate a write failure);
// `aven show <ref> --json` prints the ticket with the stored labels.
const SHIM = [
  '#!/bin/sh',
  `if [ -f "${EDIT_FAILS}" ] && [ "$1" = "edit" ]; then`,
  '  exit 1',
  'fi',
  'if [ "$1" = "edit" ]; then',
  `  printf '%s\\n' "$4" >> "${LABEL_STATE}"`,
  '  exit 0',
  'fi',
  'LABELS="[]"',
  `if [ -f "${LABEL_STATE}" ]; then`,
  `  LABELS="$(awk 'BEGIN{ORS=","} {print "\\""$0"\\""}' "${LABEL_STATE}" | sed 's/,$//')"`,
  'fi',
  `echo "{\\"ref\\":\\"PMR-TEST\\",\\"labels\\":[$LABELS]}"`,
].join('\n')
writeFileSync(path.join(BIN_DIR, 'aven'), SHIM)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

after(() => {
  setAvenSessionCwd(undefined)
})

type PhaseCompleteExecute = (
  toolCallId: string,
  params: {
    ref: string
    phase: 'plan' | 'implement' | 'validate' | 'feedback'
  },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

// In-memory ReceiptJournal fake: array-backed find/record keyed on
// (ref, command, target). recordThrowing makes record reject (best-effort
// probe). record also refuses to store a receipt before the label write
// happened — ordering proof for the fresh path.
function memReceipts(options?: {
  recordThrowing?: boolean
  requireLabelWritten?: boolean
}): ReceiptJournal & { entries: ReceiptQuery[] } {
  const entries: ReceiptQuery[] = []
  return {
    entries,
    async find(query: ReceiptQuery) {
      for (const entry of entries) {
        if (
          entry.ref === query.ref &&
          entry.command === query.command &&
          entry.target === query.target
        ) {
          return {
            command: query.command,
            target: query.target,
            status: 'ok' as const,
            at: new Date().toISOString(),
          }
        }
      }
      return null
    },
    async record(query: ReceiptQuery) {
      if (options?.recordThrowing === true) {
        throw new Error('journal write failed')
      }
      if (options?.requireLabelWritten === true && !existsSync(LABEL_STATE)) {
        throw new Error('receipt recorded before label write')
      }
      entries.push(query)
    },
  }
}

function phaseCompleteExecute(receipts?: ReceiptJournal): PhaseCompleteExecute {
  let execute: PhaseCompleteExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: PhaseCompleteExecute }) => {
      execute = options.execute
    },
  }
  if (receipts === undefined) {
    registerPhaseCompleteTool(
      mockPi as unknown as Parameters<typeof registerPhaseCompleteTool>[0],
    )
  } else {
    registerPhaseCompleteTool(
      mockPi as unknown as Parameters<typeof registerPhaseCompleteTool>[0],
      receipts,
    )
  }
  if (!execute) throw new Error('flow_phase_complete tool not registered')
  return execute
}

async function withFakeAven(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
  }
}

test('fresh path: ok result and receipt recorded for the phase', async () => {
  const receipts = memReceipts({ requireLabelWritten: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('t1', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /planned/)
    assert.equal(receipts.entries.length, 1)
    assert.deepEqual(receipts.entries[0], {
      ref: 'PMR-TEST',
      command: 'flow_phase_complete',
      target: 'plan',
    })
  })
})

test('fresh path: no receipt when the label write fails', async () => {
  const { rmSync } = await import('node:fs')
  rmSync(LABEL_STATE, { force: true })
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    // `show` still succeeds (labels empty) but `edit` exits non-zero, so
    // writeAvenLabel returns false and the tool reports a write error.
    writeFileSync(EDIT_FAILS, 'x')
    try {
      const result = await execute('t2', { ref: 'PMR-TEST', phase: 'plan' })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /aven write failed/)
      assert.equal(receipts.entries.length, 0)
    } finally {
      unlinkSync(EDIT_FAILS)
    }
  })
})

test('already path: result unchanged and receipt still recorded', async () => {
  writeFileSync(LABEL_STATE, 'planned\n')
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('t3', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /already recorded/)
    assert.equal(receipts.entries.length, 1)
    assert.deepEqual(receipts.entries[0], {
      ref: 'PMR-TEST',
      command: 'flow_phase_complete',
      target: 'plan',
    })
  })
})

test('best-effort: a throwing record leaves the fresh-path result ok', async () => {
  const receipts = memReceipts({ recordThrowing: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('t4', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /planned/)
  })
})

test('best-effort: a throwing record leaves the already-path result ok', async () => {
  writeFileSync(LABEL_STATE, 'planned\n')
  const receipts = memReceipts({ recordThrowing: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('t5', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /already recorded/)
  })
})

test('refusal path: no receipt recorded on gate refusal', async () => {
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    // The gate is pure: 'implement' with no labels at all is refused by
    // canImplement; no receipt may be journaled on an error path.
    rmSync(LABEL_STATE, { force: true })
    const result = await execute('t6', {
      ref: 'PMR-TEST',
      phase: 'implement',
    })
    assert.equal(result.isError, true)
    assert.equal(receipts.entries.length, 0)
  })
})

test('receipts parameter is optional (defaulted, index.ts untouched)', () => {
  let registered = false
  const mockPi = {
    registerTool: () => {
      registered = true
    },
  }
  registerPhaseCompleteTool(
    mockPi as unknown as Parameters<typeof registerPhaseCompleteTool>[0],
  )
  assert.equal(registered, true)
})
