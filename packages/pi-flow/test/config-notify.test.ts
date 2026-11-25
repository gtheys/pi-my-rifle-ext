// AIDEV-NOTE: PMR-ZV9Y (5.2) — the `notify` config surface. Deliberately a NEW
// file (the additive-test rule, the 4.2 config-loki.test.ts precedent):
// config.test.ts pins blocks individually and never asserts the whole default
// object, so it does not have to grow for notify. These tests cover the
// SESSION-SIDE SINGLE STRICT READER boundary (readConfigFile throws on a
// malformed notify block), resolveNotifySettings' ENABLED-BY-DEFAULT shape
// (the opt-out posture that distinguishes notify from telemetry.loki), the
// config.schema.json mirror with the pinned `enabled` default, and the README
// lockstep (the table row AND the full default-config JSON block).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Value } from 'typebox/value'
import { readConfigFile, resolveNotifySettings } from '../config.ts'

async function configWith(
  t: { after(fn: () => Promise<unknown>): void },
  obj: unknown,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-notify-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify(obj))
  return file
}

test('readConfigFile: notify block accepted and read back (PMR-ZV9Y 5.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    notify: { desktop: { enabled: false } },
  })
  const cfg = await readConfigFile(file)
  assert.deepEqual(cfg.notify, { desktop: { enabled: false } })
  assert.deepEqual(resolveNotifySettings(cfg), { desktop: { enabled: false } })
})

// THE DEFAULT IS TRUE (unlike telemetry.loki, which defaults false): desktop
// notifications are an opt-out channel, so an absent block must resolve
// enabled or a fresh install silently pages nobody on a waiting_human run.
test('readConfigFile: notify absent → resolveNotifySettings is ENABLED by default (PMR-ZV9Y 5.2)', async (t) => {
  const file = await configWith(t, { workRoots: [] })
  const cfg = await readConfigFile(file)
  assert.equal(cfg.notify, undefined)
  assert.deepEqual(resolveNotifySettings(cfg), { desktop: { enabled: true } })
})

test('readConfigFile: notify partial blocks fill the enabled default (PMR-ZV9Y 5.2)', async (t) => {
  for (const shape of [{ notify: {} }, { notify: { desktop: {} } }]) {
    const file = await configWith(t, { workRoots: [], ...shape })
    const cfg = await readConfigFile(file)
    assert.deepEqual(resolveNotifySettings(cfg), { desktop: { enabled: true } })
  }
})

test('resolveNotifySettings: explicit true and false both win over the default (PMR-ZV9Y 5.2)', () => {
  assert.deepEqual(
    resolveNotifySettings({
      workRoots: [],
      notify: { desktop: { enabled: true } },
    }),
    { desktop: { enabled: true } },
  )
  assert.deepEqual(
    resolveNotifySettings({
      workRoots: [],
      notify: { desktop: { enabled: false } },
    }),
    { desktop: { enabled: false } },
  )
})

test('readConfigFile: notify.desktop.enabled non-boolean → clear throw (PMR-ZV9Y 5.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    notify: { desktop: { enabled: 'yes' } },
  })
  await assert.rejects(readConfigFile(file), /enabled/)
})

test('readConfigFile: notify.desktop non-object → clear throw (PMR-ZV9Y 5.2)', async (t) => {
  const file = await configWith(t, { workRoots: [], notify: { desktop: true } })
  await assert.rejects(readConfigFile(file), /desktop/)
})

// The channel is a SESSION-SIDE reader only: the daemon has no notify path, so
// there is no tolerant twin to keep in sync (unlike reconcile/liveness). The
// session-side reader is exported from index.ts for the wiring tests.
test('notify settings ship through the strict extension reader only (PMR-ZV9Y 5.2)', () => {
  assert.deepEqual(resolveNotifySettings({}), { desktop: { enabled: true } })
})

// config.schema.json is the checked-in editor-facing mirror of
// PiFlowConfigSchema. It must describe the notify block with the pinned
// `enabled` default (true).
test('config.schema.json: notify section mirrors the schema (PMR-ZV9Y 5.2)', async () => {
  const raw = await readFile(
    new URL('../config.schema.json', import.meta.url),
    'utf8',
  )
  const schema = JSON.parse(raw) as {
    properties: Record<string, unknown>
  }
  const notify = schema.properties.notify as {
    type: string
    additionalProperties: boolean
    properties: Record<
      string,
      {
        type: string
        additionalProperties: boolean
        properties: Record<string, { type: string; default?: unknown }>
      }
    >
  }
  assert.equal(notify.type, 'object')
  assert.equal(notify.additionalProperties, false)
  assert.equal(notify.properties.desktop.type, 'object')
  assert.equal(notify.properties.desktop.additionalProperties, false)
  assert.equal(notify.properties.desktop.properties.enabled.type, 'boolean')
  assert.equal(notify.properties.desktop.properties.enabled.default, true)
})

test('config.schema.json: validates a documented notify example and rejects bad shapes (PMR-ZV9Y 5.2)', async () => {
  const raw = await readFile(
    new URL('../config.schema.json', import.meta.url),
    'utf8',
  )
  const schema = JSON.parse(raw)
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      notify: { desktop: { enabled: true } },
    }),
    true,
  )
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      notify: { desktop: { enabled: 'no' } },
    }),
    false,
  )
  assert.equal(
    Value.Check(schema as never, { workRoots: [], notify: { desktop: true } }),
    false,
  )
})

// README lockstep (AGENTS.md): the config table documents the dot-path key and
// the full default-config JSON block carries the COMPLETE default, including
// the notify block and $schema — never a partial example.
test('README documents notify.desktop.enabled in the table AND the full default JSON (PMR-ZV9Y 5.2)', async () => {
  const readme = await readFile(
    new URL('../README.md', import.meta.url),
    'utf8',
  )
  assert.ok(
    readme.includes('| `notify.desktop.enabled` |'),
    'the config table has the notify row',
  )
  const fence = readme.match(/```json\n(\{[\s\S]*?\n\})\n```/)
  if (fence === null) {
    throw new Error('the README has no default-config JSON block')
  }
  const example = JSON.parse(fence[1]) as Record<string, unknown>
  assert.equal(
    typeof example.$schema,
    'string',
    'the full default example keeps $schema',
  )
  assert.deepEqual(example.notify, { desktop: { enabled: true } })
})

test('README has a Notifications section documenting BOTH channels and their independent switches (PMR-ZV9Y 5.2)', async () => {
  const readme = await readFile(
    new URL('../README.md', import.meta.url),
    'utf8',
  )
  assert.ok(/^### Notifications$/m.test(readme), 'the section exists')
  const section = readme
    .split(/^### /m)
    .find((s) => s.startsWith('Notifications'))
  assert.ok(section !== undefined)
  assert.ok(
    section.includes('notify.desktop.enabled'),
    'the desktop switch is named',
  )
  assert.ok(
    /Grafana/i.test(section) && /pause|mute/i.test(section),
    'the Grafana channel + its own off-switch are documented (D3)',
  )
  assert.ok(
    section.includes('waiting_human') && section.includes('halted'),
    'the two paging states are documented',
  )
})
