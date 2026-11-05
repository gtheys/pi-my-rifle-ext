// PMR-2HFC — after the retry budget is exhausted, further failing reports are
// refused WITHOUT writing another aven note. Fake `aven` on PATH counts
// `note` invocations; the avenWorkspace override (project config in the
// session cwd) skips ref resolution so the note call is the only aven call.
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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import { registerRunAttemptTool } from '../tools/run-attempt.ts'

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-run-attempt-'))
const BIN_DIR = path.join(ROOT, 'bin')
const COUNT_FILE = path.join(ROOT, 'notes.txt')
const SESSION_CWD = path.join(ROOT, 'session')
mkdirSync(BIN_DIR)
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: path.join(ROOT, 'ws') }),
)
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  `#!/bin/sh\n[ "$1" = note ] && echo n >> "${COUNT_FILE}"\nexit 0\n`,
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

type Execute = (
  id: string,
  params: { ref: string; result: { ok: boolean; lastError?: string } },
) => Promise<{ isError?: boolean; content: { text: string }[] }>

test('exhausted budget refuses further attempts without a second note', async () => {
  let execute: Execute | undefined
  registerRunAttemptTool({
    registerTool: (tool: { execute: Execute }) => {
      execute = tool.execute
    },
  } as unknown as ExtensionAPI)
  assert.ok(execute)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SESSION_CWD)
  try {
    const fail = { ref: 'PMR-TEST', result: { ok: false, lastError: 'red' } }
    const statuses: boolean[] = []
    for (let i = 0; i < 5; i++) {
      const r = await execute(`t${i}`, fail)
      statuses.push(r.isError === true)
    }
    assert.deepEqual(statuses, [false, false, true, true, true])
    const notes = readFileSync(COUNT_FILE, 'utf8').split('\n').filter(Boolean)
    assert.equal(notes.length, 1, 'escalation note written exactly once')
    const refused = await execute('t-last', fail)
    assert.match(refused.content[0]?.text ?? '', /already exhausted/)
  } finally {
    process.env.PATH = previousPath
    setAvenSessionCwd(undefined)
  }
})

after(() => rmSync(ROOT, { recursive: true, force: true }))
