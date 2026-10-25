/**
 * Integration test for worktree placement (PMR-11TD) — herdr-only.
 *
 * Spawns a REAL pi session whose subagent tool call uses `worktree: true`.
 * The child runs with cwd = a fresh git worktree; file assertions on both
 * the worktree and the main checkout prove isolation.
 *
 * Costs: ~$0.01-0.05 per run. Duration: ~30-90s.
 * Run inside herdr: npm run test:integration
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  cleanupTestEnv,
  createTestEnv,
  createTrackedSurface,
  isHerdrIntegrationAvailable,
  PI_TIMEOUT,
  sleep,
  startPi,
  type TestEnv,
  waitForFile,
  waitForScreen,
} from './harness.ts'

if (!isHerdrIntegrationAvailable()) {
  console.log(
    '⚠️  Not inside herdr (HERDR_PANE_ID unset) — skipping worktree integration tests',
  )
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

/** Poll `git worktree list --porcelain` until a linked worktree appears. */
async function waitForLinkedWorktree(
  repoDir: string,
  timeout: number,
): Promise<{ path: string; branch: string }> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const out = git(['worktree', 'list', '--porcelain'], repoDir)
    for (const block of out.split('\n\n')) {
      const path = block.match(/^worktree (.+)$/m)?.[1]
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]
      if (path && path !== repoDir && branch) return { path, branch }
    }
    await sleep(2000)
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for a linked worktree of ${repoDir}`,
  )
}

describe('worktree placement [herdr]', { timeout: PI_TIMEOUT * 3 }, () => {
  let env: TestEnv
  const createdBranches: string[] = []

  before(() => {
    if (!isHerdrIntegrationAvailable()) return
    env = createTestEnv()
    // The test project must be a git repo for `worktree: true`.
    git(['init', '-q'], env.dir)
    git(['config', 'user.email', 'test@test'], env.dir)
    git(['config', 'user.name', 'test'], env.dir)
    git(['add', '.'], env.dir)
    git(['commit', '-qm', 'init'], env.dir)
    // AIDEV-NOTE: PMR-CM6D — the fixture commit must land in the temp repo,
    // never in an ambient repo reached by upward .git resolution. Fail loud
    // before any test spawns agents against a polluted repo.
    assert.equal(
      realpathSync(git(['rev-parse', '--show-toplevel'], env.dir)),
      realpathSync(env.dir),
      'fixture repo toplevel must be the temp dir',
    )
  })

  after(() => {
    if (!env) return
    // Manual worktree removal — the extension never auto-removes (PMR-11TD).
    for (const branch of createdBranches) {
      try {
        const slug = branch.replace(/\//g, '-')
        const wtPath = join(
          homedir(),
          '.herdr',
          'worktrees',
          basename(env.dir),
          slug,
        )
        git(['worktree', 'remove', '--force', wtPath], env.dir)
        git(['branch', '-qD', branch], env.dir)
      } catch {}
    }
    try {
      rmSync(join(homedir(), '.herdr', 'worktrees', basename(env.dir)), {
        recursive: true,
        force: true,
      })
    } catch {}
    cleanupTestEnv(env)
  })

  it('worktree:true spawns the child in an isolated git worktree', async () => {
    const id = `${Date.now().toString(36)}`
    const markerName = `wt-marker-${id}.txt`
    const pwdName = `wt-pwd-${id}.txt`

    const surface = createTrackedSurface(env, `wt-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "WT-${id}"`,
      `  agent: "test-echo"`,
      `  worktree: true`,
      `  task: "Run these bash commands exactly: echo 'PASS_${id}' > '${markerName}' && pwd > '${pwdName}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
      `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // A linked worktree off the test repo appears with a subagent/* branch.
    const wt = await waitForLinkedWorktree(env.dir, PI_TIMEOUT)
    createdBranches.push(wt.branch)
    assert.match(
      wt.branch,
      /^subagent\/wt-/,
      `branch should be subagent/<slug>-…, got ${wt.branch}`,
    )
    assert.ok(
      wt.path.includes(join('.herdr', 'worktrees', basename(env.dir))),
      `worktree path should follow the herdr layout, got ${wt.path}`,
    )

    // The child wrote its files in ITS worktree, not the main checkout.
    const content = await waitForFile(
      join(wt.path, markerName),
      PI_TIMEOUT,
      /PASS/,
    )
    assert.ok(content.includes(`PASS_${id}`))
    assert.ok(
      !existsSync(join(env.dir, markerName)),
      'marker must NOT leak into the main checkout',
    )

    const pwdContent = await waitForFile(join(wt.path, pwdName), PI_TIMEOUT)
    assert.equal(
      readFileSync(join(wt.path, pwdName), 'utf8').trim(),
      wt.path,
      `child cwd should be the worktree (pwd file said: ${pwdContent.trim()})`,
    )

    // The durable result references the worktree; removal is manual.
    await waitForScreen(surface, /INTEGRATION_COMPLETE|Worktree:/, PI_TIMEOUT)
  })
})
