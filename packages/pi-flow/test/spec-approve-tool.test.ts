// AIDEV-NOTE: tests for the spec_approve tool wiring (PMR-MR36 fix round).
// Exercises the exported specApprove wrapper through a fake aven on PATH:
// happy path must report ok, an aven exit-0 non-success must fail loud, and
// the workspace must come from the project config override (session cwd).
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { setAvenSessionCwd, specApprove } from '../index.ts'
import type { ReceiptJournal, ReceiptQuery } from '../run-state.ts'
import { registerSpecApproveTool } from '../tools/spec-approve.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-approve-bin-'))
const ARGS_FILE = path.join(BIN_DIR, 'last-args.txt')
const MODE_FILE = path.join(BIN_DIR, 'mode.txt')
const ANSWER_FILE = path.join(BIN_DIR, 'answer.txt')
writeFileSync(MODE_FILE, 'ok')
writeFileSync(ANSWER_FILE, '')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh
printf '%s\\n' "$@" > ${ARGS_FILE}
mode=$(cat ${MODE_FILE})
if [ "$1" = "show" ]; then
  case "$*" in
    *--full*)
      if [ "$mode" = "err" ]; then
        echo "Error: boom" >&2
        exit 0
      fi
      if [ "$mode" = "fuzzy" ]; then
        echo "PMR-WRONG7 status=todo title=x"
      else
        echo "$2 status=todo title=x"
      fi
      if [ -s ${ANSWER_FILE} ]; then
        echo "metadata field_id=f1 key=spec-answer"
        echo "value<<EOF"
        cat ${ANSWER_FILE}
        echo "EOF"
      fi
      exit 0
      ;;
    *)
      echo "{\\"ref\\":\\"$2\\",\\"labels\\":[]}" ; exit 0
      ;;
  esac
fi
if [ "$1" = "edit" ]; then
  if [ "$mode" = "ok" ]; then
    echo "updated $2"
    exit 0
  fi
  echo "Error: something went wrong"; exit 0
fi
echo "unexpected command"; exit 1
`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

const WORK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-approve-ws-'))
const SESSION_CWD = path.join(WORK_ROOT, 'repo')
const OVERRIDE = 'ws-from-config'
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: OVERRIDE }),
)

function lastArgs(): string[] {
  return readFileSync(ARGS_FILE, 'utf8').split('\n').filter(Boolean)
}

test('specApprove: happy path pins the config workspace and reports ok', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    const result = await specApprove({ ref: 'PMR-APPR' })
    assert.equal(result.ok, true)
    const args = lastArgs()
    assert.ok(args.includes('edit'))
    const idx = args.indexOf(OVERRIDE)
    assert.ok(idx > 0, `expected --workspace ${OVERRIDE}: ${args.join(' ')}`)
    assert.equal(args[idx - 1], '--workspace')
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

test('specApprove: explicit workspace flag wins over config override', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    const result = await specApprove({
      ref: 'PMR-FLAGS',
      workspace: 'ws-explicit',
    })
    assert.equal(result.ok, true)
    const args = lastArgs()
    assert.ok(args.includes('ws-explicit'))
    assert.ok(!args.includes(OVERRIDE))
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

test('specApprove: aven exit-0 without success line fails loud', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  writeFileSync(MODE_FILE, 'fail')
  try {
    const result = await specApprove({ ref: 'PMR-FAIL' })
    assert.equal(result.ok, false)
    assert.match(result.text, /spec_approve/)
    assert.match(result.text, /did not report success|Error:/)
  } finally {
    writeFileSync(MODE_FILE, 'ok')
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

after(() => {
  rmSync(BIN_DIR, { recursive: true, force: true })
  rmSync(WORK_ROOT, { recursive: true, force: true })
})

// AIDEV-NOTE: PMR-R5VB — receipt-gate tests. The spec_approve tool must
// refuse unless readGateAnswer(ref, 'spec') returns 'approve' BEFORE any
// aven edit: absent metadata, a reject answer, and a stderr Error read all
// fail closed. The receipt is never consumed here (single-use is PMR-CD46).
type SpecApproveExecute = (
  toolCallId: string,
  params: { ref: string; workspace?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
  details: { ok: boolean }
}>

function specApproveExecute(receipts?: ReceiptJournal): SpecApproveExecute {
  let execute: SpecApproveExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: SpecApproveExecute }) => {
      execute = options.execute
    },
  }
  // AIDEV-NOTE: PMR-CD46 — default stub keeps existing tests hermetic
  // instead of journaling to the real agent dir; find returns null so the
  // dedup check never short-circuits unless a test pre-seeds it.
  let effectiveReceipts = receipts
  if (effectiveReceipts === undefined) {
    const entries: ReceiptQuery[] = []
    effectiveReceipts = {
      async find() {
        return null
      },
      async record(query: ReceiptQuery) {
        entries.push(query)
      },
    }
  }
  registerSpecApproveTool(
    mockPi as unknown as Parameters<typeof registerSpecApproveTool>[0],
    effectiveReceipts,
  )
  if (!execute) throw new Error('spec_approve tool not registered')
  return execute
}

async function withFakeAven(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SESSION_CWD)
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
}

test('spec_approve tool: approve receipt lets the approval proceed', async () => {
  const execute = specApproveExecute()
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    const result = await execute('t1', { ref: 'PMR-GATE1' })
    assert.equal(result.isError, undefined)
    assert.equal(result.details.ok, true)
    const args = lastArgs()
    assert.ok(args.includes('edit'))
    assert.ok(args.includes('PMR-GATE1'))
  })
})

test('spec_approve tool: refuses without a receipt and never edits', async () => {
  const execute = specApproveExecute()
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, '')
    const result = await execute('t2', { ref: 'PMR-GATE2' })
    assert.equal(result.isError, true)
    assert.equal(result.details.ok, false)
    assert.match(result.content[0].text, /\/flow answer PMR-GATE2 approve/)
    assert.match(result.content[0].text, /none\/unreadable/)
    assert.ok(!lastArgs().includes('edit'))
  })
})

test('spec_approve tool: refuses on a reject receipt', async () => {
  const execute = specApproveExecute()
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'reject\n')
    const result = await execute('t3', { ref: 'PMR-GATE3' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-GATE3 approve/)
    assert.match(result.content[0].text, /Found: reject/)
    assert.ok(!lastArgs().includes('edit'))
  })
})

test('spec_approve tool: refuses when the aven read errors (fail closed)', async () => {
  const execute = specApproveExecute()
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    writeFileSync(MODE_FILE, 'err')
    const result = await execute('t4', { ref: 'PMR-GATE4' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow answer PMR-GATE4 approve/)
    assert.match(result.content[0].text, /none\/unreadable/)
    assert.ok(!lastArgs().includes('edit'))
    writeFileSync(MODE_FILE, 'ok')
  })
})

// AIDEV-NOTE: PMR-CD46 — dedup tests. A stored spec_approve receipt
// ({ref, command:'spec_approve', target:'plan'}) short-circuits BEFORE the
// human-gate: adoption skips the aven edit and still returns ok. Missing
// receipt falls through to today's fail-closed gate; fresh success records
// best-effort after the edit.
type SpecReceiptStub = ReceiptJournal & { entries: ReceiptQuery[] }

function memReceipts(options?: {
  seeded?: boolean
  findNull?: boolean
  recordThrowing?: boolean
}): SpecReceiptStub {
  const entries: ReceiptQuery[] = []
  return {
    entries,
    async find(query: ReceiptQuery) {
      if (options?.findNull === true) return null
      if (options?.seeded === true) {
        // AIDEV-NOTE: PMR-CD46 — single-ref stub: seeded = a stored receipt
        // exists for whatever ref the tool queries.
        return {
          command: query.command,
          target: query.target,
          status: 'ok' as const,
          at: new Date().toISOString(),
        }
      }
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
      entries.push(query)
    },
  }
}

test('spec_approve tool: duplicate adopts the stored receipt and skips the edit', async () => {
  const receipts = memReceipts({ seeded: true })
  const execute = specApproveExecute(receipts)
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, '')
    const result = await execute('t5', { ref: 'PMR-DUP1' })
    assert.equal(result.isError, undefined)
    assert.equal(result.details.ok, true)
    assert.ok(!lastArgs().includes('edit'))
    assert.match(result.content[0].text, /adopt/i)
    assert.match(result.content[0].text, /skipped/i)
  })
})

test('spec_approve tool: fresh approval runs the edit and records the receipt', async () => {
  const receipts = memReceipts()
  const execute = specApproveExecute(receipts)
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    const result = await execute('t6', { ref: 'PMR-FRESH1' })
    assert.equal(result.isError, undefined)
    assert.equal(result.details.ok, true)
    assert.ok(lastArgs().includes('edit'))
    assert.equal(receipts.entries.length, 1)
    assert.deepEqual(receipts.entries[0], {
      ref: 'PMR-FRESH1',
      command: 'spec_approve',
      target: 'plan',
    })
  })
})

test('spec_approve tool: missing receipt falls back to edit + record', async () => {
  const receipts = memReceipts({ findNull: true })
  const execute = specApproveExecute(receipts)
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    const result = await execute('t7', { ref: 'PMR-FALL1' })
    assert.equal(result.isError, undefined)
    assert.equal(result.details.ok, true)
    assert.ok(lastArgs().includes('edit'))
    assert.deepEqual(receipts.entries[0], {
      ref: 'PMR-FALL1',
      command: 'spec_approve',
      target: 'plan',
    })
  })
})

test('spec_approve tool: a throwing journal never fails a fresh approval', async () => {
  const receipts = memReceipts({ recordThrowing: true })
  const execute = specApproveExecute(receipts)
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    const result = await execute('t8', { ref: 'PMR-THROW1' })
    assert.equal(result.isError, undefined)
    assert.equal(result.details.ok, true)
    assert.ok(lastArgs().includes('edit'))
  })
})
