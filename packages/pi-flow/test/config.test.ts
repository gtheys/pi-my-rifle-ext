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

test('readConfigFile: valid config parses', async () => {
  const cfg = await readConfigFile(
    new URL('./fixtures/valid.jsonfix', import.meta.url).pathname,
  )
  assert.deepEqual(cfg.workRoots, ['/home/geert/Code/salaryhero'])
})
