// AIDEV-NOTE: PMR-R0JD — open_in_pane polls briefly for the file so a write
// racing the open does not report "File not found".
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { openFileInPane } from '../spec-review/open-in-pane.ts'

function fakePi(): ExtensionAPI {
  return {
    exec: async (_cmd: string, args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'split') {
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: 'p1' } } }),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    },
  } as unknown as ExtensionAPI
}

test('openFileInPane: file appearing after a short delay opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-retry-'))
  const file = join(dir, 'plan.md')
  setTimeout(() => writeFileSync(file, 'x'), 150)
  const result = await openFileInPane(fakePi(), file, 'nvim', {
    attempts: 10,
    delayMs: 50,
  })
  assert.equal(result.details.ok, true)
})

test('openFileInPane: file never appearing returns not found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-retry-'))
  const file = join(dir, 'missing.md')
  const result = await openFileInPane(fakePi(), file, 'nvim', {
    attempts: 3,
    delayMs: 10,
  })
  assert.equal(result.details.ok, false)
  assert.match(result.content[0].text, /^File not found: /)
})

test('openFileInPane: existing file does not wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-retry-'))
  const file = join(dir, 'plan.md')
  writeFileSync(file, 'x')
  const start = Date.now()
  const result = await openFileInPane(fakePi(), file, 'nvim', {
    attempts: 5,
    delayMs: 1000,
  })
  assert.equal(result.details.ok, true)
  assert.ok(Date.now() - start < 500)
})
