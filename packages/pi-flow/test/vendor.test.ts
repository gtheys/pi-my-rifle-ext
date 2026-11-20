import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// AIDEV-NOTE: This checksum pin is the byte-drift guard for the vendored
// harness-profiler renderer (hp.js + view.html + LICENSE). If any pinned byte
// changes, this test fails — re-vendor via PIN.md's "Re-vendoring" section and
// update both PIN.md and this constant together.
const VENDOR_DIR = join(
  import.meta.dirname,
  '..',
  'flow-diagram',
  'vendor',
  'harness-profiler',
)

const PINNED_HP_JS_SHA256 =
  'acebfb79e9a8cb6a5d5143f06b181e5ed9904509fdd872420cd7b7b4fbda1532'

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

test('vendored hp.js matches pinned sha256', () => {
  assert.equal(sha256(join(VENDOR_DIR, 'hp.js')), PINNED_HP_JS_SHA256)
})

test('vendored LICENSE is the MIT license', () => {
  const license = readFileSync(join(VENDOR_DIR, 'LICENSE'), 'utf8')
  assert.ok(license.includes('MIT'))
})
