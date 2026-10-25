import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { readAvenLabels, setAvenSessionCwd } from '../index.ts'

// Fake `aven` on PATH: records its args and returns a valid label JSON body.
const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-aven-bin-'))
const ARGS_FILE = path.join(BIN_DIR, 'last-args.txt')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${ARGS_FILE}\necho '{"labels":[]}'\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

const WORK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-avenws-'))
// Session cwd differs from process.cwd() — the mismatch case (worktree / --cwd).
const SESSION_CWD = path.join(WORK_ROOT, 'session-repo')
const OVERRIDE = path.join(WORK_ROOT, 'ws-from-project-config')
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: OVERRIDE }),
)

function lastArgs(): string[] {
  return readFileSync(ARGS_FILE, 'utf8').split('\n').filter(Boolean)
}

test('readAvenLabels honors project avenWorkspace from session cwd, not process.cwd()', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    const labels = await readAvenLabels('PMR-TEST')
    assert.deepEqual(labels, [])
    const args = lastArgs()
    assert.ok(
      args.includes(OVERRIDE),
      `expected --workspace ${OVERRIDE} in args: ${args.join(' ')}`,
    )
    assert.equal(args[args.indexOf(OVERRIDE) - 1], '--workspace')
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

// Sanity: the fake aven shim actually runs in this environment.
test('fake aven shim is executable', () => {
  const out = execFileSync(path.join(BIN_DIR, 'aven'), ['show', 'X'], {
    encoding: 'utf8',
  })
  assert.equal(JSON.parse(out).labels.length, 0)
})

after(() => {
  rmSync(BIN_DIR, { recursive: true, force: true })
  rmSync(WORK_ROOT, { recursive: true, force: true })
})
