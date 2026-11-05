// Tests for the flow_land tool (PMR-C6AK): route=push-main requires the
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
import { createLandingState, registerLandTool } from '../tools/land.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-land-bin-'))
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\necho '{"labels":["review-passed"]}'\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

after(() => {
  setAvenSessionCwd(undefined)
})

type LandExecute = (
  toolCallId: string,
  params: { ref: string; route: 'pr' | 'push-main'; artifact?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

const landingState = createLandingState()

function landExecute(): LandExecute {
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

test('push-main is refused without the human code-review marker', async () => {
  const execute = landExecute()
  await withFakeAven(async () => {
    const result = await execute('t1', { ref: 'PMR-ABC1', route: 'push-main' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /code_review tool/)
    assert.match(result.content[0].text, /human code-review gate/)
  })
})

test('push-main is refused when the marker names a different ref', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-OTHER'
  await withFakeAven(async () => {
    const result = await execute('t2', { ref: 'PMR-ABC1', route: 'push-main' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /code_review tool/)
  })
})

test('push-main is authorized when the marker matches the ref', async () => {
  const execute = landExecute()
  landingState.humanReviewPassed = 'PMR-ABC1'
  await withFakeAven(async () => {
    const result = await execute('t3', { ref: 'PMR-ABC1', route: 'push-main' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /authorized/)
  })
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
  const result = await execute('t5', { ref: 'PMR-ABC1', route: 'push-main' })
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
