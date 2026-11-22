// AIDEV-NOTE: PMR-PYW2 — per-package tmpdir helper. Cross-package imports
// are verboten (PMR-ESPA), so each package that needs auto-cleaned mkdtemp
// fixtures carries its own copy of this module instead of importing from a
// sibling workspace.
//
// mkTmpDir wraps mkdtempSync and registers every dir it creates in a
// module-level Set. Cleanup runs twice:
//   1. module-scope after() (node:test) — the canonical suite-end sweep, cf.
//      spec-approve-tool.test.ts / aven-answer.test.ts;
//   2. process.on('exit') backstop — cf. sweep.test.ts, covers runs where the
//      after() hook never fires (hard crash, --test-only isolation, SIGKILL
//      excluded by definition). Errors are swallowed: cleanup must never
//      fail the suite or mask the real error.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after } from 'node:test'

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

after(() => {
  sweepTmpDirs()
})

process.on('exit', () => {
  sweepTmpDirs()
})

export function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  registeredDirs.add(dir)
  return dir
}
