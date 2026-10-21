import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { preflightRepo, syncHerdrPlugin, tomlString } from '../herdr/sync.ts'

// --- tomlString ---

test('tomlString: reads quoted values, ignores comments', () => {
  assert.equal(
    tomlString('id = "gtheys.pi-my-rifle-ext"', 'id'),
    'gtheys.pi-my-rifle-ext',
  )
  assert.equal(tomlString('version = "0.1.0" # comment', 'version'), '0.1.0')
  assert.equal(tomlString('missing = true', 'id'), undefined)
})

// --- preflightRepo against a fixture repo ---

async function makeFixtureRepo(
  overrides: {
    manifest?: string
    packageVersion?: string
    omitViewer?: boolean
  } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pmr-herdr-'))
  const packageVersion = overrides.packageVersion ?? '0.1.0'
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'pi-my-rifle-ext', version: packageVersion }),
  )
  const manifest =
    overrides.manifest ??
    [
      'id = "gtheys.pi-my-rifle-ext"',
      'name = "pi-my-rifle-ext"',
      `version = "${packageVersion}"`,
      'min_herdr_version = "0.7.0"',
      'platforms = ["linux", "macos"]',
      '',
      '[[panes]]',
      'id = "flow"',
      'title = "flow"',
      'placement = "split"',
      'command = ["node", "plugins/herdr/flow-viewer.mjs"]',
    ].join('\n')
  await fs.writeFile(path.join(root, 'herdr-plugin.toml'), manifest)
  if (overrides.omitViewer !== true) {
    await fs.mkdir(path.join(root, 'plugins', 'herdr'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'plugins', 'herdr', 'flow-viewer.mjs'),
      '#!/usr/bin/env node\n',
    )
  }
  return root
}

test('preflightRepo: valid fixture passes and returns version', async () => {
  const root = await makeFixtureRepo()
  const result = await preflightRepo(root)
  assert.equal(result.version, '0.1.0')
  await fs.rm(root, { recursive: true, force: true })
})

test('preflightRepo: version mismatch throws', async () => {
  const root = await makeFixtureRepo({ packageVersion: '0.2.0' })
  // The fixture manifest defaults to the overridden package version, so pin
  // the manifest to the OLD version to force a real mismatch.
  await fs.writeFile(
    path.join(root, 'herdr-plugin.toml'),
    [
      'id = "gtheys.pi-my-rifle-ext"',
      'version = "0.1.0"',
      'platforms = ["linux"]',
      'command = ["node", "plugins/herdr/flow-viewer.mjs"]',
    ].join('\n'),
  )
  await assert.rejects(
    () => preflightRepo(root),
    /does not match package version/,
  )
  await fs.rm(root, { recursive: true, force: true })
})

test('preflightRepo: wrong plugin id throws', async () => {
  const root = await makeFixtureRepo({
    manifest: [
      'id = "someone.else"',
      'version = "0.1.0"',
      'platforms = ["linux"]',
      'command = ["node", "plugins/herdr/flow-viewer.mjs"]',
    ].join('\n'),
  })
  await assert.rejects(() => preflightRepo(root), /id must be/)
  await fs.rm(root, { recursive: true, force: true })
})

test('preflightRepo: missing viewer throws', async () => {
  const root = await makeFixtureRepo({ omitViewer: true })
  await assert.rejects(() => preflightRepo(root), /missing from the repo root/)
  await fs.rm(root, { recursive: true, force: true })
})

// --- syncHerdrPlugin with fake spawn ---

type FakeCall = { command: string; args: string[] }

function fakeSpawn(
  responses: (args: string[]) => {
    error?: Error
    status?: number
    stdout: string
    stderr?: string
  },
) {
  const calls: FakeCall[] = []
  const spawn = (command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] })
    const r = responses([...args])
    return {
      pid: 0,
      output: [],
      signal: null,
      error: r.error ?? undefined,
      status: r.status ?? 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    } satisfies import('node:child_process').SpawnSyncReturns<string>
  }
  return { spawn, calls }
}

const PLUGIN_JSON = (root: string, version: string, enabled = true) =>
  JSON.stringify({
    result: {
      plugins: [
        {
          plugin_id: 'gtheys.pi-my-rifle-ext',
          plugin_root: root,
          version,
          enabled,
        },
      ],
    },
  })

test('syncHerdrPlugin: unavailable when herdr is missing (ENOENT)', async () => {
  const root = await makeFixtureRepo()
  const { spawn } = fakeSpawn(() => ({
    error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    stdout: '',
  }))
  const result = await syncHerdrPlugin(root, spawn)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.changed, false)
  await fs.rm(root, { recursive: true, force: true })
})

test('syncHerdrPlugin: links when no registration exists', async () => {
  const root = await makeFixtureRepo()
  let listed = false
  const { spawn, calls } = fakeSpawn((args) => {
    if (args[0] === 'plugin' && args[1] === 'list') {
      if (!listed) {
        listed = true
        return { stdout: JSON.stringify({ result: { plugins: [] } }) }
      }
      return { stdout: PLUGIN_JSON(root, '0.1.0', true) }
    }
    return { stdout: '{}' }
  })
  const result = await syncHerdrPlugin(root, spawn)
  assert.equal(result.status, 'linked')
  assert.equal(result.changed, true)
  const link = calls.find((c) => c.args[1] === 'link')
  assert.ok(link)
  assert.deepEqual(link.args.slice(2), [root])
  await fs.rm(root, { recursive: true, force: true })
})

test('syncHerdrPlugin: unchanged when current registration matches', async () => {
  const root = await makeFixtureRepo()
  const { spawn, calls } = fakeSpawn(() => ({
    stdout: PLUGIN_JSON(root, '0.1.0', true),
  }))
  const result = await syncHerdrPlugin(root, spawn)
  assert.equal(result.status, 'unchanged')
  assert.equal(calls.filter((c) => c.args[1] === 'link').length, 0)
  await fs.rm(root, { recursive: true, force: true })
})

test('syncHerdrPlugin: enables a matching disabled registration', async () => {
  const root = await makeFixtureRepo()
  let enabled = false
  const { spawn, calls } = fakeSpawn((args) => {
    if (args[0] === 'plugin' && args[1] === 'list') {
      return { stdout: PLUGIN_JSON(root, '0.1.0', enabled) }
    }
    if (args[0] === 'plugin' && args[1] === 'enable') {
      enabled = true
      return { stdout: '{}' }
    }
    return { stdout: '{}' }
  })
  const result = await syncHerdrPlugin(root, spawn)
  assert.equal(result.status, 'enabled')
  assert.ok(calls.find((c) => c.args[1] === 'enable'))
  await fs.rm(root, { recursive: true, force: true })
})

test('syncHerdrPlugin: stale registration is unlinked then relinked', async () => {
  const root = await makeFixtureRepo()
  const OTHER = '/other/location'
  let currentRoot = OTHER
  const { spawn, calls } = fakeSpawn((args) => {
    if (args[0] === 'plugin' && args[1] === 'list') {
      return { stdout: PLUGIN_JSON(currentRoot, '0.1.0', true) }
    }
    if (args[0] === 'plugin' && args[1] === 'unlink') {
      currentRoot = '__none__'
      return { stdout: '{}' }
    }
    if (args[0] === 'plugin' && args[1] === 'link') {
      currentRoot = args[2] ?? root
      return { stdout: '{}' }
    }
    return { stdout: '{}' }
  })
  const result = await syncHerdrPlugin(root, spawn)
  assert.equal(result.status, 'relinked')
  assert.ok(calls.find((c) => c.args[1] === 'unlink'))
  await fs.rm(root, { recursive: true, force: true })
})

test('syncHerdrPlugin: herdr list failure surfaces bounded error', async () => {
  const root = await makeFixtureRepo()
  const { spawn } = fakeSpawn(() => ({ status: 1, stdout: '', stderr: 'boom' }))
  await assert.rejects(() => syncHerdrPlugin(root, spawn), /boom/)
  await fs.rm(root, { recursive: true, force: true })
})
