// AIDEV-NOTE (PMR-MSDJ fix round, P1): in-repo stand-in for the
// `bun run audit:pack` RELEASE gate (scripts/package-audit.mjs, PMR-0SWR).
// That gate is not wired into CI (`bun run check` excludes it), so a shipped
// absolute home path — username + directory layout in a PUBLICLY PUBLISHED
// tarball — only surfaced at review time in the first place. This test moves
// the same check into the package's own suite: it reads the package.json
// `files` allowlist (the packed universe) and fails on any packed text file
// containing the current user's home path. A published package must never
// carry a host path.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(
  readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
) as { files?: string[] }

/** Every packed text file: allowlist entries plus everything under them. */
function packedFiles(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const abs = path.join(pkgRoot, entry)
    if (!existsSync(abs)) continue // allowlist drift is the OTHER gate's job
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs, { recursive: true })) {
        const childAbs = path.join(abs, String(child))
        if (statSync(childAbs).isFile()) out.push(childAbs)
      }
      continue
    }
    out.push(abs)
  }
  return out
}

test('packed files ship no absolute home path (audit:pack gate, P1)', () => {
  const home = os.homedir()
  assert.ok(
    home.length > 0,
    'homedir() must resolve for this gate to mean anything',
  )
  const entries = pkg.files ?? []
  assert.ok(entries.length > 0, 'package.json must keep a files allowlist')
  const offenders: string[] = []
  for (const file of packedFiles(entries)) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue // binary or unreadable — the audit script skips these too
    }
    if (content.includes(home)) {
      offenders.push(path.relative(pkgRoot, file))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `absolute home path ${home} ships in: ${offenders.join(', ')} — reword as a placeholder (e.g. <home>)`,
  )
})
