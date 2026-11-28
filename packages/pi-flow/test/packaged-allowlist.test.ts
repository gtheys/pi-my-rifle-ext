// AIDEV-NOTE (PMR-9ASP): in-repo stand-in for the import-reachability half of
// the `bun run audit:pack` RELEASE gate (scripts/package-audit.mjs, PMR-0SWR
// check 3 / PMR-0AN2). That gate is not wired into `bun run check`, so a
// statically reachable module missing from the `files` allowlist only surfaced
// at audit time — and a published package then crashes at load with
// MODULE_NOT_FOUND. This test runs the SAME walker
// (scripts/lib/package-reachability.mjs) inside the package's own suite: the
// fixtures prove detection, the real-tree walk enforces cleanliness. No npm
// pack, no network — the packed universe is derived locally.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkImportReachability,
  entryPoints,
} from '../../../scripts/lib/package-reachability.mjs'
import { mkTmpDir } from './tmpdir.ts'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface FixturePkg {
  files?: string[]
  pi: { extensions: string[] }
}

/** Fixture tree: index.ts imports ./helper.ts; `files` controls the allowlist. */
function writeFixture(files: string[]): { pkgDir: string; pkg: FixturePkg } {
  const dir = mkTmpDir('pi-flow-allowlist-')
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-pkg',
      pi: { extensions: ['./index.ts'] },
      files,
    }),
  )
  writeFileSync(
    path.join(dir, 'index.ts'),
    "import { helper } from './helper.ts'\n",
  )
  writeFileSync(path.join(dir, 'helper.ts'), 'export const helper = 1\n')
  const pkg = JSON.parse(
    readFileSync(path.join(dir, 'package.json'), 'utf8'),
  ) as FixturePkg
  return { pkgDir: dir, pkg }
}

test('files allowlist gate: omitted reachable module is reported with its path (fixture)', () => {
  const { pkgDir, pkg } = writeFixture(['index.ts']) // helper.ts exists but is unlisted
  const findings = checkImportReachability(pkgDir, pkg.files ?? [], pkg)
  assert.ok(
    findings.some((f) => f.includes('"helper.ts"') && f.includes('index.ts')),
    `expected a finding naming "helper.ts" from index.ts, got: ${findings.join('; ')}`,
  )
})

test('files allowlist gate: listed reachable module yields no findings (fixture)', () => {
  const { pkgDir, pkg } = writeFixture(['index.ts', 'helper.ts'])
  const findings = checkImportReachability(pkgDir, pkg.files ?? [], pkg)
  assert.deepEqual(findings, [])
})

test('files allowlist gate: every reachable pi-flow module is in the files allowlist (real tree)', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
  ) as FixturePkg
  // AIDEV-NOTE (PMR-HXC2): guard the guard — checkImportReachability's BFS
  // starts from entryPoints(pkg). If pi.extensions/exports ever drift to
  // empty or unrecognized fields the walker visits nothing and the gate
  // passes without enforcing the files allowlist; fail loudly instead.
  assert.ok(
    entryPoints(pkg).length > 0,
    'pi-flow package.json yields zero entrypoints (pi.extensions/exports empty or unrecognized) — checkImportReachability would walk nothing and pass without enforcing the files allowlist',
  )
  const findings = checkImportReachability(pkgRoot, pkg.files ?? [], pkg)
  assert.deepEqual(
    findings,
    [],
    `reachable module(s) missing from the files allowlist — add them to packages/pi-flow/package.json "files" (audit:pack release gate, PMR-0SWR): ${findings.join('; ')}`,
  )
})
