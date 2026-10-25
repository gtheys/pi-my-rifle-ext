/**
 * Integration tests for the herdr verb layer (PMR-M48Y).
 *
 * Exercises herdr panes: shell-readiness marker, script-file send with
 * async read, agent read/list/get. Two-mode (PMR-RNW2): real herdr when
 * HERDR_PANE_ID is set, the mock-herdr shim otherwise.
 *
 * Run: npm run test:integration
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  compareVersions,
  HERDR_MIN_VERSION,
  HerdrError,
  herdrAgentGet,
  herdrAgentList,
  herdrReadAgent,
  herdrReadPane,
  herdrRunScriptFile,
  herdrWaitOutput,
  parseHerdrStatus,
  runHerdr,
  runHerdrEnvelope,
} from '../../pi-extension/subagents/herdr.ts'
import { waitShellReady } from '../../pi-extension/subagents/spawn.ts'

import { installMockHerdr, type MockHerdr } from '../mock-herdr.ts'

// AIDEV-NOTE: two-mode gate (PMR-RNW2). HERDR_PANE_ID set → run against real
// herdr as before. Unset → prepend the mock-herdr shim bin dir to PATH so
// runHerdr/execFileSync('herdr') hits the shim; restored in after().
let mock: MockHerdr | null = null
let savedPath: string | undefined

const trackedPanes: string[] = []

function isRealHerdr(): boolean {
  return !!process.env.HERDR_PANE_ID
}

before(() => {
  if (isRealHerdr()) return
  mock = installMockHerdr()
  savedPath = process.env.PATH
  process.env.PATH = `${mock.binDir}:${savedPath ?? ''}`
})

after(() => {
  for (const pane of trackedPanes) {
    try {
      runHerdr(['pane', 'close', pane])
    } catch {}
  }
  if (mock) {
    process.env.PATH = savedPath
    mock.dispose()
  }
})

describe('herdr verb layer [two-mode herdr]', { timeout: 60_000 }, () => {
  let workspace: string

  before(() => {
    if (!isRealHerdr()) return
    // AIDEV-NOTE: isRealHerdr() already guarantees HERDR_PANE_ID is set;
    // narrow it explicitly so no cast is needed.
    const paneEnv = process.env.HERDR_PANE_ID
    if (!paneEnv) return
    workspace = paneEnv.split(':')[0]
  })

  function createTestPane(): string {
    const result = runHerdrEnvelope<{ pane?: { pane_id?: string } }>([
      'pane',
      'split',
      '--direction',
      'down',
      '--no-focus',
      '--current',
      '--cwd',
      process.cwd(),
    ])
    const paneId = result.pane?.pane_id
    if (!paneId) throw new Error('herdr pane split returned no pane_id')
    trackedPanes.push(paneId)
    return paneId
  }

  it('preflight enforces the version gate on the installed binary', () => {
    if (isRealHerdr()) {
      const raw = runHerdr(['status', '--json'])
      const status = JSON.parse(raw) as { server?: { version?: string } }
      const version = status.server?.version ?? ''
      if (compareVersions(version, HERDR_MIN_VERSION) >= 0) {
        parseHerdrStatus(raw)
        return
      }
      assert.throws(() => parseHerdrStatus(raw), HerdrError)
      return
    }
    // Mock mode: the shim always reports a version above the gate.
    const raw = runHerdr(['status', '--json'])
    parseHerdrStatus(raw)
  })

  it('shell-readiness marker: pane run echo + pane wait-output', async () => {
    const pane = createTestPane()
    await waitShellReady(pane, { timeoutMs: 15_000 })
  })

  it('script-file send + async pane read round-trip', async () => {
    const pane = createTestPane()
    await waitShellReady(pane, { timeoutMs: 15_000 })

    const dir = mkdtempSync(join(tmpdir(), 'herdr-verb-test-'))
    const scriptPath = join(dir, 'marker.sh')
    const marker = `__M48Y_${Date.now()}__`
    writeFileSync(scriptPath, `#!/bin/sh\necho ${marker}\n`)
    herdrRunScriptFile(pane, scriptPath)
    herdrWaitOutput(pane, marker, 15_000)

    // Async read (recent-unwrapped keeps the marker on one logical line).
    const screen = herdrReadPane(pane, {
      source: 'recent-unwrapped',
      lines: 50,
    })
    assert.ok(screen.includes(marker), 'marker visible via pane read')
    assert.ok(screen.includes('M48Y'), 'marker survives unwrapped read')

    rmSync(dir, { recursive: true, force: true })
  })

  it('agent list / agent get report identity', async () => {
    // AIDEV-NOTE: the suite runner pane (HERDR_PANE_ID) is only a herdr agent
    // when tests run from inside a pi herdr session; a plain shell runner is
    // never registered and herdr has no `agent register` verb (0.9.5). Create
    // our own agent instead — this also covers `agent start`.
    const pane = createTestPane()
    await waitShellReady(pane, { timeoutMs: 15_000 })
    runHerdr([
      'agent',
      'start',
      `verb-identity-${Date.now()}`,
      '--kind',
      'pi',
      '--pane',
      pane,
      '--timeout',
      '15000',
      '--',
      '-ne',
    ])

    const agents = herdrAgentList()
    assert.ok(Array.isArray(agents))
    const own = agents.find((a) => a.pane_id === pane)
    assert.ok(own, 'started agent appears in agent list')
    const got = herdrAgentGet(pane)
    assert.equal(got?.pane_id, pane)

    // Agent-path read (recent-unwrapped, text, no --lines) against the agent
    // we just started. Plain shell panes are NOT agents — herdr replies
    // agent_not_found (verified on 0.9.0), so this doubles as that check.
    const agentOut = herdrReadAgent(pane)
    assert.ok(agentOut.length > 0, 'agent read returns output for agent panes')
  })
})
