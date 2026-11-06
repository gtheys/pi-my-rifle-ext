import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import reviewExtension, {
  buildFullReviewPrompt,
  canSpawnReviewSubagent,
  releasePrJob,
  reservePrJobs,
  skipOcrScout,
} from '../review/review.ts'

type CapturedCommand = { name: string; options: unknown }

type CapturedTool = {
  name: string
  execute: (
    toolCallId: string,
    params: { target: { type: string; [k: string]: unknown } },
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: Record<string, unknown>,
  ) => Promise<{
    content: { type: string; text: string }[]
    isError?: boolean
    details?: unknown
  }>
}

function makeMockPi() {
  const commands: CapturedCommand[] = []
  const tools: CapturedTool[] = []
  const mockPi = {
    registerCommand: (name: string, options: unknown) => {
      commands.push({ name, options })
    },
    registerTool: (options: unknown) => {
      tools.push(options as CapturedTool)
    },
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    exec: async () => ({
      code: 1,
      stdout: '',
      stderr: '',
      killed: false,
      signal: null,
    }),
    on: () => () => {},
    appendEntry: async () => {},
    getActiveTools: () => [],
  } as unknown as ExtensionAPI
  return { commands, tools, mockPi }
}

test('registers the review tool and the human commands', () => {
  const { commands, tools, mockPi } = makeMockPi()
  reviewExtension(mockPi)

  const toolNames = tools.map((t) => t.name)
  assert.ok(toolNames.includes('review'), 'review tool registered')

  const commandNames = commands.map((c) => c.name)
  assert.ok(commandNames.includes('review'), '/review command registered')
  assert.ok(
    commandNames.includes('end-review'),
    '/end-review command registered',
  )
})

test('tool execute returns a clean error without a mux', async (t) => {
  // AIDEV-NOTE: PMR-2DS4 — canSpawnReviewSubagent requires HERDR_* env, so
  // clearing it forces the no-mux path even when a real herdr is running
  // (the normal dev environment) — no skip, no real subagents.
  const saved = {
    ws: process.env.HERDR_WORKSPACE_ID,
    pane: process.env.HERDR_PANE_ID,
  }
  delete process.env.HERDR_WORKSPACE_ID
  delete process.env.HERDR_PANE_ID
  t.after(() => {
    if (saved.ws !== undefined) process.env.HERDR_WORKSPACE_ID = saved.ws
    if (saved.pane !== undefined) process.env.HERDR_PANE_ID = saved.pane
  })
  const { tools, mockPi } = makeMockPi()
  reviewExtension(mockPi)

  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')

  const notifications: string[] = []
  const result = await tool.execute(
    'call-1',
    { target: { type: 'uncommitted' } },
    new AbortController().signal,
    undefined,
    {
      cwd: os.tmpdir(),
      hasUI: false,
      mode: 'tui',
      ui: { notify: (msg: string) => notifications.push(msg) },
      sessionManager: {},
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /mux/)
  // Pin the isError shape: no fabricated details payload (PMR-1EJB).
  assert.equal(result.details, undefined)
})

test('buildFullReviewPrompt composes rubric + target prompt + guidelines', async () => {
  const { mockPi } = makeMockPi()

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-prompt-'))
  await fs.mkdir(path.join(tmp, '.pi'), { recursive: true })
  await fs.writeFile(
    path.join(tmp, 'REVIEW_GUIDELINES.md'),
    'Always check for SQL injection in the auth module.',
    'utf8',
  )

  try {
    const prompt = await buildFullReviewPrompt(
      mockPi,
      { type: 'uncommitted' },
      tmp,
    )
    assert.match(prompt, /# Review Guidelines/)
    assert.match(
      prompt,
      /Review the current code changes \(staged, unstaged, and untracked files\)/,
    )
    assert.match(prompt, /Always check for SQL injection in the auth module\./)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// --- PMR-C6AK: ocr scout skip during personal-mode flows ---

test('skipOcrScout: personal flow skips ocr, work flow and no flow keep it', () => {
  assert.equal(skipOcrScout('PMR-ABC1', 'personal'), true)
  assert.equal(skipOcrScout('PMR-ABC1', 'work'), false)
  assert.equal(skipOcrScout(null, 'personal'), false)
  assert.equal(skipOcrScout(null, 'work'), false)
})

test('canSpawnReviewSubagent: requires running inside herdr AND a reachable mux', () => {
  const up = () => true
  const down = () => false
  assert.equal(canSpawnReviewSubagent({}, up), false)
  assert.equal(
    canSpawnReviewSubagent({ HERDR_WORKSPACE_ID: 'w1' }, down),
    false,
  )
  assert.equal(canSpawnReviewSubagent({ HERDR_WORKSPACE_ID: 'w1' }, up), true)
  assert.equal(canSpawnReviewSubagent({ HERDR_PANE_ID: 'w1:p2' }, up), true)
  assert.equal(canSpawnReviewSubagent({ HERDR_PANE_ID: 'nocolon' }, up), false)
  assert.equal(canSpawnReviewSubagent({ HERDR_WORKSPACE_ID: '  ' }, up), false)
})

// Mirrors spawnReviewJobs: reserve 2, reviewer aborted -> release now,
// reviewer spawned -> release on completion; ocr not spawned -> release now,
// ocr spawned -> release on completion. Worktree removal fires on the last.
for (const reviewer of ['spawned', 'aborted'] as const) {
  for (const ocr of [true, false]) {
    for (const reviewerFinishesFirst of [true, false]) {
      test(`PR job refcount: reviewer ${reviewer}, ocr ${ocr}, reviewerFirst ${reviewerFinishesFirst}`, () => {
        const info = { pending: 0 }
        reservePrJobs(info)
        assert.equal(info.pending, 2)
        let removals = 0
        const release = () => {
          if (releasePrJob(info)) removals += 1
        }
        const later: Array<() => void> = []
        if (reviewer === 'aborted') release()
        else later.push(release)
        if (ocr) later.push(release)
        else release()
        if (!reviewerFinishesFirst) later.reverse()
        for (const job of later) {
          assert.equal(removals, 0, 'no removal while a job is outstanding')
          job()
        }
        assert.equal(removals, 1, 'worktree removed exactly once')
        assert.equal(info.pending, 0)
      })
    }
  }
}

// --- PMR-6EEW gate integrity: /review target pinning ---

import { buildReviewGatePin, reviewEchoSection } from '../review/review.ts'
import type { Exec } from '../shared/diff-base.ts'
import { buildGateTarget, reviewedRangeLine } from '../validate/gate-target.ts'

const R_BASE = 'a'.repeat(40)
const R_HEAD = 'b'.repeat(40)

function gitFake(
  map: Record<string, { stdout?: string; code?: number }>,
): Exec {
  return async (_cmd, args) => {
    const hit = map[args.join(' ')]
    if (hit === undefined) return { stdout: '', code: 1 }
    return { stdout: hit.stdout ?? '', code: hit.code ?? 0 }
  }
}

const PIN_GIT = {
  'rev-parse --abbrev-ref main@{upstream}': { stdout: 'origin/main\n' },
  'merge-base HEAD origin/main': { stdout: `${R_BASE}\n` },
  'rev-parse HEAD': { stdout: `${R_HEAD}\n` },
  [`rev-parse ${R_BASE}`]: { stdout: `${R_BASE}\n` },
  [`diff ${R_BASE}..${R_HEAD}`]: { stdout: 'diff --git a/x b/x\n+fix\n' },
}

test('buildReviewGatePin pins baseBranch reviews against the merge-base', async () => {
  const pin = await buildReviewGatePin(
    gitFake(PIN_GIT),
    { type: 'baseBranch', branch: 'main' },
    '/repo',
  )
  assert.ok(pin !== null)
  assert.equal(pin.gate, 'review')
  assert.equal(pin.baseSha, R_BASE)
  assert.equal(pin.headSha, R_HEAD)
  assert.equal(pin.ref, 'review-branch-main')
})

test('buildReviewGatePin returns null for unpinnable and unresolvable targets', async () => {
  const uncommitted = await buildReviewGatePin(gitFake(PIN_GIT), {
    type: 'uncommitted',
  })
  assert.equal(uncommitted, null)

  const folder = await buildReviewGatePin(gitFake(PIN_GIT), {
    type: 'folder',
    paths: ['src/'],
  })
  assert.equal(folder, null)

  const unresolvable = await buildReviewGatePin(
    gitFake({ 'rev-parse HEAD': { stdout: `${R_HEAD}\n` } }),
    { type: 'baseBranch', branch: 'main' },
  )
  assert.equal(unresolvable, null)
})

test('buildReviewGatePin pins commit reviews as sha^..sha', async () => {
  const commit = 'c'.repeat(40)
  const pin = await buildReviewGatePin(
    gitFake({
      [`rev-parse ${commit}^`]: { stdout: R_BASE },
      [`rev-parse ${commit}`]: { stdout: commit },
      [`diff ${R_BASE}..${commit}`]: { stdout: 'diff --git a/y b/y\n+z\n' },
    }),
    { type: 'commit', sha: commit },
  )
  assert.ok(pin !== null)
  assert.equal(pin.baseSha, R_BASE)
  assert.equal(pin.headSha, commit)
  assert.match(pin.ref, /^review-commit-/)
})

test('reviewEchoSection instructs the reviewer to echo the pin exactly', () => {
  const built = buildGateTarget({
    gate: 'review',
    ref: 'review-branch-main',
    baseSha: R_BASE,
    headSha: R_HEAD,
    diff: 'x',
  })
  if (!('diffSha256' in built)) throw new Error('fixture failed')
  const section = reviewEchoSection(built)
  assert.ok(section.includes(reviewedRangeLine(built)))
  assert.match(section, /character by character/)
  assert.match(section, /final line/)
})
