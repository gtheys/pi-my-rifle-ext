// AIDEV-NOTE: PMR-MVSX — the oversized-diff path of the deviation_review
// tool mkdtemps a `deviation-diff-` dir in os.tmpdir() to hand the reviewer
// a pinned diff file. That dir must be removed once the reviewer settles —
// on success AND on every error return (spawn failure, nonzero exit, parse
// error). This test drives the real execute path with real git, forces the
// oversized-diff branch (diff > DEVIATION_INLINE_DIFF_MAX), and lets the
// reviewer spawn fail (no mux in tests): the tool returns the fail-closed
// spawn-failure error AND the temp dir must be gone afterwards.
// Template: deviation-worktree-real-git.test.ts (real git, module binding).
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { setActiveFlowRef, setFlowWorktree } from '../flow/worktree-context.ts'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { recordFlowBase } from '../shared/flow-base.ts'
import type {
  DeviationReviewDetails,
  DeviationReviewToolParams,
} from '../tools/deviation.ts'
import { registerDeviationReviewTool } from '../tools/deviation.ts'
// AIDEV-NOTE: PMR-ZMX0 review fix — this real-git fixture must use the
// shared isolation helpers like every other real-git fixture in the
// package: it ran with an inherited process.env and a leaked GIT_DIR made
// it branch/commit/push in the INVOKING checkout (reviewer repro, review
// round 1). isolateProcessGitEnv() at module load + sandboxed exec/git.
import {
  cleanupSandboxes,
  isolateProcessGitEnv,
  makeSandboxExec,
  registerSandbox,
  runInSandbox,
} from './git-sandbox.ts'

isolateProcessGitEnv()

const exec = makeSandboxExec()

function git(cwd: string, ...args: string[]): string {
  return runInSandbox('git', args, cwd)
}

function commit(cwd: string, file: string, msg: string): void {
  runInSandbox('sh', ['-c', `echo "${msg}" >> ${file}`], cwd)
  git(cwd, 'add', '-A')
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg)
}

after(() => {
  cleanupSandboxes()
})

function deviationDiffDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith('deviation-diff-'),
    ),
  )
}

/** No-op journal writer — gate journaling is out of scope for this test. */
function nullWriter(): EventWriter {
  return {
    record: async (_event: FlowRunEvent) => true,
    recordJournalOnly: async (_event: FlowRunEvent) => {},
  } as unknown as EventWriter
}

test('oversized-diff path removes the deviation-diff- temp dir on the spawn-failure error return', async () => {
  const root = registerSandbox(mkdtempSync(path.join(tmpdir(), 'dev-tmpdir-')))
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'repo')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'clone', '-q', origin, repo)
  git(repo, 'checkout', '-q', '-b', 'main')
  commit(repo, 'a.txt', 'initial')
  git(repo, 'push', '-q', 'origin', 'main')

  const baseSha = git(repo, 'rev-parse', 'HEAD')
  assert.ok((await recordFlowBase(exec, repo, 'feat/x', 'main', baseSha)).ok)
  const wt = path.join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, baseSha)
  // Oversized diff: DEVIATION_INLINE_DIFF_MAX is 30_000 chars; 1500 lines of
  // ~40 chars of additions clears it comfortably.
  const big = Array.from(
    { length: 1500 },
    (_, i) => `line ${i + 1}: ${'x'.repeat(40)}`,
  ).join('\n')
  writeFileSync(path.join(wt, 'big.txt'), `${big}\n`)
  git(wt, 'add', '-A')
  git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'big')

  setActiveFlowRef('PMR-TMPDIR')
  setFlowWorktree(wt, 'feat/x')
  const before = deviationDiffDirs()
  try {
    const tools: { name: string }[] = []
    const mockPi = {
      registerTool: (options: { name: string }) => {
        tools.push(options)
      },
      on: () => () => {},
      exec: (cmd: string, args: string[], opts?: { cwd?: string }) =>
        exec(cmd, args, opts),
    } as unknown as ExtensionAPI
    registerDeviationReviewTool(mockPi, nullWriter())
    const options = tools[0] as unknown as {
      execute: (
        id: string,
        params: DeviationReviewToolParams,
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: { cwd: string },
      ) => Promise<AgentToolResult<DeviationReviewDetails>>
    }
    const params: DeviationReviewToolParams = {
      mode: 'personal',
      ref: 'PMR-TMPDIR',
      spec: 'The feature must persist user settings across restarts.',
      avenNotes: '',
    }
    // ctx has no sessionManager/ui: launchSubagent throws, which is exactly
    // the spawn-failure error path — the temp dir must still be removed.
    const result = await options.execute(
      't1',
      params,
      new AbortController().signal,
      undefined,
      { cwd: repo },
    )
    assert.equal(result.isError, true)
    const block = result.content[0]
    assert.ok(block !== undefined && block.type === 'text')
    assert.match(block.text ?? '', /reviewer spawn failed/)

    const leaked = [...deviationDiffDirs()].filter((d) => !before.has(d))
    assert.deepEqual(
      leaked,
      [],
      `deviation-diff- temp dir(s) leaked: ${leaked.join(', ')}`,
    )
  } finally {
    setActiveFlowRef(null)
    rmSync(root, { recursive: true, force: true })
  }
})
