// AIDEV-NOTE: PMR-5PQH — REAL git, resolver injection deliberately omitted.
// The field failure was a RESOLUTION failure, not a checker failure: a fresh
// session holds no bound flow worktree, so defaultResolveLandingBranch falls
// back to `git rev-parse --abbrev-ref HEAD` in landingSuiteCwd() — the MAIN
// checkout — and the landing branch resolves to the base branch itself.
// Pre-5144bf8 the tool then pinned `git -C <main> merge --ff-only main`
// (a no-op that cannot move main) and reported ok. These tests drive
// registerLandTool through the DEFAULT resolvers and the DEFAULT advancement
// gate against a real main-checkout + flow-worktree fixture, pinning exactly
// that seam: the unbound resolution must refuse with the explicit
// stale-resolution no-op message; the bound resolution must pin a command
// that actually fast-forwards main to the flow branch head.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  clearFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import type {
  EffectDeclareInput,
  EffectJournal,
  ReceiptJournal,
  ReceiptQuery,
} from '../run-state.ts'
import {
  createLandingState,
  registerLandTool,
  type SuiteRunner,
} from '../tools/land.ts'

const REF = 'PMR-5PQH'

// Fake aven binary on PATH answers the review-passed label read (same
// pattern as land-advancement-tool.test.ts; no real aven, no real journal).
const BIN_DIR = mkdtempSync(path.join(tmpdir(), 'pi-flow-land-resolution-bin-'))
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\necho '{"ref":"${REF}","labels":["review-passed"]}'\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

type LandExecute = (
  toolCallId: string,
  params: { ref: string; route: 'pr' | 'merge-main'; artifact?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

// Type-only twins: the journal VALUES are local fakes (no real run-state),
// but their shapes are the real EffectJournal/ReceiptJournal interfaces so
// the registerLandTool call stays typecheck-honest. Type-only imports are
// erased at runtime, so the file still runs against older trees.
function memEffects(): EffectJournal & { declared: EffectDeclareInput[] } {
  const declared: EffectDeclareInput[] = []
  const seenEffectIds = new Set<string>()
  return {
    declared,
    async declare(input: EffectDeclareInput) {
      const effectId = `${input.ref}\u0000${input.effect}\u0000${input.command}`
      if (!seenEffectIds.has(effectId)) {
        seenEffectIds.add(effectId)
        declared.push(input)
      }
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
        const matches =
          entry.ref === query.ref &&
          entry.command === query.command &&
          entry.target === query.target &&
          entry.headSha === query.headSha
        if (matches) {
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, file: string, msg: string): void {
  execFileSync('sh', ['-c', `echo "${msg}" >> ${file}`], { cwd })
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

// The field layout: a main checkout plus a linked flow worktree. The flow
// branch starts behind main (another flow landed), then the guided rebase
// heals it INSIDE the flow worktree — the exact state after a rebase-reland.
function setupRepo(): { repo: string; flowWt: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'land-resolution-'))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  const flowWt = path.join(root, 'flow-wt')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'branch', '-q', '--set-upstream-to', 'origin/main')
  git(repo, 'branch', '-q', 'flow-branch')
  git(repo, 'worktree', 'add', '-q', flowWt, 'flow-branch')
  commit(flowWt, 'f.txt', 'flow work')
  commit(repo, 'a.txt', 'other flow landed on main')
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', '-q', 'main'],
    { cwd: flowWt },
  )
  // AIDEV-NOTE: PMR-RGA0 — git worktree list (which defaultResolveMainRepo
  // parses) prints REALPATH'd paths. On macOS, tmpdir() lives under
  // /var/folders (a symlink to /private/var/folders), so the raw fixture
  // paths would break the byte-strict exact-command assertion even though
  // the resolver behavior is correct. Normalizing the fixture (not the
  // assertion) keeps the pin strict; on Linux realpath is an identity and
  // the assertion is unchanged.
  return { repo: realpathSync(repo), flowWt: realpathSync(flowWt) }
}

function withCwd(cwd: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.cwd()
  process.chdir(cwd)
  return fn().finally(() => {
    process.chdir(previous)
  })
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

// Registers the tool with EVERY resolver left at its default — the seam
// under test IS the default resolution wiring (PMR-5PQH). Only the edges
// tests must own (suite, receipts, HEAD anchor, human answer) are injected.
function resolutionHarness(options: { repo: string }): {
  execute: LandExecute
  suiteRuns: () => number
  landing: ReturnType<typeof createLandingState>
  effects: ReturnType<typeof memEffects>
} {
  let suiteRunCount = 0
  const countingSuite: SuiteRunner = async () => {
    suiteRunCount += 1
    return { ok: true, summary: 'ok' }
  }
  const landing = createLandingState()
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
    () => REF,
    countingSuite,
    // merge-main needs a human pass: the durable aven answer route.
    async () => 'pass',
    memReceipts(),
    async () => git(options.repo, 'rev-parse', 'HEAD'),
    undefined,
    effects,
    // resolveMainRepo / resolveLandingBranch / checkMainAdvancement are
    // intentionally NOT injected (see file header).
  )
  if (!execute) throw new Error('flow_land tool not registered')
  return {
    execute,
    suiteRuns: () => suiteRunCount,
    landing,
    effects,
  }
}

test('real git, unbound fresh session: landing branch resolves to the base and the landing refuses with the stale-resolution no-op message (PMR-5PQH)', async () => {
  const { repo } = setupRepo()
  clearFlowWorktree()
  await withFakeAven(() =>
    withCwd(repo, async () => {
      const h = resolutionHarness({ repo })
      const result = await h.execute('a1', { ref: REF, route: 'merge-main' })
      assert.equal(
        result.isError,
        true,
        'the unbound resolution must refuse — authorizing here pins a base-into-base no-op, the exact PMR-5PQH failure',
      )
      const text = result.content.map((c) => c.text).join('\n')
      assert.match(text, /stale resolution/)
      assert.match(text, /no-op/)
      assert.match(text, /flow worktree bound/)
      assert.equal(
        h.landing.mergeAuthorized,
        null,
        'a refused landing must not leave a merge command pinned',
      )
      const mergeEffects = h.effects.declared.filter(
        (e) => e.effect === 'merge-main',
      )
      assert.equal(
        mergeEffects.length,
        0,
        'a refusal must not journal a merge-main effect',
      )
    }),
  )
})

test('real git, bound flow worktree: landing branch resolves to the flow branch and the pinned command actually moves main (PMR-5PQH)', async () => {
  const { repo, flowWt } = setupRepo()
  setActiveFlowRef(REF)
  const bound = setFlowWorktree(flowWt, 'flow-branch')
  assert.equal(bound, true, 'the fixture must bind the flow worktree')
  await withFakeAven(() =>
    withCwd(repo, async () => {
      const h = resolutionHarness({ repo })
      const result = await h.execute('a2', { ref: REF, route: 'merge-main' })
      assert.equal(
        result.isError,
        undefined,
        'a fresh, correctly resolved landing must authorize',
      )
      const pin = h.landing.mergeAuthorized
      if (pin === null) {
        throw new Error('an authorized merge-main must pin the exact command')
      }
      assert.equal(
        pin.command,
        `git -C '${repo}' merge --ff-only flow-branch`,
        'the pin must name the FLOW branch resolved through the binding, never the base branch',
      )
      // The done-when: the pinned command must be able to MOVE main to the
      // flow branch head. Execute the pinned operation as the human would.
      execFileSync('git', ['merge', '--ff-only', 'flow-branch'], { cwd: repo })
      assert.equal(
        git(repo, 'rev-parse', 'main'),
        git(repo, 'rev-parse', 'flow-branch'),
        'running the pinned operation must fast-forward main onto the flow branch head',
      )
    }),
  )
  clearFlowWorktree()
  setActiveFlowRef(null)
})
