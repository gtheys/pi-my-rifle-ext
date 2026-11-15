// AIDEV-NOTE: tests for the exact-ref-guarded gate-answer helpers
// (PMR-R5VB). Exercises readGateAnswer / writeGateAnswer through a fake
// aven on PATH: happy reads for both gates, null on absent metadata /
// exit-0 stderr error / fuzzy first-line ref, and guarded writes that only
// emit `edit <ref> --metadata ...` after the exact-ref read passes.
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
import { readGateAnswer, setAvenSessionCwd, writeGateAnswer } from '../index.ts'

const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-answer-bin-'))
const ARGS_FILE = path.join(BIN_DIR, 'last-args.txt')
const MODE_FILE = path.join(BIN_DIR, 'mode.txt')
const KEY_FILE = path.join(BIN_DIR, 'key.txt')
const ANSWER_FILE = path.join(BIN_DIR, 'answer.txt')
writeFileSync(MODE_FILE, 'ok')
writeFileSync(KEY_FILE, 'spec-answer')
writeFileSync(ANSWER_FILE, '')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh
printf '%s\\n' "$@" > ${ARGS_FILE}
mode=$(cat ${MODE_FILE})
if [ "$1" = "show" ]; then
  if [ "$mode" = "err" ]; then
    echo "Error: boom" >&2
    exit 0
  fi
  if [ "$mode" = "fuzzy" ]; then
    echo "PMR-WRONG7 status=todo title=x"
  else
    echo "$2 status=todo title=x"
  fi
  if [ -s ${ANSWER_FILE} ]; then
    echo "metadata field_id=f1 key=$(cat ${KEY_FILE})"
    echo "value<<EOF"
    cat ${ANSWER_FILE}
    echo "EOF"
  fi
  exit 0
fi
if [ "$1" = "edit" ]; then
  if [ "$mode" = "err" ]; then
    echo "Error: write failed"; exit 0
  fi
  echo "updated $2"
  exit 0
fi
echo "unexpected command"; exit 1
`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

const WORK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-answer-ws-'))
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

function withFakeAven(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SESSION_CWD)
  return fn().finally(() => {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  })
}

test('readGateAnswer: spec gate happy path returns the choice', async () => {
  await withFakeAven(async () => {
    writeFileSync(KEY_FILE, 'spec-answer')
    writeFileSync(ANSWER_FILE, 'approve\n')
    const choice = await readGateAnswer('PMR-ANS1', 'spec')
    assert.equal(choice, 'approve')
    const args = lastArgs()
    assert.deepEqual(args.slice(0, 3), ['show', 'PMR-ANS1', '--full'])
    assert.ok(args.includes(OVERRIDE))
  })
})

test('readGateAnswer: review gate reads review-answer metadata', async () => {
  await withFakeAven(async () => {
    writeFileSync(KEY_FILE, 'review-answer')
    writeFileSync(ANSWER_FILE, 'reject\n')
    const choice = await readGateAnswer('PMR-ANS2', 'review')
    assert.equal(choice, 'reject')
  })
})

test('readGateAnswer: null when metadata block is absent', async () => {
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, '')
    const choice = await readGateAnswer('PMR-ANS3', 'spec')
    assert.equal(choice, null)
  })
})

test('readGateAnswer: null when stderr says Error: with exit 0', async () => {
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    writeFileSync(MODE_FILE, 'err')
    const choice = await readGateAnswer('PMR-ANS4', 'spec')
    assert.equal(choice, null)
    writeFileSync(MODE_FILE, 'ok')
  })
})

test('readGateAnswer: null when first-line ref does not match requested ref', async () => {
  await withFakeAven(async () => {
    writeFileSync(ANSWER_FILE, 'approve\n')
    writeFileSync(MODE_FILE, 'fuzzy')
    const choice = await readGateAnswer('PMR-SHORT', 'spec')
    assert.equal(choice, null)
    writeFileSync(MODE_FILE, 'ok')
  })
})

test('writeGateAnswer: writes edit with metadata and reports true', async () => {
  await withFakeAven(async () => {
    const ok = await writeGateAnswer('PMR-WRT1', 'spec', 'approve')
    assert.equal(ok, true)
    const args = lastArgs()
    assert.ok(args.includes('edit'))
    assert.ok(args.includes('--metadata'))
    assert.ok(args.includes('spec-answer=approve'))
    assert.match(args.join('\n'), /edit\nPMR-WRT1/)
  })
})

test('writeGateAnswer: false on exit-0 Error: output from edit', async () => {
  await withFakeAven(async () => {
    writeFileSync(MODE_FILE, 'err')
    const ok = await writeGateAnswer('PMR-WRT2', 'spec', 'approve')
    assert.equal(ok, false)
    writeFileSync(MODE_FILE, 'ok')
  })
})

test('writeGateAnswer: false and no edit when the guarded read fails', async () => {
  await withFakeAven(async () => {
    writeFileSync(MODE_FILE, 'fuzzy')
    const ok = await writeGateAnswer('PMR-SHORT', 'spec', 'approve')
    assert.equal(ok, false)
    const args = lastArgs()
    assert.ok(!args.includes('edit'), `expected no edit: ${args.join(' ')}`)
    writeFileSync(MODE_FILE, 'ok')
  })
})

after(() => {
  rmSync(BIN_DIR, { recursive: true, force: true })
  rmSync(WORK_ROOT, { recursive: true, force: true })
})
