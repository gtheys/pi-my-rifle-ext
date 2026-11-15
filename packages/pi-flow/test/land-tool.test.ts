// Tests for the flow_land tool (PMR-C6AK): route=merge-main requires the
// human code-review marker (LandingState.humanReviewPassed === ref) recorded
// by the code_review tool; route=pr is unchanged. Uses a fake `aven` on PATH
// (same pattern as aven-workspace-cwd.test.ts) to satisfy the review-passed
// label gate.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { readAvenLabels, setAvenSessionCwd } from '../index.ts'
import type { SuiteRunner } from '../tools/land.ts'
import { createLandingState, registerLandTool } from '../tools/land.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-land-bin-'))
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\necho '{"ref":"PMR-ABC1","labels":["review-passed"]}'\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

after(() => {
  setAvenSessionCwd(undefined)
})

type LandExecute = (
  toolCallId: string,
  params: { ref: string; route: 'pr' | 'merge-main'; artifact?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

const landingState = createLandingState()

const greenSuite: SuiteRunner = async () => ({ ok: true, summary: 'ok' })

type ReadReviewAnswer = (ref: string) => Promise<'pass' | 'fail' | null>

function landExecute(
  runSuite: SuiteRunner = greenSuite,
  readReviewAnswer: ReadReviewAnswer = async () => null,
): LandExecute {
  let execute: LandExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: LandExecute }) => {
      execute = options.execute
    },
  }
  registerLandTool(
    mockPi as unknown as Parameters<typeof registerLandTool>[0],
    landingState,
    () => null,
    runSuite,
    readReviewAnswer,
  )
  if (!execute) throw new Error('flow_land tool not registered')
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

test('merge-main is refused without the human code-review marker', async () => {
  const execute = landExecute()
  await withFakeAven(async () => {
    const result = await execute('t1', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /code_review tool/)
    assert.match(result.content[0].text, /human code-review gate/)
  })
})

test('merge-main succeeds on the durable aven answer pass even with no marker (PMR-R5VB)', async () => {
  landingState.humanReviewPassed = null
  const execute = landExecute(greenSuite, async (ref) => {
    assert.equal(ref, 'PMR-ABC1')
    return 'pass'
  })
  await withFakeAven(async () => {
    const result = await execute('d1', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /merge --ff-only/)
  })
})

test('merge-main succeeds on the in-session marker even when the durable read returns null (PMR-R5VB)', async () => {
  landingState.humanReviewPassed = 'PMR-ABC1'
  let durableReads = 0
  const execute = landExecute(greenSuite, async () => {
    durableReads += 1
    return null
  })
  await withFakeAven(async () => {
    const result = await execute('d2', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, undefined)
    assert.equal(
      durableReads,
      0,
      'marker hit must short-circuit the durable read',
    )
  })
})

test('merge-main is refused with neither marker nor durable pass — refusal names BOTH routes', async () => {
  landingState.humanReviewPassed = null
  const execute = landExecute(greenSuite, async () => null)
  await withFakeAven(async () => {
    const result = await execute('d3', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, true)
    assert.match(
      result.content[0].text,
      /human code-review gate has not passed/,
    )
    assert.match(result.content[0].text, /code_review tool/)
    assert.match(result.content[0].text, /\/flow answer PMR-ABC1 pass/)
  })
})

test('merge-main is refused when the durable aven answer is fail (PMR-R5VB)', async () => {
  landingState.humanReviewPassed = null
  const execute = landExecute(greenSuite, async () => 'fail')
  await withFakeAven(async () => {
    const result = await execute('d4', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, true)
    assert.match(
      result.content[0].text,
      /human code-review gate has not passed/,
    )
  })
})

test('merge-main is refused when the marker names a different ref', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-OTHER'
  await withFakeAven(async () => {
    const result = await execute('t2', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /code_review tool/)
  })
})

test('merge-main succeeds when the marker matches the ref', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-ABC1'
  await withFakeAven(async () => {
    const result = await execute('t3', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /merge --ff-only/)
    assert.match(result.content[0].text, /Do not push/)
  })
})

test('merge-main does NOT authorize a git push (PMR-HYZA)', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-ABC1'
  await withFakeAven(async () => {
    await execute('t6', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(landingState.authorized, null)
  })
})

test('schema rejects route push-main (PMR-HYZA)', async () => {
  const { Value } = await import('typebox/value')
  let parameters: unknown
  const mockPi = {
    registerTool: (options: { parameters: unknown }) => {
      parameters = options.parameters
    },
  }
  registerLandTool(
    mockPi as unknown as Parameters<typeof registerLandTool>[0],
    landingState,
    () => null,
    greenSuite,
    async () => null,
  )
  assert.equal(
    Value.Check(parameters as never, { ref: 'PMR-ABC1', route: 'merge-main' }),
    true,
  )
  assert.equal(
    Value.Check(parameters as never, { ref: 'PMR-ABC1', route: 'push-main' }),
    false,
  )
})

test('route=pr is unchanged — no human-review marker required', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = null
  await withFakeAven(async () => {
    const result = await execute('t4', { ref: 'PMR-ABC1', route: 'pr' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /authorized/)
  })
})

test('label gate still runs before authorization (fail-closed, PMR-06RH)', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-ABC1'
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = previousPath // no fake aven -> labels unreadable
  const result = await execute('t5', { ref: 'PMR-ABC1', route: 'merge-main' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /fail-closed/)
})

// Sanity: the real readAvenLabels parses the fake shim output.
test('fake aven shim returns review-passed labels', async () => {
  await withFakeAven(async () => {
    const labels = await readAvenLabels('PMR-ABC1')
    assert.deepEqual(labels, ['review-passed'])
  })
})

// --- PMR-05HX: flow_land runs the suite itself; red suite refuses landing ---

test('merge-main refused when the suite the gate ran is red', async () => {
  const execute = landExecute(async () => ({
    ok: false,
    summary: '2 tests failed',
  }))
  await withFakeAven(async () => {
    landingState.humanReviewPassed = 'PMR-ABC1'
    const result = await execute('t7', { ref: 'PMR-ABC1', route: 'merge-main' })
    assert.equal(result.isError, true)
    assert.match(result.content[0]?.text ?? '', /test suite FAILED/)
    assert.match(result.content[0]?.text ?? '', /2 tests failed/)
  })
})

test('route=pr authorization also requires the suite green', async () => {
  const execute = landExecute(async () => ({
    ok: false,
    summary: 'suite crashed',
  }))
  await withFakeAven(async () => {
    landingState.authorized = null
    const result = await execute('t8', { ref: 'PMR-ABC1', route: 'pr' })
    assert.equal(result.isError, true)
    assert.match(result.content[0]?.text ?? '', /test suite FAILED/)
    assert.equal(landingState.authorized, null, 'no authorization on red suite')
  })
})

test('suite runs in the flow worktree when one is bound', async () => {
  let seenCwd: string | null = null
  const execute = landExecute(async (cwd) => {
    seenCwd = cwd
    return { ok: true, summary: 'ok' }
  })
  await withFakeAven(async () => {
    landingState.humanReviewPassed = 'PMR-ABC1'
    const result = await execute('t9', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.notEqual(result.isError, true)
    assert.equal(typeof seenCwd, 'string')
    assert.ok((seenCwd ?? '').length > 0)
  })
})

test('suiteSummary bounds the refusal output', async () => {
  const { suiteSummary } = await import('../tools/land.ts')
  const short = suiteSummary('ok\n')
  assert.equal(short, 'ok')
  const long = suiteSummary(`${'x'.repeat(5000)}\n`)
  assert.ok(long.length <= 2001)
  assert.ok(long.startsWith('…'))
})

// ---------------------------------------------------------------------------
// Receipt adoption tests (PMR-4S6V): flow_land records a receipt after a
// green suite and ADOPTS it on a duplicate call with unchanged HEAD — the
// suite is NOT re-run. Gate order is unchanged: ref-match -> merge-main
// human gate -> labels/landDecision -> receipt lookup -> suite.
// Every test builds a FRESH createLandingState() — the shared module-level
// landingState above is a known cross-test bleed risk, so these tests stay
// order-independent.
// ---------------------------------------------------------------------------
import type { ReceiptJournal, ReceiptQuery } from '../run-state.ts'

type LandExecuteFull = (
  toolCallId: string,
  params: { ref: string; route: 'pr' | 'merge-main'; artifact?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

// In-memory ReceiptJournal fake: array-backed find/record keyed on
// (ref, command, target, headSha). find only hits when the stored headSha
// matches the query's exactly. recordThrowing makes record reject (ISC-8
// best-effort probe).
function memReceipts(options?: { recordThrowing?: boolean }): ReceiptJournal & {
  entries: ReceiptQuery[]
} {
  const entries: ReceiptQuery[] = []
  return {
    entries,
    async find(query: ReceiptQuery) {
      for (const entry of entries) {
        if (
          entry.ref === query.ref &&
          entry.command === query.command &&
          entry.target === query.target &&
          entry.headSha === query.headSha
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

interface LandHarness {
  execute: LandExecuteFull
  suiteRuns: () => number
  receipts: ReceiptJournal & { entries: ReceiptQuery[] }
}

function landHarness(options?: {
  runSuite?: SuiteRunner
  readReviewAnswer?: ReadReviewAnswer
  receipts?: ReceiptJournal & { entries: ReceiptQuery[] }
  resolveHead?: () => Promise<string | null>
  landing?: ReturnType<typeof createLandingState>
}): LandHarness {
  let suiteRunCount = 0
  const countingSuite: SuiteRunner =
    options?.runSuite ??
    (async () => {
      suiteRunCount += 1
      return { ok: true, summary: 'ok' }
    })
  const receipts = options?.receipts ?? memReceipts()
  const landing = options?.landing ?? createLandingState()
  let execute: LandExecuteFull | undefined
  const mockPi = {
    registerTool: (tool: { execute: LandExecuteFull }) => {
      execute = tool.execute
    },
  }
  registerLandTool(
    mockPi as unknown as Parameters<typeof registerLandTool>[0],
    landing,
    () => null,
    countingSuite,
    options?.readReviewAnswer ?? (async () => null),
    receipts,
    options?.resolveHead ?? (async () => 'aaa111'),
  )
  if (!execute) throw new Error('flow_land tool not registered')
  return { execute, suiteRuns: () => suiteRunCount, receipts }
}

test('receipt adoption: first green call records, duplicate adopts without re-running the suite (pr)', async () => {
  const harness = landHarness()
  await withFakeAven(async () => {
    const first = await harness.execute('r1', { ref: 'PMR-ABC1', route: 'pr' })
    assert.equal(first.isError, undefined)
    assert.equal(harness.suiteRuns(), 1)
    assert.equal(harness.receipts.entries.length, 1)
    assert.deepEqual(harness.receipts.entries[0], {
      ref: 'PMR-ABC1',
      command: 'flow_land',
      target: 'pr',
      headSha: 'aaa111',
    })
    const second = await harness.execute('r2', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(second.isError, undefined)
    assert.equal(harness.suiteRuns(), 1, 'suite NOT re-run on duplicate')
    assert.match(second.content[0].text, /adopted/)
    assert.match(second.content[0].text, /authorized via pr/)
  })
})

test('receipt adoption: route=pr duplicate re-authorizes the ref (ISC-3)', async () => {
  const landing = createLandingState()
  const harness = landHarness({ landing })
  await withFakeAven(async () => {
    await harness.execute('r3', { ref: 'PMR-ABC1', route: 'pr' })
    // Simulate a blip that cleared authorization between the two calls.
    landing.authorized = null
    const second = await harness.execute('r4', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(second.isError, undefined)
    assert.equal(harness.suiteRuns(), 1)
    assert.equal(landing.authorized, 'PMR-ABC1')
  })
})

test('receipt adoption: HEAD moved since the receipt — suite re-runs, no adoption (ISC-6)', async () => {
  let head = 'aaa111'
  const harness = landHarness({
    resolveHead: async () => head,
  })
  await withFakeAven(async () => {
    await harness.execute('r5', { ref: 'PMR-ABC1', route: 'pr' })
    head = 'bbb222'
    const second = await harness.execute('r6', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(second.isError, undefined)
    assert.equal(harness.suiteRuns(), 2, 'suite re-runs over a moved HEAD')
    assert.doesNotMatch(second.content[0].text, /adopted/)
  })
})

test('receipt adoption: unresolvable HEAD — no adoption, suite re-runs (ISC-6)', async () => {
  let head: string | null = 'aaa111'
  const harness = landHarness({
    resolveHead: async () => head,
  })
  await withFakeAven(async () => {
    await harness.execute('r7', { ref: 'PMR-ABC1', route: 'pr' })
    head = null
    const second = await harness.execute('r8', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(second.isError, undefined)
    assert.equal(harness.suiteRuns(), 2)
  })
})

test('receipt adoption: merge-main without the human marker is refused despite a stored receipt (ISC-7)', async () => {
  const receipts = memReceipts()
  receipts.entries.push({
    ref: 'PMR-ABC1',
    command: 'flow_land',
    target: 'merge-main',
    headSha: 'aaa111',
  })
  const harness = landHarness({ receipts })
  await withFakeAven(async () => {
    const result = await harness.execute('r9', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /human code-review gate/)
    assert.equal(harness.suiteRuns(), 0)
  })
})

test('receipt adoption: merge-main with the marker adopts without re-running the suite', async () => {
  const landing = createLandingState()
  landing.humanReviewPassed = 'PMR-ABC1'
  const harness = landHarness({ landing })
  await withFakeAven(async () => {
    const first = await harness.execute('r10', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(first.isError, undefined)
    assert.equal(harness.suiteRuns(), 1)
    const second = await harness.execute('r11', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(second.isError, undefined)
    assert.equal(harness.suiteRuns(), 1, 'suite NOT re-run on duplicate')
    assert.match(second.content[0].text, /adopted/)
    assert.match(second.content[0].text, /merge --ff-only/)
    assert.equal(landing.authorized, null, 'merge-main never authorizes')
  })
})

test('receipt adoption: labels failing landDecision are refused before the lookup (ISC-7)', async () => {
  const receipts = memReceipts()
  receipts.entries.push({
    ref: 'PMR-ABC1',
    command: 'flow_land',
    target: 'pr',
    headSha: 'aaa111',
  })
  const harness = landHarness({ receipts })
  await withFakeAven(async () => {
    // Point the fake aven at labels WITHOUT review-passed: the writeable
    // label fixture lives in the shim; use a second bin dir whose aven
    // returns no labels.
    const noLabelBin = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-nolabel-'))
    const avenPath = path.join(noLabelBin, 'aven')
    writeFileSync(
      avenPath,
      `#!/bin/sh\necho '{"ref":"PMR-ABC1","labels":[]}'\n`,
    )
    chmodSync(avenPath, 0o755)
    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${noLabelBin}:${previousPath}`
    try {
      const result = await harness.execute('r12', {
        ref: 'PMR-ABC1',
        route: 'pr',
      })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /review-passed/)
      assert.equal(harness.suiteRuns(), 0)
    } finally {
      process.env.PATH = previousPath
    }
  })
})

test('receipt adoption: a throwing record never blocks authorization (ISC-8)', async () => {
  const receipts = memReceipts({ recordThrowing: true })
  const harness = landHarness({ receipts })
  await withFakeAven(async () => {
    const result = await harness.execute('r13', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /authorized via pr/)
  })
})

test('receipt adoption: receipts and resolveHead are optional (defaults wired)', () => {
  let registered = false
  const mockPi = {
    registerTool: () => {
      registered = true
    },
  }
  registerLandTool(
    mockPi as unknown as Parameters<typeof registerLandTool>[0],
    createLandingState(),
    () => null,
    greenSuite,
    async () => null,
  )
  assert.equal(registered, true)
})
