import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// AIDEV-NOTE: Narrow structural surface of the vendored harness-profiler
// renderer we actually consume. Do not widen without need.
export interface HpRenderer {
  renderHtml(session: { id: string; records: readonly unknown[] }): string
}

// AIDEV-NOTE: `hp.js` is byte-pinned (sha256 in test/vendor.test.ts) and must
// never be edited — it is a vendored CJS copy. We execute it via a manual CJS
// wrapper instead of createRequire because the package is `"type": "module"`
// and Node would otherwise parse the vendored `.js` file as ESM, breaking its
// internal `require('fs')` calls (Node 22+ require(esm)). view.html must sit
// next to hp.js (renderHtml reads it from the injected __dirname). Any change
// goes through the re-vendoring steps in PIN.md.
const HP_JS_FILENAME = 'hp.js'

function loadHpFile(hpPath: string, dir: string): HpRenderer {
  const raw = readFileSync(hpPath, 'utf8')
  let source = raw
  if (raw.startsWith('#!')) {
    source = raw.slice(raw.indexOf('\n') + 1)
  }
  const require = createRequire(import.meta.url)
  const module = { exports: {} as Record<string, unknown> }
  const compiled = new Function(
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    source,
  )
  compiled(require, module, module.exports, dir, hpPath)
  const hp = module.exports
  if (
    typeof hp !== 'object' ||
    hp === null ||
    typeof hp.renderHtml !== 'function'
  ) {
    throw new Error('hp.js did not export a renderHtml function')
  }
  const render = hp.renderHtml as HpRenderer['renderHtml']
  return { renderHtml: render }
}

export function loadHpRendererFrom(dir: string): HpRenderer | null {
  try {
    return loadHpFile(join(dir, HP_JS_FILENAME), dir)
  } catch (error) {
    console.warn(
      `[pi-flow] flow-diagram: vendored harness-profiler renderer failed to load: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

export function loadHpRenderer(): HpRenderer | null {
  return loadHpRendererFrom(import.meta.dirname)
}
