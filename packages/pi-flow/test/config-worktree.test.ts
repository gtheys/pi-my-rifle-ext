// AIDEV-NOTE: PMR-BF8W — herdr worktree bootstrap copies only .env*, so the
// repo's .pi/pi-flow/config.json never reaches a linked git worktree and a
// stale GLOBAL landTestCommand (e.g. ["cargo","test"] left over for another
// project) silently won the flow_land gate. These tests pin the fix:
// loadConfig consults the MAIN checkout's project config when cwd is a linked
// worktree (git rev-parse --git-common-dir), the nearest config still wins,
// and main-checkout behavior is unchanged. Real git, no fakes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadConfig, loadConfigWithOrigins } from '../config.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeProjectConfig(
  repo: string,
  config: Record<string, unknown>,
): void {
  const dir = path.join(repo, '.pi', 'pi-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
}

function writeGlobalConfig(
  agentDir: string,
  config: Record<string, unknown>,
): void {
  const dir = path.join(agentDir, 'pi-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
}

async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>) {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

interface WorktreeScenario {
  root: string
  agentDir: string
  mainRepo: string
  worktree: string
}

// Main repo with one commit + a linked worktree carrying NO .pi config —
// exactly the state a fresh herdr bootstrap leaves behind (only .env* copied).
function makeScenario(): WorktreeScenario {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-flow-wt-'))
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-agent-'))
  const mainRepo = path.join(root, 'main')
  git(root, 'init', '-q', '-b', 'main', mainRepo)
  writeFileSync(path.join(mainRepo, 'README.md'), 'x\n')
  git(mainRepo, 'add', '-A')
  git(
    mainRepo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'init',
  )
  const worktree = path.join(root, 'wt')
  git(mainRepo, 'worktree', 'add', '-q', worktree)
  return { root, agentDir, mainRepo, worktree }
}

function cleanup(scenario: WorktreeScenario): void {
  rmSync(scenario.root, { recursive: true, force: true })
  rmSync(scenario.agentDir, { recursive: true, force: true })
}

test('PMR-BF8W: linked worktree resolves landTestCommand from main checkout project config', async () => {
  const scenario = makeScenario()
  try {
    // Stale global command left over for another project (the field failure).
    writeGlobalConfig(scenario.agentDir, {
      workRoots: [],
      landTestCommand: ['cargo', 'test'],
    })
    // Correct repo override, present only in the MAIN checkout.
    writeProjectConfig(scenario.mainRepo, {
      workRoots: [],
      landTestCommand: ['echo', 'project-cfg'],
    })
    await withAgentDir(scenario.agentDir, async () => {
      const config = await loadConfig(scenario.worktree)
      assert.deepEqual(config.landTestCommand, ['echo', 'project-cfg'])
    })
  } finally {
    cleanup(scenario)
  }
})

test('PMR-BF8W: linked worktree — works from a nested cwd too', async () => {
  const scenario = makeScenario()
  try {
    writeGlobalConfig(scenario.agentDir, {
      workRoots: [],
      landTestCommand: ['cargo', 'test'],
    })
    writeProjectConfig(scenario.mainRepo, {
      workRoots: [],
      landTestCommand: ['echo', 'project-cfg'],
    })
    const nested = path.join(scenario.worktree, 'packages', 'deep')
    mkdirSync(nested, { recursive: true })
    await withAgentDir(scenario.agentDir, async () => {
      const config = await loadConfig(nested)
      assert.deepEqual(config.landTestCommand, ['echo', 'project-cfg'])
    })
  } finally {
    cleanup(scenario)
  }
})

test('PMR-BF8W: worktree-local project config wins over main checkout (nearest wins)', async () => {
  const scenario = makeScenario()
  try {
    writeGlobalConfig(scenario.agentDir, {
      workRoots: [],
      landTestCommand: ['cargo', 'test'],
    })
    writeProjectConfig(scenario.mainRepo, {
      workRoots: [],
      landTestCommand: ['echo', 'project-cfg'],
    })
    writeProjectConfig(scenario.worktree, {
      workRoots: [],
      landTestCommand: ['echo', 'wt-cfg'],
    })
    await withAgentDir(scenario.agentDir, async () => {
      const config = await loadConfig(scenario.worktree)
      assert.deepEqual(config.landTestCommand, ['echo', 'wt-cfg'])
    })
  } finally {
    cleanup(scenario)
  }
})

test('PMR-BF8W: main checkout behavior unchanged — project config wins over global', async () => {
  const scenario = makeScenario()
  try {
    writeGlobalConfig(scenario.agentDir, {
      workRoots: [],
      landTestCommand: ['cargo', 'test'],
    })
    writeProjectConfig(scenario.mainRepo, {
      workRoots: [],
      landTestCommand: ['echo', 'project-cfg'],
    })
    await withAgentDir(scenario.agentDir, async () => {
      const config = await loadConfig(scenario.mainRepo)
      assert.deepEqual(config.landTestCommand, ['echo', 'project-cfg'])
    })
  } finally {
    cleanup(scenario)
  }
})

test('PMR-BF8W: non-git cwd — no main-checkout layer, resolution unchanged', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-flow-nogit-'))
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-flow-agent-'))
  try {
    writeGlobalConfig(agentDir, {
      workRoots: [],
      landTestCommand: ['echo', 'global-cfg'],
    })
    await withAgentDir(agentDir, async () => {
      const config = await loadConfig(root)
      assert.deepEqual(config.landTestCommand, ['echo', 'global-cfg'])
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('PMR-BF8W: invalid main checkout config in worktree cwd → clear throw, no silent skip', async () => {
  const scenario = makeScenario()
  try {
    const dir = path.join(scenario.mainRepo, '.pi', 'pi-flow')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'config.json'),
      '{"workRoots": "not-an-array"}',
    )
    await withAgentDir(scenario.agentDir, async () => {
      await assert.rejects(loadConfig(scenario.worktree), /invalid/)
    })
  } finally {
    cleanup(scenario)
  }
})

test('PMR-1QKY: loadConfigWithOrigins names the winning layer per key', async () => {
  const scenario = makeScenario()
  try {
    writeGlobalConfig(scenario.agentDir, {
      workRoots: [],
      landTestCommand: ['cargo', 'test'],
    })
    // Correct command present only in the MAIN checkout's project config —
    // the middle layer wins the landTestCommand key.
    writeProjectConfig(scenario.mainRepo, {
      workRoots: [],
      landTestCommand: ['echo', 'main-cfg'],
    })
    // The worktree-local file carries only workRoots, so per-key provenance
    // must keep landTestCommand pointed at the main-checkout layer.
    writeProjectConfig(scenario.worktree, { workRoots: ['/tmp/other'] })
    await withAgentDir(scenario.agentDir, async () => {
      const { config, origins } = await loadConfigWithOrigins(scenario.worktree)
      assert.deepEqual(config.landTestCommand, ['echo', 'main-cfg'])
      assert.equal(origins.landTestCommand, 'main checkout project')
      assert.equal(origins.workRoots, 'project')
      // Plain checkout (no linked worktree): project wins over global.
      const main = await loadConfigWithOrigins(scenario.mainRepo)
      assert.equal(main.origins.landTestCommand, 'project')
    })
  } finally {
    cleanup(scenario)
  }
})
