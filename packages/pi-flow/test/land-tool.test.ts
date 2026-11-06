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

function landExecute(runSuite: SuiteRunner = greenSuite): LandExecute {
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
