import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveMode } from '../index.ts'

const WORK_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-cwd-'))
// Session cwd differs from process.cwd() — the mismatch case.
const SESSION_CWD = path.join(WORK_ROOT, 'session-repo')
mkdirSync(path.join(SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [WORK_ROOT] }),
)

function stubPi(toplevel: string): ExtensionAPI {
  return {
    exec: async () => ({ stdout: `${toplevel}\n` }),
  } as unknown as ExtensionAPI
}

test('resolveMode: project override read from session cwd, not process.cwd()', async () => {
  const mode = await resolveMode(stubPi(SESSION_CWD), SESSION_CWD)
  assert.equal(mode, 'work')
})

test('resolveMode: default (no cwd) still works, reads process.cwd()', async () => {
  const outside = path.join(WORK_ROOT, 'outside')
  mkdirSync(outside, { recursive: true })
  const mode = await resolveMode(stubPi(outside), process.cwd())
  assert.equal(mode, 'personal')
})

test('resolveMode: toplevel outside session-cwd workRoots → personal', async () => {
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-else-'))
  const mode = await resolveMode(stubPi(elsewhere), SESSION_CWD)
  assert.equal(mode, 'personal')
  rmSync(elsewhere, { recursive: true, force: true })
})

after(() => {
  rmSync(WORK_ROOT, { recursive: true, force: true })
})
