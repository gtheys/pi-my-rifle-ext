// AIDEV-NOTE (PMR-8MQH 1.2): textual guard for the flow/cost-rows.ts module
// contract. The pi-flow daemon (server/daemon.ts) runs in its own process with
// NO pi extension runtime, so the cost rollup and the Pushgateway body builder
// must stay reachable from a plain node module graph. flow/cost-rows.ts is the
// extracted node-only half; this test locks its import list so a future edit
// that pulls the package root (or any pi/TUI runtime) back into it fails here
// instead of breaking the daemon in production. Same shape as the sibling
// contract test: packages/pi-interactive-subagents/test/subpath-exports.test.ts.
//
// Comments are STRIPPED before scanning — the module header deliberately names
// forbidden specifiers while explaining the contract, and prose must never be
// mistaken for an import.
//
// TWO GUARDS, ONE FILE:
//  1. cost-rows.ts's OWN import statements stay inside the node-only allowlist
//     (fast textual check — catches a direct violation).
//  2. the RUNTIME TRANSITIVE CLOSURE of cost-rows.ts never reaches the
//     session-side modules flow/cost.ts / flow/cost-command.ts or the
//     pi-interactive-subagents package ROOT. PMR-8MQH 1.2 hit exactly this:
//     run-health.ts imported labelString from './cost.ts' (which value-imports
//     the root), so a module satisfying guard 1 was still daemon-unreachable.
//     Guard 2 walks relative edges through the real graph and fails on that
//     class of regression. Type-only imports/exports are erased at runtime and
//     are skipped by the walk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = join(packageDir, 'flow', 'cost-rows.ts')

/** Everything flow/cost-rows.ts is allowed to import. */
const ALLOWED = [
  '../run-state.ts',
  './agent-role.ts',
  './run-health.ts',
  './push.ts',
  './reconcile-deps.ts',
  '@gtheys/pi-interactive-subagents/usage',
  '@gtheys/pi-interactive-subagents/assignments',
]

function isAllowed(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  return ALLOWED.includes(specifier)
}

/** Strip comments so header prose can never look like an import. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every module specifier the file pulls in (static, side-effect, dynamic). */
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

test('cost-rows.ts imports stay inside the node-only allowlist', () => {
  const specifiers = importSpecifiers(readFileSync(modulePath, 'utf8'))
  assert.ok(specifiers.length > 0, 'expected the scanner to find imports')
  for (const specifier of specifiers) {
    assert.ok(
      isAllowed(specifier),
      `flow/cost-rows.ts must not import ${specifier}; allowed: node:*, ${ALLOWED.join(', ')}`,
    )
  }
})

test('the guard itself rejects the package root and the pi runtime', () => {
  // Locks the predicate: if these ever became allowed the guard is worthless.
  assert.ok(!isAllowed('@gtheys/pi-interactive-subagents'))
  assert.ok(!isAllowed('@earendil-works/pi-coding-agent'))
  assert.ok(!isAllowed('./cost.ts'))
  assert.ok(isAllowed('@gtheys/pi-interactive-subagents/usage'))
  assert.ok(isAllowed('node:fs'))
})

test('cost.ts keeps re-exporting the moved rollup so importers are unchanged', () => {
  const source = withoutComments(
    readFileSync(join(packageDir, 'flow', 'cost.ts'), 'utf8'),
  )
  const block = /export\s*\{([^}]*)\}\s*from\s*'\.\/cost-rows\.ts'/g.exec(
    source,
  )
  assert.ok(block, "expected cost.ts to re-export from './cost-rows.ts'")
  const exported = block[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .filter((entry) => entry.length > 0)
  for (const name of [
    'buildPushBody',
    'buildWorkerRows',
    'buildMainRows',
    'collectSpawnNotes',
    'parseSessionEntries',
    'phaseWindows',
    'labelString',
    'WorkerRow',
  ]) {
    assert.ok(exported.includes(name), `expected cost.ts to re-export ${name}`)
  }
})

/** Runtime (non-type-only) import specifiers of a source file. */
function runtimeImportSpecifiers(source: string): string[] {
  const code = withoutComments(source)
  // Drop `import type ... from '...'` / `export type ... from '...'` statements:
  // erased at runtime, so their targets cannot load anything.
  const runtimeOnly = code.replace(
    /(^|\n)\s*(?:import|export)\s+type\s+[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
    '\n',
  )
  return importSpecifiers(runtimeOnly)
}

const FORBIDDEN_CLOSURE_FILES = ['flow/cost.ts', 'flow/cost-command.ts']
const FORBIDDEN_CLOSURE_PACKAGES = ['@gtheys/pi-interactive-subagents']

test('cost-rows.ts runtime closure never reaches the session-side cost modules or the package root', () => {
  const visited = new Set<string>()
  const queue = [modulePath]
  const violations: string[] = []
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue // unresolvable edge: nothing to load at runtime either
    }
    const rel = file.slice(packageDir.length + 1)
    for (const specifier of runtimeImportSpecifiers(source)) {
      for (const forbidden of FORBIDDEN_CLOSURE_FILES) {
        if (
          specifier.startsWith('.') &&
          resolve(dirname(file), specifier) === join(packageDir, forbidden)
        ) {
          violations.push(`${rel} imports ${forbidden}`)
        }
      }
      if (FORBIDDEN_CLOSURE_PACKAGES.includes(specifier)) {
        violations.push(
          `${rel} imports the forbidden package root ${specifier}`,
        )
      }
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier))
      }
    }
  }
  assert.ok(
    visited.size > 1,
    'expected the walk to traverse beyond cost-rows.ts itself',
  )
  assert.deepEqual(violations, [])
})
