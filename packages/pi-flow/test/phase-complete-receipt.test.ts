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
  readFileSync,
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
// PMR-3MTZ: the spec-answer receipt file the fake `aven show --full` serves
// (empty/absent = no receipt; 'approve'/'reject' = the human's recorded
// answer). READ_FAILS makes the --full read emit an Error line on stderr.
const ANSWER_FILE = path.join(BIN_DIR, 'spec-answer')
const READ_FAILS = path.join(BIN_DIR, 'read-fails')
// PMR-J6TW: LABELS_READ_FAILS makes the labels read (`aven show --json`)
// exit non-zero so readAvenLabels fails closed — the oneshot exemption must
// NOT bypass a failed labels read.
const LABELS_READ_FAILS = path.join(BIN_DIR, 'labels-read-fails')
// `aven edit <ref> --label <label>` appends the label to LABEL_STATE (or
// exits non-zero when EDIT_FAILS exists, to simulate a write failure);
// `aven show <ref> --json` prints the ticket with the stored labels.
const SHIM = [
  '#!/bin/sh',
  `if [ -f "${EDIT_FAILS}" ] && [ "$1" = "edit" ]; then`,
  '  exit 1',
  'fi',
  // PMR-3MTZ: `aven show <ref> --full` — guarded read for readGateAnswer.
  // First line must resolve to the ref; the metadata block carries the
  // spec-answer receipt. stderr Error line = read failure (fail closed).
  'if [ "$1" = "show" ] && [ "$3" = "--full" ]; then',
  '  echo "PMR-TEST status=todo"',
  `  if [ -f "${READ_FAILS}" ]; then`,
  '    echo "Error: simulated read failure" >&2',
  '  fi',
  `  if [ -f "${ANSWER_FILE}" ]; then`,
  '    echo "metadata field_id=f1 key=spec-answer"',
  '    echo "value<<EOF"',
  `    cat "${ANSWER_FILE}"`,
  '    echo "EOF"',
  '  fi',
  '  exit 0',
  'fi',
  `if [ "$1" = "show" ] && [ -f "${LABELS_READ_FAILS}" ]; then`,
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

function phaseCompleteExecute(
  receipts?: ReceiptJournal,
  isYoloRun?: (ref: string) => Promise<boolean>,
): PhaseCompleteExecute {
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
      undefined,
      isYoloRun,
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
  // PMR-3MTZ: the plan fresh path now requires the human approve receipt.
  writeFileSync(ANSWER_FILE, 'approve\n')
  rmSync(LABEL_STATE, { force: true })
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
  // PMR-3MTZ: plan needs the approve receipt to reach the write attempt.
  writeFileSync(ANSWER_FILE, 'approve\n')
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
  rmSync(LABEL_STATE, { force: true })
  // PMR-3MTZ: plan needs the approve receipt to reach the fresh path.
  writeFileSync(ANSWER_FILE, 'approve\n')
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

// AIDEV-NOTE: PMR-3MTZ — receipt-gate tests for the plan phase. The fresh
// write path must refuse unless readGateAnswer(ref, 'spec') === 'approve':
// absent/unreadable receipt and a 'reject' answer both fail closed; the
// already-complete fast path stays receipt-free (idempotency, PMR-4S6V);
// implement/validate/feedback remain label-order-only.
test('plan fresh path: refuses without an approve receipt', async () => {
  rmSync(LABEL_STATE, { force: true })
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g1', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
    assert.match(result.content[0].text, /none\/unreadable/)
    assert.equal(existsSync(LABEL_STATE), false)
    assert.equal(receipts.entries.length, 0)
  })
})

test('plan fresh path: proceeds with approve receipt and writes the label', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(ANSWER_FILE, 'approve\n')
  const receipts = memReceipts({ requireLabelWritten: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g2', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /planned/)
    assert.equal(receipts.entries.length, 1)
  })
})

test('plan fresh path: refuses on a reject receipt', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(ANSWER_FILE, 'reject\n')
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g3', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
    assert.match(result.content[0].text, /reject/)
    assert.equal(existsSync(LABEL_STATE), false)
  })
})

test('plan fresh path: refuses when the receipt read fails', async () => {
  rmSync(LABEL_STATE, { force: true })
  rmSync(ANSWER_FILE, { force: true })
  writeFileSync(READ_FAILS, 'x')
  try {
    const receipts = memReceipts()
    const execute = phaseCompleteExecute(receipts)
    await withFakeAven(async () => {
      const result = await execute('g4', { ref: 'PMR-TEST', phase: 'plan' })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
      assert.equal(existsSync(LABEL_STATE), false)
    })
  } finally {
    rmSync(READ_FAILS, { force: true })
  }
})

test('plan already path: stays receipt-free (idempotency preserved)', async () => {
  writeFileSync(LABEL_STATE, 'planned\n')
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g5', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /already recorded/)
  })
})

// AIDEV-NOTE: PMR-J6TW — oneshot exemption. Tickets carrying the `oneshot`
// label complete the fresh plan write WITHOUT any approval receipt: the
// oneshot route (PMR-3HMZ) never produces one by design. The labels read
// itself stays fail-closed — a read failure refuses even for oneshots —
// and the plan route without the label keeps the full gate.
test('plan fresh path: oneshot label skips the receipt gate', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(LABEL_STATE, 'oneshot\n')
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts({ requireLabelWritten: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g7', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /planned/)
    assert.match(readFileSync(LABEL_STATE, 'utf8'), /planned/)
    assert.equal(receipts.entries.length, 1)
  })
})

test('plan fresh path: oneshot label still refuses when the labels read fails', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(LABEL_STATE, 'oneshot\n')
  rmSync(ANSWER_FILE, { force: true })
  writeFileSync(LABELS_READ_FAILS, 'x')
  try {
    const receipts = memReceipts()
    const execute = phaseCompleteExecute(receipts)
    await withFakeAven(async () => {
      const result = await execute('g8', { ref: 'PMR-TEST', phase: 'plan' })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /cannot read aven labels/)
      assert.equal(receipts.entries.length, 0)
      assert.doesNotMatch(readFileSync(LABEL_STATE, 'utf8'), /planned/)
    })
  } finally {
    rmSync(LABELS_READ_FAILS, { force: true })
  }
})

test('plan fresh path: non-oneshot labels keep the receipt gate', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(LABEL_STATE, 'bug\n')
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g9', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
    assert.doesNotMatch(readFileSync(LABEL_STATE, 'utf8'), /planned/)
  })
})

// AIDEV-NOTE: yolo plan 3.1 — the isYoloRun exemption. A ref journaled with
// input.yolo === true (from the human's CLI invocation, restored by the run
// projection) completes the plan write WITHOUT a receipt — unlike the
// agent-writable oneshot label, the yolo bit cannot be self-granted by the
// agent, so it is safe to key the exemption on it. Fail-closed: an absent
// projection (readRunState null) or any read failure means NOT yolo, and a
// non-yolo ref keeps the full gate.
test('plan fresh path: yolo-journaled ref skips the receipt gate', async () => {
  rmSync(LABEL_STATE, { force: true })
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts({ requireLabelWritten: true })
  const execute = phaseCompleteExecute(receipts, async () => true)
  await withFakeAven(async () => {
    const result = await execute('y1', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /planned/)
    assert.match(readFileSync(LABEL_STATE, 'utf8'), /planned/)
    assert.equal(receipts.entries.length, 1)
  })
})

test('plan fresh path: non-yolo ref keeps the receipt gate', async () => {
  rmSync(LABEL_STATE, { force: true })
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts()
  const execute = phaseCompleteExecute(receipts, async () => false)
  await withFakeAven(async () => {
    const result = await execute('y2', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
    assert.equal(existsSync(LABEL_STATE), false)
  })
})

test('plan fresh path: yolo read failure refuses (fail-closed via default reader)', async () => {
  rmSync(LABEL_STATE, { force: true })
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts()
  // No injected reader: the production default isYoloRun reads the real
  // projection; this ref has none, so it must resolve false and refuse.
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('y3', { ref: 'PMR-TEST', phase: 'plan' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-TEST approve/)
    assert.equal(receipts.entries.length, 0)
    assert.equal(existsSync(LABEL_STATE), false)
  })
})

test('implement phase: still label-order-only, no receipt required', async () => {
  rmSync(LABEL_STATE, { force: true })
  writeFileSync(LABEL_STATE, 'planned\n')
  rmSync(ANSWER_FILE, { force: true })
  const receipts = memReceipts({ requireLabelWritten: true })
  const execute = phaseCompleteExecute(receipts)
  await withFakeAven(async () => {
    const result = await execute('g6', { ref: 'PMR-TEST', phase: 'implement' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /active/)
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
