import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mkTmpDir } from './tmpdir.ts'

test('mkTmpDir creates an existing dir under os.tmpdir() with the given prefix', () => {
  const dir = mkTmpDir('pi-flow-tmpdir-helper-')
  assert.ok(existsSync(dir), `expected ${dir} to exist`)
  const parent = path.dirname(dir)
  assert.equal(parent, os.tmpdir())
  assert.ok(path.basename(dir).startsWith('pi-flow-tmpdir-helper-'))
})

test('mkTmpDir returns a unique dir on each call', () => {
  const a = mkTmpDir('pi-flow-tmpdir-helper-')
  const b = mkTmpDir('pi-flow-tmpdir-helper-')
  assert.notEqual(a, b)
  assert.ok(existsSync(a))
  assert.ok(existsSync(b))
  // AIDEV-NOTE: belt-and-braces uniqueness check against the real tmpdir
  // listing — mkdtempSync must never hand back an existing sibling name.
  const siblings = readdirSync(os.tmpdir()).filter((name) =>
    name.startsWith('pi-flow-tmpdir-helper-'),
  )
  assert.ok(siblings.length >= 2)
})
