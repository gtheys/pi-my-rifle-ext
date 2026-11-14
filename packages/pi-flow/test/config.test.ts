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
