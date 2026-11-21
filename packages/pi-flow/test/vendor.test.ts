import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  loadHpRenderer,
  loadHpRendererFrom,
} from '../flow-diagram/vendor/harness-profiler/load.ts'

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

// AIDEV-NOTE: view.html is a sanctioned minimal fork of upstream v0.2.2 (adds
// the flow header band + /*FLOW_HEADER*/null slot, PMR-57HF). Unlike hp.js,
// this pin does NOT mean byte-identical to upstream — it pins the forked
// bytes. Any view.html change must go through a re-fork: document the diff in
// PIN.md's "view.html fork" section and update this constant + the PIN.md row
// together. hp.js stays byte-identical to upstream (pin above, untouched).
const PINNED_VIEW_HTML_SHA256 =
  '48eafbe04887d8d5275730b73511a16bb4b9e20b6897d2352eb43f42faa9ffeb'

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

test('vendored hp.js matches pinned sha256', () => {
  assert.equal(sha256(join(VENDOR_DIR, 'hp.js')), PINNED_HP_JS_SHA256)
})

test('vendored view.html matches pinned (forked) sha256', () => {
  assert.equal(sha256(join(VENDOR_DIR, 'view.html')), PINNED_VIEW_HTML_SHA256)
})

// AIDEV-NOTE (PMR-BRSV): the pr row must keep its http(s) scheme allowlist —
// a re-vendor that re-applies the fork without it fails here even when the
// checksum pins above were re-pinned over the regression.
test('view.html pr row only links http(s) urls', () => {
  const html = readFileSync(join(VENDOR_DIR, 'view.html'), 'utf8')
  assert.match(html, /\^https\?:\\\//)
  assert.match(html, /plain text so it can never execute/)
})

test('vendored LICENSE is the MIT license', () => {
  const license = readFileSync(join(VENDOR_DIR, 'LICENSE'), 'utf8')
  assert.ok(license.includes('MIT'))
})

// AIDEV-NOTE: renderHtml reads view.html from hp.js's own directory, so a
// successful render with </html> proves the vendored template shipped too.
test('loadHpRenderer renders html from vendored assets', () => {
  const renderer = loadHpRenderer()
  assert.ok(renderer, 'loadHpRenderer() should return a renderer, not null')
  const html = renderer.renderHtml({ id: 'smoke', records: [] })
  assert.ok(html.includes('</html>'))
})

test('loadHpRendererFrom returns null with warning on missing dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-flow-hp-missing-'))
  rmSync(dir, { recursive: true })
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message: string) => {
    warnings.push(message)
  }
  try {
    const renderer = loadHpRendererFrom(dir)
    assert.equal(renderer, null)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warnings.length, 1)
  const warning = warnings[0]
  assert.ok(warning, 'expected a load-failure warning')
  assert.match(
    warning,
    /\[pi-flow\] flow-diagram: vendored harness-profiler renderer failed to load: /,
  )
})

test('loadHpRendererFrom returns null when hp.js is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-flow-hp-empty-'))
  writeFileSync(join(dir, 'view.html'), '<html></html>')
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message: string) => {
    warnings.push(message)
  }
  try {
    const renderer = loadHpRendererFrom(dir)
    assert.equal(renderer, null)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(warnings.length, 1)
  rmSync(dir, { recursive: true })
})
