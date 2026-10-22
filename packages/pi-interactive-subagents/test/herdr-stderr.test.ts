import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HerdrError, runHerdr } from '../pi-extension/subagents/herdr.ts'

// AIDEV-NOTE: regression for the 2026-10-22 stderr leak. execFileSync
// inherits stderr unless stdio is piped, so a caught herdr failure printed
// its raw error JSON into the parent TUI and HerdrError.stderr stayed empty.
// A fake `herdr` on PATH reproduces the failing CLI without a live server.
describe('runHerdr stderr capture', () => {
  let dir: string
  let savedPath: string | undefined

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-herdr-'))
    const script = join(dir, 'herdr')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "ok" ]; then echo fine; exit 0; fi',
        'echo \'{"error":{"code":"tab_not_found","message":"tab w1C:t3 not found"}}\' >&2',
        'exit 1',
      ].join('\n'),
    )
    chmodSync(script, 0o755)
    savedPath = process.env.PATH
    process.env.PATH = `${dir}:${savedPath ?? ''}`
  })

  after(() => {
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns trimmed stdout on success', () => {
    assert.equal(runHerdr(['ok']), 'fine')
  })

  it('captures stderr and exit code in HerdrError instead of leaking', () => {
    assert.throws(
      () => runHerdr(['tab', 'close', 'w1C:t3']),
      (err: unknown) => {
        assert.ok(err instanceof HerdrError)
        assert.equal(err.exitCode, 1)
        assert.match(err.stderr, /tab_not_found/)
        assert.match(err.message, /tab w1C:t3 not found/)
        return true
      },
    )
  })

  // AIDEV-NOTE: the leak is a write to the PARENT's fd 2, so only a child
  // process can observe it — process.stderr.write monkeypatching cannot.
  it('does not echo herdr stderr to the parent process', () => {
    const herdrModule = join(
      dirname(fileURLToPath(import.meta.url)),
      '../pi-extension/subagents/herdr.ts',
    )
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runHerdr } from ${JSON.stringify(herdrModule)}; try { runHerdr(['tab','close','w1C:t3']) } catch {}`,
      ],
      { encoding: 'utf8', env: process.env },
    )
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stderr, '')
  })
})
