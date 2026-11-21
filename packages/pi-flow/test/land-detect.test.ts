// PMR-H5ST: repo-aware land test detection + resolution precedence for the
// flow_land suite runner. The detection matrix covers every signal file plus
// the fixed first-match order for hybrid repos. Precedence tests redirect
// PI_CODING_AGENT_DIR to a temp agent dir so the real ~/.pi/agent config can
// never leak into results (getAgentDir() reads the env at call time).
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
    detected: {
      command: [...DEFAULT_LAND_TEST_COMMAND],
      signal: 'bun.lock',
    },
    unreadable: [],
  })
})

test('detection: bunfig.toml → bun run test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['bunfig.toml'])), {
    detected: {
      command: [...DEFAULT_LAND_TEST_COMMAND],
      signal: 'bunfig.toml',
    },
    unreadable: [],
  })
})

test('detection: Cargo.toml → cargo test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['Cargo.toml'])), {
    detected: {
      command: ['cargo', 'test'],
      signal: 'Cargo.toml',
    },
    unreadable: [],
  })
})

test('detection: package-lock.json → npm test', async () => {
  assert.deepEqual(
    await detectLandTestCommand(makeRepo(['package-lock.json'])),
    {
      detected: { command: ['npm', 'test'], signal: 'package-lock.json' },
      unreadable: [],
    },
  )
})

test('detection: pnpm-lock.yaml → pnpm test', async () => {
  assert.deepEqual(await detectLandTestCommand(makeRepo(['pnpm-lock.yaml'])), {
    detected: {
      command: ['pnpm', 'test'],
      signal: 'pnpm-lock.yaml',
    },
    unreadable: [],
  })
})

test('detection: no signals → null (caller falls back to default)', async () => {
  assert.equal((await detectLandTestCommand(makeRepo([]))).detected, null)
})

test('detection: hybrid repo resolves deterministically in the fixed order', async () => {
  const bunBeatsAll = await detectLandTestCommand(
    makeRepo(['bun.lock', 'Cargo.toml', 'package-lock.json']),
  )
  assert.equal(bunBeatsAll?.detected?.signal, 'bun.lock')
  const cargoBeatsNode = await detectLandTestCommand(
    makeRepo(['Cargo.toml', 'package-lock.json']),
  )
  assert.equal(cargoBeatsNode?.detected?.signal, 'Cargo.toml')
  const npmBeatsPnpm = await detectLandTestCommand(
    makeRepo(['package-lock.json', 'pnpm-lock.yaml']),
  )
  assert.equal(npmBeatsPnpm?.detected?.signal, 'package-lock.json')
})

// --- signal entry type (PMR-RH97): only regular files count ---

// PMR-RH97: fs.access matched ANY existing entry, so a directory named like a
// signal file could misroute the land test. These tests pin the stat + isFile
// semantics: non-regular entries and stat errors fall through the scan.

test('detection: directory named Cargo.toml is not a signal', async () => {
  const repo = makeRepo([])
  mkdirSync(path.join(repo, 'Cargo.toml'))
  assert.equal((await detectLandTestCommand(repo)).detected, null)
})

test('detection: directory signal does not shadow a later real signal', async () => {
  const repo = makeRepo(['bun.lock'])
  mkdirSync(path.join(repo, 'Cargo.toml'))
  assert.deepEqual(await detectLandTestCommand(repo), {
    detected: {
      command: [...DEFAULT_LAND_TEST_COMMAND],
      signal: 'bun.lock',
    },
    unreadable: [],
  })
})

test('detection: dangling symlink is not a signal', async () => {
  const repo = makeRepo([])
  symlinkSync(path.join(repo, 'does-not-exist'), path.join(repo, 'bun.lock'))
  assert.equal((await detectLandTestCommand(repo)).detected, null)
})

test('detection: symlink to a regular file still counts (stat follows links)', async () => {
  const repo = makeRepo(['real-lockfile'])
  symlinkSync(path.join(repo, 'real-lockfile'), path.join(repo, 'bun.lock'))
  assert.deepEqual(await detectLandTestCommand(repo), {
    detected: {
      command: [...DEFAULT_LAND_TEST_COMMAND],
      signal: 'bun.lock',
    },
    unreadable: [],
  })
})

test('detection: unreadable signal (EACCES) is recorded, not treated as absent', async () => {
  const repo = makeRepo(['bun.lock'])
  chmodSync(repo, 0o000)
  try {
    const scan = await detectLandTestCommand(repo)
    assert.equal(scan.detected, null)
    // Every signal in the fixed scan order is recorded as unreadable.
    assert.deepEqual(scan.unreadable, [
      'bun.lock (EACCES)',
      'bunfig.toml (EACCES)',
      'Cargo.toml (EACCES)',
      'package-lock.json (EACCES)',
      'pnpm-lock.yaml (EACCES)',
    ])
  } finally {
    chmodSync(repo, 0o700)
  }
})

test('fallback source label names an unreadable signal (absent vs unreadable)', async () => {
  // The REPO stays readable (loadConfig must not throw); the unreadability
  // sits in an ANCESTOR of the signal target: bun.lock is a symlink into a
  // directory whose traverse permission is removed, so stat(repo/bun.lock)
  // fails with EACCES while the config lookup stays ENOENT.
  const repo = makeRepo([])
  const secret = mkdtempSync(path.join(TMP_ROOT, 'secret-'))
  symlinkSync(path.join(secret, 'x'), path.join(repo, 'bun.lock'))
  const agentDir = writeGlobalConfig({ workRoots: [] })
  chmodSync(secret, 0o000)
  try {
    await withAgentDir(agentDir, async () => {
      const run = await defaultSuiteRunner(repo)
      // bun default still runs (fail-safe direction unchanged), but the
      // source label distinguishes "signal exists but unreadable" from
      // "no signals".
      assert.match(
        run.summary,
        /land test command: bun run test \(default \(signal read failed: bun\.lock \(EACCES\)/,
      )
    })
  } finally {
    chmodSync(secret, 0o700)
  }
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
      /land test command: echo project-cfg \(landTestCommand config \(project\)\)/,
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
    assert.match(run.summary, /landTestCommand config \(global\)/)
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
    // PMR-1QKY: the label names the winning FILE, not just the key.
    assert.match(run.summary, /landTestCommand config \(project\)/)
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
