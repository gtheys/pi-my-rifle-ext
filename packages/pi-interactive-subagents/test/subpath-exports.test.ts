// AIDEV-NOTE (PMR-8MQH): contract tests for the node-only subpath exports
// (`./usage`, `./assignments`) consumed by the pi-flow daemon
// (packages/pi-flow/server/daemon.ts). The daemon runs in its own process with
// NO pi extension runtime, so these two surfaces must stay importable from a
// plain node module graph. That property is what the import-guard below locks:
// the transitive closure of each entrypoint may only reach node built-ins, plus
// `@mariozechner/pi-coding-agent` via `pi-extension/subagents/dataroot.ts`
// (default-param `getAgentDir()` only — the same pre-existing acceptance as
// pi-flow's run-state.ts). If a future edit pulls `index.ts` (the heavy
// extension entry) or a TUI/typebox dependency into that closure, these tests
// fail before the daemon breaks in production.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

/** Subpath -> manifest target, the daemon-facing surface added by PMR-8MQH. */
const DAEMON_SUBPATHS: Record<string, string> = {
  './usage': './pi-extension/subagents/usage.ts',
  './assignments': './pi-extension/subagents/assignments.ts',
}

/**
 * The only non-builtin specifier the daemon graph may load, and the only file
 * allowed to load it. Everything else in the closure must be node built-ins or
 * a relative import inside this package.
 */
const ALLOWED_EXTERNAL = '@mariozechner/pi-coding-agent'
const ALLOWED_EXTERNAL_SOURCE = 'pi-extension/subagents/dataroot.ts'

/** Strip comments so prose in the file headers can never look like an import. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every module specifier a file pulls in (static, side-effect, and dynamic). */
function importSpecifiers(source: string): string[] {
  const code = withoutComments(source)
  const specifiers: string[] = []
  for (const pattern of [
    /from\s*['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    let match = pattern.exec(code)
    while (match) {
      specifiers.push(match[1])
      match = pattern.exec(code)
    }
  }
  return specifiers
}

/**
 * Transitive closure of relative imports starting at `entryRelPath`.
 * Returns every file visited together with the external specifiers it loads.
 */
function collectGraph(entryRelPath: string): {
  files: string[]
  externalByFile: Map<string, string[]>
} {
  const files = new Set<string>()
  const externalByFile = new Map<string, string[]>()
  const queue = [entryRelPath]
  while (queue.length) {
    const rel = queue.pop()
    if (rel === undefined) continue
    if (files.has(rel)) continue
    const abs = join(packageDir, rel)
    assert.ok(existsSync(abs), `expected exported file ${rel} to exist`)
    files.add(rel)
    const specifiers = importSpecifiers(readFileSync(abs, 'utf8'))
    const external: string[] = []
    for (const spec of specifiers) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        queue.push(resolve(dirname(abs), spec).slice(packageDir.length + 1))
        continue
      }
      if (spec.startsWith('node:')) continue
      external.push(spec)
    }
    externalByFile.set(rel, external)
  }
  return { files: [...files], externalByFile }
}

test('exports map exposes the node-only daemon subpaths', () => {
  for (const [subpath, target] of Object.entries(DAEMON_SUBPATHS)) {
    const entry = pkg.exports[subpath]
    assert.ok(entry, `expected an exports entry for ${subpath}`)
    assert.equal(entry.types, target)
    assert.equal(entry.default, target)
  }
})

test('exports map keeps the extension entrypoints untouched', () => {
  const indexTarget = './pi-extension/subagents/index.ts'
  for (const subpath of ['.', './subagents']) {
    assert.equal(pkg.exports[subpath].types, indexTarget)
    assert.equal(pkg.exports[subpath].default, indexTarget)
  }
})

test('daemon subpath targets are inside the files allowlist', () => {
  for (const target of Object.values(DAEMON_SUBPATHS)) {
    const relFromRoot = target.replace(/^\.\//, '')
    const covered = pkg.files.some(
      (dir: string) => relFromRoot === dir || relFromRoot.startsWith(`${dir}/`),
    )
    assert.ok(covered, `expected ${target} to be covered by files allowlist`)
  }
})

test('usage subpath graph is node built-ins only', () => {
  const { files, externalByFile } = collectGraph(
    DAEMON_SUBPATHS['./usage'].replace(/^\.\//, ''),
  )
  for (const [rel, external] of externalByFile) {
    assert.deepEqual(external, [], `${rel} must not import runtime packages`)
  }
  assert.ok(!files.includes('pi-extension/subagents/index.ts'))
})

test('assignments subpath graph only reaches pi-coding-agent via dataroot', () => {
  const { files, externalByFile } = collectGraph(
    DAEMON_SUBPATHS['./assignments'].replace(/^\.\//, ''),
  )
  for (const [rel, external] of externalByFile) {
    if (rel === ALLOWED_EXTERNAL_SOURCE) {
      assert.deepEqual(external, [ALLOWED_EXTERNAL])
      continue
    }
    assert.deepEqual(external, [], `${rel} must not import runtime packages`)
  }
  // Never import the root extension index from daemon-side code.
  assert.ok(!files.includes('pi-extension/subagents/index.ts'))
})

test('daemon subpaths resolve at runtime with the exported functions', async () => {
  const usage = await import('../pi-extension/subagents/usage.ts')
  assert.equal(typeof usage.createUsageSummary, 'function')
  assert.equal(typeof usage.summarizeEntriesUsage, 'function')
  const assignments = await import('../pi-extension/subagents/assignments.ts')
  assert.equal(typeof assignments.listAssignments, 'function')
})
