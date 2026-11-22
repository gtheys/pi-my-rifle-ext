// Tests for the flow_land scoped heal seam (PMR-DRKH): entry heal after the
// ref-mismatch gate, active-flow refusal vs hand-run WARNING+cwd-fallback.
// Harness mirrors land-tool.test.ts landExecute, extended with the
// healBinding seam (last positional dep).
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { HealResult } from '../flow/binding-heal.ts'
import {
  clearFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import { setAvenSessionCwd } from '../index.ts'
import type { SuiteRunner } from '../tools/land.ts'
import { createLandingState, registerLandTool } from '../tools/land.ts'
import { mkTmpDir } from './tmpdir.ts'

const BIN_DIR = mkTmpDir('pi-flow-land-heal-bin-')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\necho '{"ref":"PMR-ABC1","labels":["review-passed"]}'\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

after(() => {
  setAvenSessionCwd(undefined)
  clearFlowWorktree()
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

// In-memory EffectJournal fake (same shape as land-tool.test.ts memEffects).
function memEffects(): import('../run-state.ts').EffectJournal {
  return {
    async declare() {
      return { ok: true, effectId: 'fake' }
    },
    async find() {
      return null
    },
  }
}

function landExecute(
  runSuite: SuiteRunner = greenSuite,
  healBinding?: (ref: string) => Promise<HealResult>,
  activeRef: () => string | null = () => null,
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
    activeRef,
    runSuite,
    async () => null,
    undefined,
    undefined,
    undefined,
    memEffects(),
    async () => '/repo',
    async () => 'flow-branch',
    async () => ({ ok: true }),
    healBinding,
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

test('healed binding sends the suite to the healed worktree path', async () => {
  clearFlowWorktree()
  let seenCwd: string | null = null
  const healedPath = path.join(os.tmpdir(), 'healed-flow-wt')
  const heal = async (ref: string): Promise<HealResult> => {
    assert.equal(ref, 'PMR-ABC1')
    // Mirror healFlowBinding: rebind ref first (setFlowWorktree refuses
    // without an active ref), then the worktree.
    setActiveFlowRef(ref)
    setFlowWorktree(healedPath, 'flow-branch')
    return {
      ok: true,
      healed: true,
      worktree: { path: healedPath, branch: 'flow-branch', source: 'herdr' },
    }
  }
  const execute = landExecute(async (cwd) => {
    seenCwd = cwd
    return { ok: true, summary: 'ok' }
  }, heal)
  await withFakeAven(async () => {
    const result = await execute('t1', { ref: 'PMR-ABC1', route: 'pr' })
    assert.notEqual(result.isError, true)
    assert.equal(seenCwd, healedPath)
  })
  setActiveFlowRef(null)
  clearFlowWorktree()
})

test('heal failure with an active flow refuses loudly and skips the suite', async () => {
  clearFlowWorktree()
  let suiteRan = false
  const failHeal = async (): Promise<HealResult> => ({
    ok: false,
    reason: 'no durable source resolved PMR-ABC1',
    recovery: '/flow PMR-ABC1',
  })
  const execute = landExecute(
    async () => {
      suiteRan = true
      return { ok: true, summary: 'ok' }
    },
    failHeal,
    () => 'PMR-ABC1',
  )
  await withFakeAven(async () => {
    const result = await execute('t2', { ref: 'PMR-ABC1', route: 'pr' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /\/flow PMR-ABC1/)
    assert.match(result.content[0].text, /refused/)
    assert.equal(
      suiteRan,
      false,
      'suite must not run on active-flow heal failure',
    )
  })
})

test('heal failure without an active flow warns and falls back to cwd', async () => {
  clearFlowWorktree()
  let seenCwd: string | null = null
  const failHeal = async (): Promise<HealResult> => ({
    ok: false,
    reason: 'no durable source resolved PMR-ABC1',
    recovery: '/flow PMR-ABC1',
  })
  const execute = landExecute(async (cwd) => {
    seenCwd = cwd
    return { ok: true, summary: 'ok' }
  }, failHeal)
  await withFakeAven(async () => {
    const result = await execute('t3', { ref: 'PMR-ABC1', route: 'pr' })
    assert.notEqual(result.isError, true)
    assert.equal(seenCwd, process.cwd())
    assert.match(result.content[0].text, /WARNING/)
    assert.match(result.content[0].text, /\/flow PMR-ABC1/)
  })
})
