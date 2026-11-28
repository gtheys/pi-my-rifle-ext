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

// AIDEV-NOTE (PMR-ZV9Y 3.2): the closure roots, not just cost-rows.ts. The v2
// metric math (flow/state-metrics.ts) renders INSIDE buildPushBody — the daemon
// liveness pass re-pushes run-health bodies, so the derivation must be
// daemon-reachable — and run-health.ts now imports it. Locking only
// cost-rows.ts's own specifiers would miss a pi-runtime import added one hop
// deeper, so each root below gets its own direct allowlist check, and the
// multi-root walk at the bottom of this file keeps that coverage even if the
// cost-rows → run-health edge is ever removed.
const CLOSURE_ROOTS = [
  'flow/cost-rows.ts',
  'flow/run-health.ts',
  'flow/state-metrics.ts',
  // fix-round-3 (deviation #3): state-metrics.ts now value-imports
  // isRegisteredStep from steps.ts, so steps.ts is genuinely in the push-chain
  // closure. Register it as its own root so the per-root textual allowlist
  // (ROOT_ALLOWLISTS['flow/steps.ts'] = ['./orchestrate.ts'], type-only) guards
  // the LAST daemon-safe hop — an unmapped pi/session runtime import added to
  // steps.ts fails here, not in production. The transitive walk below strips
  // the type-only './orchestrate.ts' so orchestrate.ts is never loaded.
  'flow/steps.ts',
]

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

// AIDEV-NOTE (PMR-ZV9Y 3.2): per-root node-only allowlists for the two modules
// the v2 render added to the push chain. An edge to the pi runtime, the
// package root, `flow/cost.ts`, `flow/loop.ts` or any other session-side
// module fails here instead of crashing the daemon in production.
//
// AIDEV-NOTE (PMR-ZV9Y fix-round-3, deviation #3): `flow/steps.ts` is NOT
// session-side — the earlier comment listing it alongside loop.ts was wrong.
// steps.ts is pure data (`STEP_REGISTRY` const map + `isRegisteredStep`
// predicate, no I/O, no pi runtime); its only import is `import type { Phase }
// from './orchestrate.ts'`, which is TYPE-ONLY and erased at runtime, so the
// transitive CLOSURE walk (runtimeImportSpecifiers) strips it and the daemon
// never loads orchestrate.ts. state-metrics.ts now VALUE-imports
// `isRegisteredStep` from './steps.ts' to registry-close the `step` label
// surface (plan.md:37), so './steps.ts' joins its direct allowlist and
// 'flow/steps.ts' is registered as its own root with the type-only
// './orchestrate.ts' edge allowlisted there. The mutation guard below proves
// this still bites: a RUNTIME (non-type-only) `import { getAgentDir } from
// '@earendil-works/pi-coding-agent'` added to steps.ts trips the direct
// textual check (it is not in ROOT_ALLOWLISTS['flow/steps.ts']).
const ROOT_ALLOWLISTS: Record<string, readonly string[]> = {
  'flow/cost-rows.ts': ALLOWED,
  'flow/run-health.ts': [
    '../run-state.ts',
    './cost-rows.ts',
    './state-metrics.ts',
  ],
  // state-metrics.ts is deliberately NARROWER than its importers: types +
  // projectRunState, the closed-enum vocabulary, labelString, and (fix-round-3)
  // the registry predicate isRegisteredStep. Not './run-health.ts' (would
  // deepen the cycle for no gain) and not any session-side module.
  'flow/state-metrics.ts': [
    '../run-state.ts',
    './cost-rows.ts',
    './vocabulary.ts',
    './steps.ts',
  ],
  // steps.ts is pure data. Its ONE import is the type-only Phase from
  // './orchestrate.ts' (erased at runtime — see the AIDEV note above), so the
  // daemon never transitively loads orchestrate.ts; the transitive walk enforces
  // that, and this entry is exactly what a RUNTIME import there could not hide
  // behind. Nothing else is allowlisted: any other edge fails the per-root
  // check.
  'flow/steps.ts': ['./orchestrate.ts'],
}

function isAllowedIn(specifier: string, root: string): boolean {
  if (specifier.startsWith('node:')) return true
  const allowed = ROOT_ALLOWLISTS[root]
  if (allowed === undefined) {
    throw new Error(`no allowlist for closure root ${root}`)
  }
  return allowed.includes(specifier)
}

for (const root of CLOSURE_ROOTS) {
  test(`${root} imports stay inside its node-only allowlist`, () => {
    const specifiers = importSpecifiers(
      readFileSync(join(packageDir, root), 'utf8'),
    )
    assert.ok(specifiers.length > 0, 'expected the scanner to find imports')
    for (const specifier of specifiers) {
      assert.ok(
        isAllowedIn(specifier, root),
        `${root} must not import ${specifier}; allowed: node:*, ${ROOT_ALLOWLISTS[root].join(', ')}`,
      )
    }
  })
}

test('the v2 closure guards reject the pi runtime and the session-side graph', () => {
  // Locks the per-root predicates the same way the cost-rows predicate above
  // is locked: if these ever became allowed, the guard is worthless.
  for (const root of CLOSURE_ROOTS) {
    assert.ok(!isAllowedIn('@gtheys/pi-interactive-subagents', root))
    assert.ok(!isAllowedIn('@earendil-works/pi-coding-agent', root))
    assert.ok(!isAllowedIn('../index.ts', root))
    assert.ok(!isAllowedIn('../config.ts', root))
    assert.ok(!isAllowedIn('./cost.ts', root))
    assert.ok(!isAllowedIn('./cost-command.ts', root))
    assert.ok(!isAllowedIn('./loop.ts', root))
  }
  assert.ok(isAllowedIn('./state-metrics.ts', 'flow/run-health.ts'))
  assert.ok(isAllowedIn('./vocabulary.ts', 'flow/state-metrics.ts'))
  assert.ok(isAllowedIn('node:fs', 'flow/cost-rows.ts'))
  // fix-round-3 (deviation #3): steps.ts is a push-chain root and its only
  // allowed edge is the TYPE-ONLY './orchestrate.ts' (erased at runtime, so the
  // transitive closure never loads orchestrate.ts). A RUNTIME pi/session import
  // added to steps.ts is NOT allowlisted there -> the per-root textual check
  // bites (the mutation this round runs by hand: inject
  // `import { getAgentDir } from '@earendil-works/pi-coding-agent'` into
  // steps.ts -> `flow/steps.ts imports stay inside its node-only allowlist`
  // goes red -> revert).
  assert.ok(isAllowedIn('./orchestrate.ts', 'flow/steps.ts'))
  assert.ok(!isAllowedIn('@earendil-works/pi-coding-agent', 'flow/steps.ts'))
  assert.ok(!isAllowedIn('./loop.ts', 'flow/steps.ts'))
  // PMR-FJ99: the comments above claim steps.ts's './orchestrate.ts' edge is
  // TYPE-ONLY and so is stripped from the runtime transitive closure — i.e. the
  // daemon never loads orchestrate.ts. Prove that claim directly instead of
  // relying on the walk to imply it: with only a type-only import, steps.ts has
  // ZERO runtime import specifiers, so it contributes no edge to the closure.
  assert.deepEqual(
    runtimeImportSpecifiers(
      readFileSync(join(packageDir, 'flow/steps.ts'), 'utf8'),
    ),
    [],
  )
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

// AIDEV-NOTE (PMR-ZV9Y 3.2): the same transitive walk, seeded from EVERY
// push-chain root instead of only cost-rows.ts. The single-root walk above is
// the historical guard and stays as it was; this one closes the hole where the
// cost-rows → run-health edge is removed (run-health is then still reachable
// from here, so a session-side import added to run-health.ts or
// state-metrics.ts keeps failing the guard).
test('every push-chain root transits only daemon-safe modules', () => {
  const visited = new Set<string>()
  const queue = CLOSURE_ROOTS.map((root) => join(packageDir, root))
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
  // the walk really reached the v2 module through the render seam, so this
  // guard is not vacuous if the graph is ever reshaped
  assert.ok(
    visited.has(join(packageDir, 'flow', 'state-metrics.ts')),
    'expected the walk to reach flow/state-metrics.ts',
  )
  assert.ok(
    visited.has(join(packageDir, 'flow', 'run-health.ts')),
    'expected the walk to reach flow/run-health.ts',
  )
  assert.deepEqual(violations, [])
})
