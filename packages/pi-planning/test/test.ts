import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolveFeaturePath, slugify } from '../plan-tools/helpers.ts'
import { openFileInPane } from '../plan-tools/open-in-pane.ts'

const GIT_TOPLEVEL = '/home/dev/Code/acme/widgets'

function fakePi(): ExtensionAPI {
  return {
    exec: async () => ({ stdout: `${GIT_TOPLEVEL}\n`, stderr: '' }),
  } as unknown as ExtensionAPI
}

test('slugify: lowercase, strip punctuation, max 5 words', () => {
  assert.equal(
    slugify('Merge /plan command with feature-planning flow!'),
    'merge-plan-command-with-feature-planning',
  )
})

test('resolveFeaturePath: $PERSONAL_FEATURES set → repo/date/slug dir under it', async () => {
  const prev = process.env.PERSONAL_FEATURES
  process.env.PERSONAL_FEATURES = '/home/dev/features'
  try {
    const path = await resolveFeaturePath(fakePi(), 'Merge command flow')
    const date = new Date().toISOString().slice(0, 10)
    assert.equal(
      path,
      `/home/dev/features/widgets/${date}-merge-command-flow/plan.md`,
    )
  } finally {
    if (prev === undefined) delete process.env.PERSONAL_FEATURES
    else process.env.PERSONAL_FEATURES = prev
  }
})

test('openFileInPane: send-text argv is shell-quoted for apostrophe paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-in-pane-'))
  const file = join(dir, "it's.md")
  writeFileSync(file, 'hello')

  const calls: Array<{ cmd: string; args: string[] }> = []
  const fakePi = {
    exec: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      if (args[0] === 'pane' && args[1] === 'split') {
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: 'pane-1' } },
          }),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    },
  } as unknown as ExtensionAPI

  const result = await openFileInPane(fakePi, file)
  assert.equal(result.details.ok, true)
  const sendText = calls.find((c) => c.args[1] === 'send-text')
  assert.ok(sendText)
  const escaped = file.replace(/'/g, "'\\''")
  assert.equal(sendText.args[3], `nvim '${escaped}'`)
})

test('resolveFeaturePath: $PERSONAL_FEATURES unset → .pi/plans under git toplevel', async () => {
  delete process.env.PERSONAL_FEATURES
  const path = await resolveFeaturePath(fakePi(), 'Add dark mode')
  const date = new Date().toISOString().slice(0, 10)
  assert.equal(path, `${GIT_TOPLEVEL}/.pi/plans/${date}-add-dark-mode/plan.md`)
})
