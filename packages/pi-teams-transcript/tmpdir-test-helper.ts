// AIDEV-NOTE: PMR-NHW8 — per-package tmpdir helper. Cross-package imports
// are verboten (PMR-ESPA), so each package that needs auto-cleaned mkdtemp
// fixtures carries its own copy of this module instead of importing from a
// sibling workspace. Bun variant of packages/pi-flow/test/tmpdir.ts: this
// package runs on `bun test` (bun:test), so the suite-end sweep hooks into
// afterAll instead of node:test's after().
//
// mkTmpDir wraps mkdtempSync and registers every dir it creates in a
// module-level Set. Cleanup runs twice:
//   1. afterAll() (bun:test) — the canonical suite-end sweep. It is
//      registered lazily inside mkTmpDir, not at module scope: bun binds a
//      module-eval afterAll to whichever test file triggers the import
//      first, so a module-scope hook only ever sweeps one suite and leaks
//      the other (verified on bun 1.3.14). Called during each file's test
//      run, afterAll binds to that file — one hook per mkTmpDir call, all
//      idempotent because the shared Set is cleared on sweep.
//   2. process.on('exit') backstop — covers non-test-runner exits (bun test
//      never emits 'exit'; kept for parity with the node variant).
//      Errors are swallowed: cleanup must never fail the suite or mask the
//      real error.
// Named tmpdir-test-helper.ts (not *.test.ts) so `bun test` does not pick it
// up as a test file.

import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const registeredDirs = new Set<string>()

function sweepTmpDirs(): void {
  for (const dir of registeredDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
  registeredDirs.clear()
}

process.on('exit', () => {
  sweepTmpDirs()
})

export function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  registeredDirs.add(dir)
  afterAll(() => {
    sweepTmpDirs()
  })
  return dir
}
