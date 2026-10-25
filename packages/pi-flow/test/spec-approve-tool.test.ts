// AIDEV-NOTE: tests for the spec_approve tool wiring (PMR-MR36 fix round).
// Exercises the exported specApprove wrapper through a fake aven on PATH:
// happy path must report ok, an aven exit-0 non-success must fail loud, and
// the workspace must come from the project config override (session cwd).
import assert from 'node:assert/strict'
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
import { setAvenSessionCwd, specApprove } from '../index.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-approve-bin-'))
const ARGS_FILE = path.join(BIN_DIR, 'last-args.txt')
const MODE_FILE = path.join(BIN_DIR, 'mode.txt')
writeFileSync(MODE_FILE, 'ok')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh
printf '%s\\n' "$@" > ${ARGS_FILE}
mode=$(cat ${MODE_FILE})
if [ "$mode" = "ok" ]; then
  for a in "$@"; do
    case "$a" in
      PMR-*) echo "updated $a"; exit 0 ;;
    esac
  done
  echo "no ref"; exit 1
fi
echo "Error: something went wrong"; exit 0
`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

const WORK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-approve-ws-'))
const SESSION_CWD = path.join(WORK_ROOT, 'repo')
const OVERRIDE = 'ws-from-config'
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: OVERRIDE }),
)

function lastArgs(): string[] {
  return readFileSync(ARGS_FILE, 'utf8').split('\n').filter(Boolean)
}

test('specApprove: happy path pins the config workspace and reports ok', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    const result = await specApprove({ ref: 'PMR-APPR' })
    assert.equal(result.ok, true)
    const args = lastArgs()
    assert.ok(args.includes('edit'))
    const idx = args.indexOf(OVERRIDE)
    assert.ok(idx > 0, `expected --workspace ${OVERRIDE}: ${args.join(' ')}`)
    assert.equal(args[idx - 1], '--workspace')
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

test('specApprove: explicit workspace flag wins over config override', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  try {
    const result = await specApprove({
      ref: 'PMR-FLAGS',
      workspace: 'ws-explicit',
    })
    assert.equal(result.ok, true)
    const args = lastArgs()
    assert.ok(args.includes('ws-explicit'))
    assert.ok(!args.includes(OVERRIDE))
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

test('specApprove: aven exit-0 without success line fails loud', async () => {
  setAvenSessionCwd(SESSION_CWD)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  writeFileSync(MODE_FILE, 'fail')
  try {
    const result = await specApprove({ ref: 'PMR-FAIL' })
    assert.equal(result.ok, false)
    assert.match(result.text, /spec_approve/)
    assert.match(result.text, /did not report success|Error:/)
  } finally {
    writeFileSync(MODE_FILE, 'ok')
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

after(() => {
  rmSync(BIN_DIR, { recursive: true, force: true })
  rmSync(WORK_ROOT, { recursive: true, force: true })
})
