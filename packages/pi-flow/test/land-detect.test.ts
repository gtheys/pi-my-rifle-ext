// PMR-H5ST: repo-aware land test detection + resolution precedence for the
// flow_land suite runner. The detection matrix covers every signal file plus
// the fixed first-match order for hybrid repos. Precedence tests redirect
// PI_CODING_AGENT_DIR to a temp agent dir so the real ~/.pi/agent config can
// never leak into results (getAgentDir() reads the env at call time).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_LAND_TEST_COMMAND,
  defaultSuiteRunner,
  detectLandTestCommand,
} from '../tools/land.ts'

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-land-detect-'))

function makeRepo(files: string[]): string {
  const dir = mkdtempSync(path.join(TMP_ROOT, 'repo-'))
  for (const file of files) {
    writeFileSync(path.join(dir, file), '')
  }
  return dir
}

function emptyAgentDir(): string {
  return mkdtempSync(path.join(TMP_ROOT, 'agent-'))
}

function writeGlobalConfig(config: unknown): string {
  const agentDir = emptyAgentDir()
  const dir = path.join(agentDir, 'pi-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
  return agentDir
}

function writeProjectConfig(repo: string, config: unknown): void {
  const dir = path.join(repo, '.pi', 'pi-flow')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
}

async function withAgentDir<T>(
  agentDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
  }
}

// --- detection matrix (pure signal presence, no config involved) ---

test('detection: bun.lock → bun run test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['bun.lock'])), {
    command: [...DEFAULT_LAND_TEST_COMMAND],
    signal: 'bun.lock',
  })
})

test('detection: bunfig.toml → bun run test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['bunfig.toml'])), {
    command: [...DEFAULT_LAND_TEST_COMMAND],
    signal: 'bunfig.toml',
  })
})

test('detection: Cargo.toml → cargo test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['Cargo.toml'])), {
    command: ['cargo', 'test'],
    signal: 'Cargo.toml',
  })
})

test('detection: package-lock.json → npm test', async () => {
  assert.deepEqual(
    await detectLandTestCommand(makeRepo(['package-lock.json'])),
    { command: ['npm', 'test'], signal: 'package-lock.json' },
  )
})

test('detection: pnpm-lock.yaml → pnpm test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['pnpm-lock.yaml'])), {
    command: ['pnpm', 'test'],
    signal: 'pnpm-lock.yaml',
  })
})

test('detection: no signals → null (caller falls back to default)', async () => {
  assert.equal(await detectLandTestCommand(makeRepo([])), null)
})

test('detection: hybrid repo resolves deterministically in the fixed order', async () => {
  const bunBeatsAll = await detectLandTestCommand(
    makeRepo(['bun.lock', 'Cargo.toml', 'package-lock.json']),
  )
  assert.equal(bunBeatsAll?.signal, 'bun.lock')
  const cargoBeatsNode = await detectLandTestCommand(
    makeRepo(['Cargo.toml', 'package-lock.json']),
  )
  assert.equal(cargoBeatsNode?.signal, 'Cargo.toml')
  const npmBeatsPnpm = await detectLandTestCommand(
    makeRepo(['package-lock.json', 'pnpm-lock.yaml']),
  )
  assert.equal(npmBeatsPnpm?.signal, 'package-lock.json')
})

// --- resolution precedence through defaultSuiteRunner ---
// AIDEV-NOTE: every runner-level test redirects PI_CODING_AGENT_DIR — without
// it loadConfig would read the developer's real global pi-flow config and the
// results would depend on the machine.

test('precedence: explicit config wins over repo detection', async () => {
  const repo = makeRepo(['Cargo.toml'])
  writeProjectConfig(repo, {
    workRoots: [],
    landTestCommand: ['echo', 'project-cfg'],
  })
  await withAgentDir(emptyAgentDir(), async () => {
    const run = await defaultSuiteRunner(repo)
    assert.equal(run.ok, true)
    assert.match(
      run.summary,
      /land test command: echo project-cfg \(landTestCommand config\)/,
    )
  })
})

test('precedence: global config wins over repo detection', async () => {
  const repo = makeRepo(['Cargo.toml'])
  const agentDir = writeGlobalConfig({
    workRoots: [],
    landTestCommand: ['echo', 'global-cfg'],
  })
  await withAgentDir(agentDir, async () => {
    const run = await defaultSuiteRunner(repo)
    assert.equal(run.ok, true)
    assert.match(run.summary, /echo global-cfg/)
    assert.match(run.summary, /landTestCommand config/)
  })
})

test('precedence: project config wins over global config (loadConfig per-key merge)', async () => {
  const repo = makeRepo([])
  const agentDir = writeGlobalConfig({
    workRoots: [],
    landTestCommand: ['echo', 'global-cfg'],
  })
  writeProjectConfig(repo, {
    workRoots: [],
    landTestCommand: ['echo', 'project-cfg'],
  })
  await withAgentDir(agentDir, async () => {
    const run = await defaultSuiteRunner(repo)
    assert.equal(run.ok, true)
    assert.match(run.summary, /echo project-cfg/)
    assert.doesNotMatch(run.summary, /global-cfg/)
  })
})

test('resolution: no config → detection picks the command and names the signal', async () => {
  const repo = makeRepo(['Cargo.toml'])
  const agentDir = writeGlobalConfig({ workRoots: [] })
  await withAgentDir(agentDir, async () => {
    const run = await defaultSuiteRunner(repo)
    // cargo test in a bare-manifest dir fails fast — the gate stays red.
    assert.equal(run.ok, false)
    assert.match(
      run.summary,
      /land test command: cargo test \(repo detection via Cargo.toml\)/,
    )
  })
})

test('resolution: no config, no signals → bun default, fail-closed in a bare dir', async () => {
  const repo = makeRepo([])
  const agentDir = writeGlobalConfig({ workRoots: [] })
  await withAgentDir(agentDir, async () => {
    const run = await defaultSuiteRunner(repo)
    assert.equal(run.ok, false)
    assert.match(run.summary, /land test command: bun run test \(default\)/)
  })
})

test('fail-closed: spawn error on the resolved command is a red run', async () => {
  const repo = makeRepo(['bun.lock'])
  writeProjectConfig(repo, {
    workRoots: [],
    landTestCommand: ['definitely-not-a-real-cmd-pmr-h5st'],
  })
  await withAgentDir(emptyAgentDir(), async () => {
    const run = await defaultSuiteRunner(repo)
    assert.equal(run.ok, false)
    // Bun's execFile error text; node would say "spawn … ENOENT".
    assert.match(run.summary, /Executable not found|ENOENT|suite runner failed/)
  })
})
