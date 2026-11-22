// Tests for the PMR-1KAE main-advancement gate on the flow_land tool: before
// route=merge-main authorizes (fresh-suite path AND receipt-adoption path),
// the flow branch must be checked against a moved main (stale base) and an
// advanced origin, refusing with actionable guidance. Fake deps only — no
// real git, no real suite. The checker is passed as the trailing
// registerLandTool argument; before the gate exists the argument is ignored,
// which is exactly the bug these tests pin.
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { setAvenSessionCwd } from '../index.ts'
import type {
  EffectDeclareInput,
  EffectJournal,
  ReceiptJournal,
  ReceiptQuery,
} from '../run-state.ts'
import { effectDeclarationId } from '../run-state.ts'
import type { SuiteRunner } from '../tools/land.ts'
import { createLandingState, registerLandTool } from '../tools/land.ts'
import { mkTmpDir } from './tmpdir.ts'

const BIN_DIR = mkTmpDir('pi-flow-land-adv-bin-')
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

// Structural twin of land.ts MainAdvancementChecker — declared locally so
// this file imports only names that exist before the gate ships.
type Checker = (
  mainRepo: string,
  branch: string,
) => Promise<{ ok: true } | { ok: false; reason: string }>

const okChecker: Checker = async () => ({ ok: true })

const staleReason =
  "main advancement detected: merge-base of flow branch 'flow-branch' and 'main' is oldbase but 'main' tip is newtip — rebase-then-reland required"

// Mirrors the live human-routed wording (tools/land.ts origin-advancement
// refusal) so the injected example cannot drift from the production message:
// direct merges are agent-blocked while the flow is active, so the merge is
// routed to the HUMAN, not run by the agent.
const originAheadReason =
  "origin advancement detected: 'origin/main' is ahead of the local 'main' in /repo — direct merges are agent-blocked while the flow is active, so ask the HUMAN to run: git -C '/repo' merge --ff-only 'origin/main' — then call flow_land again; the landing must never integrate onto a stale local base"

function memEffects(): EffectJournal & { declared: EffectDeclareInput[] } {
  const declared: EffectDeclareInput[] = []
  const seenEffectIds = new Set<string>()
  return {
    declared,
    async declare(input: EffectDeclareInput) {
      const effectId = effectDeclarationId(input)
      if (seenEffectIds.has(effectId)) {
        return { ok: true, effectId }
      }
      seenEffectIds.add(effectId)
      declared.push(input)
      return { ok: true, effectId }
    },
    async find() {
      return null
    },
  }
}

function memReceipts(): ReceiptJournal & { entries: ReceiptQuery[] } {
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
      entries.push(query)
    },
  }
}

interface Harness {
  execute: LandExecute
  suiteRuns: () => number
  effects: EffectJournal & { declared: EffectDeclareInput[] }
}

function landHarness(options?: {
  landing?: ReturnType<typeof createLandingState>
  receipts?: ReceiptJournal & { entries: ReceiptQuery[] }
  checker?: Checker
  resolveMainRepo?: () => Promise<string | null>
}): Harness {
  let suiteRunCount = 0
  const countingSuite: SuiteRunner = async () => {
    suiteRunCount += 1
    return { ok: true, summary: 'ok' }
  }
  const landing = options?.landing ?? createLandingState()
  const effects = memEffects()
  let execute: LandExecute | undefined
  const mockPi = {
    registerTool: (tool: { execute: LandExecute }) => {
      execute = tool.execute
    },
  }
  registerLandTool(
    mockPi as unknown as Parameters<typeof registerLandTool>[0],
    landing,
    () => null,
    countingSuite,
    // merge-main needs a human pass: the durable aven answer route.
    async () => 'pass',
    options?.receipts ?? memReceipts(),
    async () => 'aaa111',
    undefined,
    effects,
    options?.resolveMainRepo ?? (async () => '/repo'),
    async () => 'flow-branch',
    options?.checker ?? okChecker,
  )
  if (!execute) throw new Error('flow_land tool not registered')
  return { execute, suiteRuns: () => suiteRunCount, effects }
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

test('stale flow branch refuses merge-main before any merge is declared (PMR-1KAE)', async () => {
  const landing = createLandingState()
  const harness = landHarness({
    landing,
    checker: async () => ({ ok: false, reason: staleReason }),
  })
  await withFakeAven(async () => {
    const result = await harness.execute('a1', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(result.isError, true, 'a stale flow branch must refuse')
    assert.match(result.content[0].text, /rebase/)
    assert.match(result.content[0].text, /NOT authorized/)
    assert.equal(landing.mergeAuthorized, null, 'no merge may be pinned')
    const mergeDeclared = harness.effects.declared.filter(
      (entry) => entry.effect === 'merge-main',
    )
    assert.equal(
      mergeDeclared.length,
      0,
      'a refused landing must not journal the merge-main effect',
    )
  })
})

test('origin-ahead refusal names the fetch-and-fast-forward guidance (PMR-1KAE)', async () => {
  const landing = createLandingState()
  const harness = landHarness({
    landing,
    checker: async () => ({ ok: false, reason: originAheadReason }),
  })
  await withFakeAven(async () => {
    const result = await harness.execute('a2', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /merge --ff-only/)
    assert.match(result.content[0].text, /flow_land again/)
    assert.equal(landing.mergeAuthorized, null)
  })
})

test('fresh main authorizes merge-main and pins the exact command (PMR-1KAE)', async () => {
  const landing = createLandingState()
  const harness = landHarness({ landing })
  await withFakeAven(async () => {
    const result = await harness.execute('a3', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(result.isError, undefined)
    const expected = `git -C '/repo' merge --ff-only flow-branch`
    assert.match(
      result.content[0].text,
      new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    if (landing.mergeAuthorized === null) {
      throw new Error('merge command must be pinned on ok')
    }
    assert.equal(landing.mergeAuthorized.ref, 'PMR-ABC1')
    assert.equal(landing.mergeAuthorized.command, expected)
  })
})

test('receipt adoption re-evaluates main advancement: a moved main refuses without re-running the suite (PMR-1KAE, PMR-5PQH guard)', async () => {
  const landing = createLandingState()
  let fresh = true
  const harness = landHarness({
    landing,
    checker: async () => {
      if (fresh) return { ok: true }
      return { ok: false, reason: staleReason }
    },
  })
  await withFakeAven(async () => {
    const first = await harness.execute('a4', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(first.isError, undefined)
    fresh = false // main advances AFTER the first authorization
    const second = await harness.execute('a5', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(second.isError, true, 'adoption must not rubber-stamp')
    assert.match(second.content[0].text, /NOT authorized/)
    assert.equal(
      harness.suiteRuns(),
      1,
      'refusal must come from the adoption path — the suite was NOT re-run',
    )
    assert.equal(landing.mergeAuthorized, null)
  })
})

test('after the guided rebase, re-authorization passes and re-pins the command fresh (PMR-5PQH guard)', async () => {
  const landing = createLandingState()
  const harness = landHarness({ landing })
  await withFakeAven(async () => {
    const first = await harness.execute('a6', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(first.isError, undefined)
    const second = await harness.execute('a7', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(second.isError, undefined, 're-authorization must re-evaluate')
    assert.equal(
      harness.suiteRuns(),
      1,
      'second call adopts the receipt — suite NOT re-run',
    )
    if (landing.mergeAuthorized === null) {
      throw new Error('merge command must be re-pinned on re-authorization')
    }
    assert.equal(
      landing.mergeAuthorized.command,
      `git -C '/repo' merge --ff-only flow-branch`,
      'command is re-derived from the current resolution, not a stored no-op',
    )
  })
})

test('every authorization attempt invalidates a previous pin — even resolver failures (PMR-1KAE review blocker)', async () => {
  const landing = createLandingState()
  let resolveMain: string | null = '/repo'
  const harness = landHarness({
    landing,
    resolveMainRepo: async () => resolveMain,
  })
  await withFakeAven(async () => {
    const first = await harness.execute('b1', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(first.isError, undefined)
    if (landing.mergeAuthorized === null) {
      throw new Error('the first ok call must pin the merge command')
    }
    resolveMain = null // the main checkout becomes unresolvable on the retry
    const second = await harness.execute('b2', {
      ref: 'PMR-ABC1',
      route: 'merge-main',
    })
    assert.equal(second.isError, true)
    assert.equal(
      landing.mergeAuthorized,
      null,
      'a refused attempt must not leave the earlier pin authorized',
    )
  })
})

test('route=pr never consults the main-advancement check (PMR-1KAE)', async () => {
  let calls = 0
  const harness = landHarness({
    checker: async () => {
      calls += 1
      return { ok: false, reason: 'should not be called' }
    },
  })
  await withFakeAven(async () => {
    const result = await harness.execute('a8', {
      ref: 'PMR-ABC1',
      route: 'pr',
    })
    assert.equal(result.isError, undefined)
    assert.equal(calls, 0, 'the pr route has no merge to guard')
  })
})
