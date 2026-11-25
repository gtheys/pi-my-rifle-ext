// AIDEV-NOTE: PMR-ZV9Y 2.2 — v2 state-machine emissions of the retry-budget
// tool (plan phase-2 mapping row "run-attempt escalate"). ONLY the escalation
// outcome journals state-change{waiting_human, escalation}; passed and retry
// keep the run's state to the loop and journal no v2 event at all. The event
// rides a NEW optional `journalV2` dep on the tool's existing deps struct
// (index.ts wires it to the same mode-aware writer that
// createAttemptLedger(...).record uses), so the pre-existing
// run-attempt-tool.test.ts fakes — which never set it — stay byte-identical
// (ISC-A-2). Harness: run-attempt-tool.test.ts (fake aven on PATH + isolated
// session cwd; a capturing ledger, never the real agent dir).
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import type { FlowRunEvent } from '../run-state.ts'
import { registerRunAttemptTool } from '../tools/run-attempt.ts'
import { mkTmpDir } from './tmpdir.ts'

const ROOT = mkTmpDir('pi-flow-attempt-v2-')
const BIN_DIR = path.join(ROOT, 'bin')
const SESSION_CWD = path.join(ROOT, 'session')
mkdirSync(BIN_DIR, { recursive: true })
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: path.join(ROOT, 'ws') }),
)
// The escalation path writes an aven note; the exit-0 fake keeps the test off
// any real workspace (run-attempt-tool.test.ts pattern).
writeFileSync(path.join(BIN_DIR, 'aven'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

async function withFakeAven(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SESSION_CWD)
  try {
    await fn()
  } finally {
    if (previousPath === '') delete process.env.PATH
    else process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
}

type Execute = (
  id: string,
  params: { ref: string; result: { ok: boolean; lastError?: string } },
) => Promise<{ isError?: boolean; details?: { status: string } }>

function harness(opts: {
  /** when true the v2 seam throws on every call (never-throw probe). */
  v2Throws?: boolean
  /** when true the deps struct carries no journalV2 field at all. */
  noSeam?: boolean
}): { execute: Execute; v2: FlowRunEvent[] } {
  const v2: FlowRunEvent[] = []
  let execute: Execute | undefined
  const deps: Parameters<typeof registerRunAttemptTool>[2] = {
    isYoloRunFn: async () => false,
  }
  if (!opts.noSeam) {
    deps.journalV2 = async (event: FlowRunEvent) => {
      if (opts.v2Throws === true) throw new Error('journal down')
      v2.push(event)
    }
  }
  registerRunAttemptTool(
    {
      registerTool: (tool: { execute: Execute }) => {
        execute = tool.execute
      },
    } as unknown as ExtensionAPI,
    // In-memory ledger fake (run-attempt-tool.test.ts 'throwing' shape): no
    // journal file, so the v2 seam is the only thing under observation.
    {
      seed: async () => null,
      record: async () => {},
    },
    deps,
  )
  if (!execute) throw new Error('flow_run_attempt tool not registered')
  return { execute, v2 }
}

const FAIL = { ok: false, lastError: 'red' }
const ESCALATION_WAIT = {
  state: 'waiting_human',
  reason: 'escalation',
  ref: 'PMR-V2E',
}

function v2View(events: FlowRunEvent[]) {
  const view: unknown[] = []
  for (const event of events) {
    if (event.kind === 'state-change') {
      view.push({ state: event.state, reason: event.reason, ref: event.ref })
    }
  }
  return view
}

async function drain(
  execute: Execute,
  ref: string,
  attempts: number,
): Promise<string[]> {
  const statuses: string[] = []
  for (let i = 0; i < attempts; i++) {
    const r = await execute(`${ref}-${i}`, { ref, result: FAIL })
    statuses.push(r.details?.status ?? '')
  }
  return statuses
}

test('escalation journals exactly one state-change{waiting_human, escalation}', async () => {
  await withFakeAven(async () => {
    const { execute, v2 } = harness({})
    const statuses = await drain(execute, 'PMR-V2E', 3)
    assert.deepEqual(statuses, ['retry', 'retry', 'escalate'])
    assert.deepEqual(v2View(v2), [ESCALATION_WAIT])
  })
})

test('retry and passed outcomes journal no v2 event', async () => {
  await withFakeAven(async () => {
    const { execute, v2 } = harness({})
    const first = await execute('p0', { ref: 'PMR-V2R', result: FAIL })
    assert.equal(first.details?.status, 'retry')
    assert.deepEqual(v2View(v2), [])
    const passed = await execute('p1', {
      ref: 'PMR-V2R',
      result: { ok: true },
    })
    assert.equal(passed.details?.status, 'passed')
    assert.deepEqual(v2View(v2), [], 'a pass never opens a human wait')
  })
})

test('refusals after the budget drained do not re-journal the wait', async () => {
  await withFakeAven(async () => {
    const { execute, v2 } = harness({})
    await drain(execute, 'PMR-V2D', 3)
    const refused = await execute('d4', { ref: 'PMR-V2D', result: FAIL })
    assert.equal(refused.isError, true)
    assert.match(refused.details?.status ?? '', /escalate/)
    assert.equal(
      v2View(v2).length,
      1,
      'the already-exhausted refusal path journals nothing new',
    )
  })
})

test('a throwing v2 seam never changes the escalation (ISC-A-5)', async () => {
  await withFakeAven(async () => {
    const { execute } = harness({ v2Throws: true })
    const statuses = await drain(execute, 'PMR-V2T', 3)
    assert.deepEqual(statuses, ['retry', 'retry', 'escalate'])
  })
})

test('absent v2 seam (older callers) escalates unchanged', async () => {
  await withFakeAven(async () => {
    const { execute } = harness({ noSeam: true })
    const statuses = await drain(execute, 'PMR-V2A', 3)
    assert.deepEqual(statuses, ['retry', 'retry', 'escalate'])
  })
})
