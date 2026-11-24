import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfigFile } from '../index.ts'

test('readConfigFile: missing file → empty overrides', async () => {
  assert.deepEqual(await readConfigFile('/nonexistent/pi-flow.json'), {})
})

test('readConfigFile: malformed JSON → clear throw, no silent defaults', async () => {
  await assert.rejects(
    readConfigFile(
      new URL('./fixtures/broken.jsonfix', import.meta.url).pathname,
    ),
    /not valid JSON/,
  )
})

test('readConfigFile: wrong shape (workRoots not array) → clear throw', async () => {
  await assert.rejects(
    readConfigFile(
      new URL('./fixtures/wrong-shape.jsonfix', import.meta.url).pathname,
    ),
    /invalid/,
  )
})

test('readConfigFile: viewerPlacement accepted and read back (PMR-YD1P)', async () => {
  const cfg = await readConfigFile(
    new URL('./fixtures/viewer-placement.jsonfix', import.meta.url).pathname,
  )
  assert.equal(cfg.viewerPlacement, 'below')
})

test('readConfigFile: invalid viewerPlacement → clear throw mentioning the property', async () => {
  await assert.rejects(
    readConfigFile(
      new URL('./fixtures/viewer-placement-bad.jsonfix', import.meta.url)
        .pathname,
    ),
    /viewerPlacement/,
  )
})

test('readConfigFile: valid config parses', async () => {
  const cfg = await readConfigFile(
    new URL('./fixtures/valid.jsonfix', import.meta.url).pathname,
  )
  assert.deepEqual(cfg.workRoots, ['/home/geert/Code/salaryhero'])
})

// PMR-JP37 (3.3) — saveViewerPlacement persistence (best-effort, never clobbers)
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveViewerPlacement } from '../config.ts'
import { decidePlacement } from '../herdr/viewer.ts'

async function tmpAgentDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'pi-flow-save-'))
}

test('saveViewerPlacement: no existing config → creates dir + file, round-trips', async (t) => {
  const agentDir = await tmpAgentDir()
  t.after(async () => await rm(agentDir, { recursive: true, force: true }))
  const saved = await saveViewerPlacement(agentDir, 'below')
  assert.equal(saved, path.join(agentDir, 'pi-flow', 'config.json'))
  const cfg = await readConfigFile(saved)
  assert.equal(cfg.viewerPlacement, 'below')
})

test('saveViewerPlacement: existing config → other keys preserved', async (t) => {
  const agentDir = await tmpAgentDir()
  t.after(async () => await rm(agentDir, { recursive: true, force: true }))
  const file = path.join(agentDir, 'pi-flow', 'config.json')
  await mkdir(path.dirname(file), {
    recursive: true,
  })
  await writeFile(
    file,
    `${JSON.stringify(
      { workRoots: ['/work'], avenWorkspace: 'personal' },
      null,
      2,
    )}\n`,
  )
  await saveViewerPlacement(agentDir, 'left')
  const cfg = await readConfigFile(file)
  assert.deepEqual(cfg.workRoots, ['/work'])
  assert.equal(cfg.avenWorkspace, 'personal')
  assert.equal(cfg.viewerPlacement, 'left')
})

test('saveViewerPlacement: malformed existing config → throws, file untouched', async (t) => {
  const agentDir = await tmpAgentDir()
  t.after(async () => await rm(agentDir, { recursive: true, force: true }))
  const file = path.join(agentDir, 'pi-flow', 'config.json')
  const broken = '{"workRoots": "not-an-array"'
  await mkdir(path.dirname(file), {
    recursive: true,
  })
  await writeFile(file, broken)
  await assert.rejects(
    saveViewerPlacement(agentDir, 'tab'),
    /invalid|not valid JSON/,
  )
  assert.equal(await readFile(file, 'utf8'), broken)
})

test('saveViewerPlacement → readConfigFile → decidePlacement: second run no prompt (PMR-JP37)', async (t) => {
  const agentDir = await tmpAgentDir()
  t.after(async () => await rm(agentDir, { recursive: true, force: true }))
  await saveViewerPlacement(agentDir, 'above')
  const cfg = await readConfigFile(
    path.join(agentDir, 'pi-flow', 'config.json'),
  )
  const decision = decidePlacement(undefined, cfg.viewerPlacement)
  assert.deepEqual(decision, { kind: 'placement', placement: 'above' })
})

// AIDEV-NOTE: yolo plan 6.1 — config-level yolo default; --yolo flag wins via
// `parsed.yolo || config.yolo` wiring in the /flow handler (index.ts).
test('readConfigFile: yolo absent → undefined (wired as false default)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-yolo-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ workRoots: [] }))
  const cfg = await readConfigFile(file)
  assert.equal(cfg.yolo, undefined)
  // The /flow wiring `parsed.yolo || config.yolo` on an absent flag resolves
  // to `undefined`, which downstream only treats as true when === true.
  assert.equal(false || cfg.yolo === true, false)
})

test('readConfigFile: yolo accepted and read back', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-yolo-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ workRoots: [], yolo: true }))
  const cfg = await readConfigFile(file)
  assert.equal(cfg.yolo, true)
})

test('readConfigFile: malformed yolo value → clear throw mentioning the property', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-yolo-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify({ workRoots: [], yolo: 'yes' }))
  await assert.rejects(readConfigFile(file), /yolo/)
})

import { resolveReconcileSettings } from '../config.ts'
// AIDEV-NOTE: PMR-MSDJ (2.1) — the `reconcile` config surface. These tests pin
// the EXTENSION-side boundary (TypeBox `PiFlowConfigSchema` via readConfigFile:
// invalid shapes throw loudly). The daemon path is deliberately different —
// `flow/reconcile.ts` parseReconcileSettings reads the same file as raw text
// and fails to defaults with a warning, because the daemon must stay
// node-only. Both must agree on the defaults, pinned below.
import { parseReconcileSettings } from '../flow/reconcile.ts'

async function configWith(
  t: { after(fn: () => Promise<unknown>): void },
  obj: unknown,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-reconcile-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify(obj))
  return file
}

test('readConfigFile: reconcile block accepted and read back (PMR-MSDJ 2.1)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    reconcile: { enabled: false, intervalMinutes: 60 },
  })
  const cfg = await readConfigFile(file)
  assert.deepEqual(cfg.reconcile, { enabled: false, intervalMinutes: 60 })
})

test('readConfigFile: reconcile absent → resolveReconcileSettings surfaces defaults', async (t) => {
  const file = await configWith(t, { workRoots: [] })
  const cfg = await readConfigFile(file)
  assert.equal(cfg.reconcile, undefined)
  assert.deepEqual(resolveReconcileSettings(cfg), {
    enabled: true,
    intervalMinutes: 360,
  })
})

test('readConfigFile: reconcile partial block fills the other default', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    reconcile: { enabled: false },
  })
  const cfg = await readConfigFile(file)
  assert.deepEqual(resolveReconcileSettings(cfg), {
    enabled: false,
    intervalMinutes: 360,
  })
})

test('config defaults agree with parseReconcileSettings defaults (PMR-MSDJ 2.1)', () => {
  assert.deepEqual(resolveReconcileSettings({ workRoots: [] }), {
    enabled: true,
    intervalMinutes: 360,
  })
  assert.deepEqual(parseReconcileSettings(null), {
    enabled: true,
    intervalMinutes: 360,
  })
})

// Pin exactly what the schema enforces: TypeBox Integer + minimum 1 rejects
// 0, negatives and non-integers loudly on the extension side.
for (const bad of [0, -5, 6.5]) {
  test(`readConfigFile: reconcile.intervalMinutes ${bad} → clear throw`, async (t) => {
    const file = await configWith(t, {
      workRoots: [],
      reconcile: { intervalMinutes: bad },
    })
    await assert.rejects(readConfigFile(file), /intervalMinutes/)
  })
}

test('readConfigFile: reconcile.enabled non-boolean → clear throw', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    reconcile: { enabled: 'no' },
  })
  await assert.rejects(readConfigFile(file), /enabled/)
})

// BEHAVIOUR PIN, not an aspiration: TypeBox `Value.Check` does NOT enforce
// `additionalProperties` here (a top-level `bogus` key is accepted too), so a
// stray key inside `reconcile` passes the extension boundary unchanged and is
// simply ignored by both readers. The `"additionalProperties": false` in
// config.schema.json is editor-facing (it matches the existing telemetry /
// runServer blocks) — it is not what readConfigFile enforces.
test('readConfigFile: unknown key inside reconcile → tolerated and ignored (pinned actual behavior)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    reconcile: { intervalMinutes: 60, cron: '*/5 * * * *' },
  })
  const cfg = await readConfigFile(file)
  assert.deepEqual(resolveReconcileSettings(cfg), {
    enabled: true,
    intervalMinutes: 60,
  })
  assert.deepEqual(parseReconcileSettings(await readFile(file, 'utf8')), {
    enabled: true,
    intervalMinutes: 60,
  })
})
