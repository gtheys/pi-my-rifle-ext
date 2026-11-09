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

function recordingPi(
  respond: (args: string[]) => { stdout: string; stderr: string } | undefined,
): { pi: ExtensionAPI; calls: string[][] } {
  const calls: string[][] = []
  const pi = {
    exec: async (_cmd: string, args: string[]) => {
      calls.push(args)
      return respond(args) ?? { stdout: '', stderr: '' }
    },
  } as unknown as ExtensionAPI
  return { pi, calls }
}

function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key]
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('openFileInPane: subagent context opens a durable spec-review tab, not a split', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-subagent-'))
  const file = join(dir, 'plan.md')
  writeFileSync(file, 'x')
  const { pi, calls } = recordingPi((args) => {
    if (args[0] === 'tab' && args[1] === 'create') {
      return {
        stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w9:q1' } } }),
        stderr: '',
      }
    }
    return undefined
  })
  await withEnv(
    { PI_SUBAGENT_ID: 'test-sub', HERDR_WORKSPACE_ID: 'w9' },
    async () => {
      const result = await openFileInPane(pi, file, 'nvim')
      assert.equal(result.details.ok, true)
      assert.equal(result.details.paneId, 'w9:q1')
      assert.match(result.content[0].text, /^Opened .* in pane w9:q1$/)
    },
  )
  assert.ok(
    !calls.some((a) => a[0] === 'pane' && a[1] === 'split'),
    'must not split the ephemeral subagent pane',
  )
  const create = calls.find((a) => a[0] === 'tab' && a[1] === 'create')
  assert.ok(create, 'tab create called')
  assert.equal(create[create.indexOf('--workspace') + 1], 'w9')
  assert.equal(create[create.indexOf('--label') + 1], 'spec-review')
  assert.equal(create[create.indexOf('--cwd') + 1], dir)
  assert.ok(create.includes('--no-focus'))
  const sendText = calls.find((a) => a[0] === 'pane' && a[1] === 'send-text')
  assert.ok(sendText?.includes('w9:q1'), 'send-text targets the tab root pane')
  assert.ok(
    sendText?.some((a) => a.includes('nvim')),
    'send-text launches nvim on the file',
  )
})

test('openFileInPane: no subagent env keeps the pane split path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-nosub-'))
  const file = join(dir, 'plan.md')
  writeFileSync(file, 'x')
  const { pi, calls } = recordingPi((args) => {
    if (args[0] === 'pane' && args[1] === 'split') {
      return {
        stdout: JSON.stringify({ result: { pane: { pane_id: 'p1' } } }),
        stderr: '',
      }
    }
    return undefined
  })
  await withEnv(
    { PI_SUBAGENT_ID: undefined, HERDR_WORKSPACE_ID: 'w9' },
    async () => {
      const result = await openFileInPane(pi, file, 'nvim')
      assert.equal(result.details.ok, true)
    },
  )
  assert.equal(calls[0]?.[0], 'pane', 'first call is a pane command')
  assert.equal(calls[0]?.[1], 'split', 'main session splits the current pane')
  assert.ok(!calls.some((a) => a[0] === 'tab'))
})

test('openFileInPane: subagent env without workspace falls back to split', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oip-nows-'))
  const file = join(dir, 'plan.md')
  writeFileSync(file, 'x')
  const { pi, calls } = recordingPi((args) => {
    if (args[0] === 'pane' && args[1] === 'split') {
      return {
        stdout: JSON.stringify({ result: { pane: { pane_id: 'p1' } } }),
        stderr: '',
      }
    }
    return undefined
  })
  await withEnv(
    { PI_SUBAGENT_ID: 'test-sub', HERDR_WORKSPACE_ID: undefined },
    async () => {
      const result = await openFileInPane(pi, file, 'nvim')
      assert.equal(result.details.ok, true)
    },
  )
  assert.equal(calls[0]?.[1], 'split', 'no workspace id: legacy split path')
})
