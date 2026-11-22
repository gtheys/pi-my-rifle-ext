// AIDEV-NOTE: PMR-0KMQ — scripted-exec tests for the commit-mode review gate
// cwd seam. Mirrors test/review-empty-range.test.ts (mock pi, no real git;
// module binding set/reset per test). The mock answers verifyCandidate's
// probes (rev-parse --git-common-dir / --abbrev-ref HEAD) and the seam's
// merge-base --is-ancestor ancestor check; aven/herdr probes fail so the
// fallback sources fail honestly.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import reviewExtension, { resolveCommitReviewCwd } from '../review/review.ts'
import { mkTmpDir } from './tmpdir.ts'

const SESSION_CWD = '/tmp/main-checkout'
// productionReviewDeps wires exists to real existsSync, so the bound path
// must exist on disk even in scripted tests.
const WORKTREE = mkTmpDir('rev-cwd-')
const COMMON_DIR = '/repo/.git'
const BRANCH = 'fix/something'
const SHA = 'a'.repeat(40)

type ExecResult = {
  code: number
  stdout: string
  stderr: string
  killed: boolean
  signal: null
}

function execResult(code: number, stdout: string): ExecResult {
  return { code, stdout, stderr: '', killed: false, signal: null }
}

interface MockScript {
  commonDirCode?: number
  headBranch?: string
  ancestorExit?: number
}

type CommandHandler = (
  args: string,
  ctx: Record<string, unknown>,
) => Promise<void>

function makeGitMockPi(script: MockScript = {}) {
  const tools: {
    name: string
    execute: (
      toolCallId: string,
      params: { target: { type: string; sha?: string; branch?: string } },
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: Record<string, unknown>,
    ) => Promise<{
      content: { type: string; text: string }[]
      isError?: boolean
      details?: unknown
    }>
  }[] = []
  const commands = new Map<string, CommandHandler>()
  const sentUserMessages: string[] = []
  const mockPi = {
    registerCommand: (name: string, def: { handler: CommandHandler }) => {
      commands.set(name, def.handler)
    },
    registerTool: (options: unknown) => {
      tools.push(options as (typeof tools)[number])
    },
    sendMessage: async () => {},
    sendUserMessage: async (text: string) => {
      sentUserMessages.push(text)
    },
    exec: async (_cmd: string, args: string[]) => {
      if (args.includes('--git-common-dir')) {
        let dir = COMMON_DIR
        if (script.commonDirCode === 1) {
          dir = ''
        }
        return execResult(script.commonDirCode ?? 0, `${dir}\n`)
      }
      if (args.includes('--abbrev-ref')) {
        return execResult(0, `${script.headBranch ?? BRANCH}\n`)
      }
      if (args.includes('--is-ancestor')) {
        return execResult(script.ancestorExit ?? 0, '')
      }
      if (args.includes('--git-dir')) {
        return execResult(0, '.git\n')
      }
      return execResult(1, '')
    },
    on: () => () => {},
    appendEntry: async () => {},
    getActiveTools: () => [],
  } as unknown as ExtensionAPI
  return { tools, commands, sentUserMessages, mockPi }
}

interface Notif {
  message: string
  level: string
}

function commandCtx(cwd: string, notifications: Notif[]) {
  return {
    hasUI: true,
    cwd,
    ui: {
      notify: (m: string, l: string) =>
        notifications.push({ message: m, level: l }),
    },
    sessionManager: { getEntries: () => [] },
  }
}

test('resolveCommitReviewCwd: verified binding + sha on the flow branch → worktree cwd', async () => {
  const { mockPi } = makeGitMockPi({ ancestorExit: 0 })
  setActiveFlowRef('PMR-T')
  setFlowWorktree(WORKTREE, BRANCH)
  try {
    const resolution = await resolveCommitReviewCwd(mockPi, SESSION_CWD, SHA)
    assert.deepEqual(resolution, {
      ok: true,
      cwd: WORKTREE,
      source: 'worktree',
    })
  } finally {
    setActiveFlowRef(null)
  }
})

test('resolveCommitReviewCwd: sha not on the flow branch → session cwd', async () => {
  const { mockPi } = makeGitMockPi({ ancestorExit: 1 })
  setActiveFlowRef('PMR-T')
  setFlowWorktree(WORKTREE, BRANCH)
  try {
    const resolution = await resolveCommitReviewCwd(mockPi, SESSION_CWD, SHA)
    assert.deepEqual(resolution, {
      ok: true,
      cwd: SESSION_CWD,
      source: 'session',
    })
  } finally {
    setActiveFlowRef(null)
  }
})

test('resolveCommitReviewCwd: no active flow → session cwd without probing', async () => {
  const { mockPi } = makeGitMockPi({ ancestorExit: 0 })
  let probed = false
  const originalExec = (
    mockPi as unknown as {
      exec: (cmd: string, args: string[]) => Promise<ExecResult>
    }
  ).exec
  ;(
    mockPi as unknown as {
      exec: (cmd: string, args: string[]) => Promise<ExecResult>
    }
  ).exec = async (cmd, args) => {
    probed = true
    return originalExec(cmd, args)
  }
  const resolution = await resolveCommitReviewCwd(mockPi, SESSION_CWD, SHA)
  assert.deepEqual(resolution, {
    ok: true,
    cwd: SESSION_CWD,
    source: 'session',
  })
  assert.equal(probed, false)
})

test('resolveCommitReviewCwd: unresolvable worktree with an active flow fails closed', async () => {
  const { mockPi } = makeGitMockPi({
    commonDirCode: 1,
    ancestorExit: 0,
  })
  setActiveFlowRef('PMR-T')
  setFlowWorktree(WORKTREE, BRANCH)
  try {
    const resolution = await resolveCommitReviewCwd(mockPi, SESSION_CWD, SHA)
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.match(resolution.reason, /no worktree found for PMR-T/)
      assert.match(resolution.reason, /binding:/)
    }
  } finally {
    setActiveFlowRef(null)
  }
})

test('review tool: commit target with an active flow and an unresolvable binding refuses before the mux check', async () => {
  const { tools, mockPi } = makeGitMockPi({ commonDirCode: 1 })
  reviewExtension(mockPi)
  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')
  setActiveFlowRef('PMR-T')
  setFlowWorktree(WORKTREE, BRANCH)
  try {
    const result = await tool.execute(
      'call-1',
      { target: { type: 'commit', sha: SHA } },
      new AbortController().signal,
      undefined,
      {
        cwd: SESSION_CWD,
        hasUI: false,
        mode: 'tui',
        ui: { notify: () => {} },
        sessionManager: {},
      },
    )
    assert.equal(result.isError, true)
    const text = result.content[0]?.text ?? ''
    assert.match(text, /checkout mismatch/)
    assert.match(text, /stale/)
    assert.equal(/subagent mux/.test(text), false)
  } finally {
    setActiveFlowRef(null)
  }
})

test('review tool: commit target with no active flow keeps the session checkout — no checkout-mismatch refusal', async () => {
  const { tools, mockPi } = makeGitMockPi({ ancestorExit: 0 })
  reviewExtension(mockPi)
  const tool = tools.find((t) => t.name === 'review')
  assert.ok(tool, 'review tool registered')

  const result = await tool.execute(
    'call-2',
    { target: { type: 'commit', sha: SHA } },
    new AbortController().signal,
    undefined,
    {
      cwd: SESSION_CWD,
      hasUI: false,
      mode: 'tui',
      ui: { notify: () => {} },
      sessionManager: {},
    },
  )
  // With no active flow the execute proceeds past cwd resolution (session
  // checkout) into the spawn path — the failure text is the mux refusal when
  // no herdr mux exists, or the spawn failure when it does. Either way the
  // checkout-mismatch refusal must NOT fire.
  const text = result.content[0]?.text ?? ''
  assert.equal(/checkout mismatch/.test(text), false)
  assert.equal(result.isError, true)
})

// --- PMR-3P3T: the /review COMMAND path resolves the same commit cwd seam ---

test('/review commit with an active flow runs against the verified worktree', async () => {
  const { commands, sentUserMessages, mockPi } = makeGitMockPi({
    ancestorExit: 0,
  })
  reviewExtension(mockPi)
  const handler = commands.get('review')
  assert.ok(handler, 'review command registered')
  // A worktree carrying project review guidelines; their presence in the
  // sent prompt proves the prompt was built with the worktree cwd.
  const wt = mkTmpDir('rev-cmd-wt-')
  mkdirSync(path.join(wt, '.pi'), { recursive: true })
  // loadProjectReviewGuidelines: .pi marks the project root; the file sits
  // NEXT to it, not inside it.
  writeFileSync(
    path.join(wt, 'REVIEW_GUIDELINES.md'),
    'WORKTREE-GUIDELINES-MARKER',
  )
  setActiveFlowRef('PMR-T')
  setFlowWorktree(wt, BRANCH)
  const notifications: Notif[] = []
  try {
    await handler(`commit ${SHA}`, commandCtx(SESSION_CWD, notifications))
  } finally {
    setActiveFlowRef(null)
  }
  assert.equal(
    notifications.filter((n) => /checkout mismatch/.test(n.message)).length,
    0,
  )
  assert.equal(sentUserMessages.length, 1)
  assert.match(sentUserMessages[0], /WORKTREE-GUIDELINES-MARKER/)
})

test('/review commit with an unverifiable flow worktree refuses with the tool-path wording', async () => {
  const { commands, sentUserMessages, mockPi } = makeGitMockPi({
    commonDirCode: 1,
  })
  reviewExtension(mockPi)
  const handler = commands.get('review')
  assert.ok(handler, 'review command registered')
  setActiveFlowRef('PMR-T')
  setFlowWorktree(WORKTREE, BRANCH)
  const notifications: Notif[] = []
  try {
    await handler(`commit ${SHA}`, commandCtx(SESSION_CWD, notifications))
  } finally {
    setActiveFlowRef(null)
  }
  assert.equal(sentUserMessages.length, 0)
  const refusals = notifications.filter((n) =>
    /checkout mismatch/.test(n.message),
  )
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].level, 'error')
  assert.match(refusals[0].message, /stale/)
  assert.match(refusals[0].message, /\/flow <ref>/)
})

test('/review commit with no active flow keeps the session checkout', async () => {
  const { commands, sentUserMessages, mockPi } = makeGitMockPi({
    ancestorExit: 0,
  })
  reviewExtension(mockPi)
  const handler = commands.get('review')
  assert.ok(handler, 'review command registered')
  const notifications: Notif[] = []
  await handler(`commit ${SHA}`, commandCtx(SESSION_CWD, notifications))
  assert.equal(
    notifications.filter((n) => /checkout mismatch/.test(n.message)).length,
    0,
  )
  assert.equal(sentUserMessages.length, 1)
  assert.equal(/WORKTREE-GUIDELINES-MARKER/.test(sentUserMessages[0]), false)
})

test('/review commit with the sha off the flow branch keeps the session checkout', async () => {
  const { commands, sentUserMessages, mockPi } = makeGitMockPi({
    ancestorExit: 1,
  })
  reviewExtension(mockPi)
  const handler = commands.get('review')
  assert.ok(handler, 'review command registered')
  const wt = mkTmpDir('rev-cmd-wt-off-')
  mkdirSync(path.join(wt, '.pi'), { recursive: true })
  // loadProjectReviewGuidelines: .pi marks the project root; the file sits
  // NEXT to it, not inside it.
  writeFileSync(
    path.join(wt, 'REVIEW_GUIDELINES.md'),
    'WORKTREE-GUIDELINES-MARKER',
  )
  setActiveFlowRef('PMR-T')
  setFlowWorktree(wt, BRANCH)
  const notifications: Notif[] = []
  try {
    await handler(`commit ${SHA}`, commandCtx(SESSION_CWD, notifications))
  } finally {
    setActiveFlowRef(null)
  }
  assert.equal(sentUserMessages.length, 1)
  assert.equal(/WORKTREE-GUIDELINES-MARKER/.test(sentUserMessages[0]), false)
})
