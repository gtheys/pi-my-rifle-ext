/**
 * Integration tests for the herdr surface layer (PMR-TABUX).
 *
 * These tests exercise real herdr operations: background tab creation
 * (focus-safe), shell readiness, sending commands, reading screen output,
 * Escape delivery, and closing surfaces. No LLM calls — fast and free.
 *
 * Run inside herdr (HERDR_PANE_ID set): npm run test:integration
 */

import assert from 'node:assert/strict'
import { unlinkSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import {
  herdrAgentGet,
  herdrAgentList,
} from '../../pi-extension/subagents/herdr.ts'
import { waitShellReady } from '../../pi-extension/subagents/spawn.ts'
import {
  cleanupTestEnv,
  closeSurface,
  createTestEnv,
  createTrackedSurface,
  focusSurface,
  getFocusedSurface,
  isHerdrIntegrationAvailable,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendEscape,
  sendLongCommand,
  sleep,
  type TestEnv,
  trackTempFile,
  uniqueId,
  untrackSurface,
  waitForFile,
  waitForFocusedSurface,
  waitForScreen,
} from './harness.ts'

if (!isHerdrIntegrationAvailable()) {
  console.log(
    '⚠️  Not inside herdr (HERDR_PANE_ID unset) — skipping surface tests',
  )
}

describe('herdr surface [real herdr]', { timeout: 60_000 }, () => {
  let env: TestEnv

  before(() => {
    if (isHerdrIntegrationAvailable()) env = createTestEnv()
  })

  after(() => {
    if (env) cleanupTestEnv(env)
  })

  it('creates a background tab without stealing focus (the --no-focus guarantee)', async () => {
    if (!isHerdrIntegrationAvailable()) return

    const anchor = process.env.HERDR_PANE_ID as string
    focusSurface(anchor)
    await waitForFocusedSurface(anchor, 10_000)

    const childA = createTrackedSurface(env, 'focus-child-a')
    await sleep(1500)
    assert.equal(
      getFocusedSurface(),
      anchor,
      'tab create --no-focus must never move focus',
    )

    const childB = createTrackedSurface(env, 'focus-child-b')
    await sleep(1500)
    assert.equal(getFocusedSurface(), anchor)

    // Focus the child explicitly — the only legitimate focus action.
    focusSurface(childA)
    await waitForFocusedSurface(childA, 10_000)
    focusSurface(anchor)
    await waitForFocusedSurface(anchor, 10_000)
  })

  it('proves shell readiness via the marker protocol', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'shell-ready')
    await waitShellReady(surface, { timeoutMs: 15_000 })
  })

  it('creates a surface, sends a command, reads output, and closes it', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'echo-test')
    await sleep(1000)

    const marker = uniqueId()
    sendCommand(surface, `echo "MARKER_${marker}"`)
    await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 20_000, 50)

    closeSurface(surface)
    untrackSurface(env, surface)
  })

  it('preserves shell special characters in echo output', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'escape-test')
    await sleep(1000)

    const marker = uniqueId()
    sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`)
    const screen = await waitForScreen(
      surface,
      new RegExp(`SPEC_${marker}`),
      20_000,
      50,
    )
    assert.ok(
      screen.includes('$HOME'),
      `Expected literal $HOME in output. Got:\n${screen}`,
    )
  })

  it('sends a long command via script file without truncation', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'long-cmd-test')
    await sleep(1000)

    const marker = uniqueId()
    const longValue = 'X'.repeat(500)
    const command = `echo "LONG_${marker}_${longValue}_END"`

    sendLongCommand(surface, command)
    const screen = await waitForScreen(
      surface,
      new RegExp(`LONG_${marker}`),
      20_000,
      50,
    )
    assert.ok(
      screen.includes('_END'),
      `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
    )
  })

  it('manages multiple surfaces concurrently', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const s1 = createTrackedSurface(env, 'multi-1')
    const s2 = createTrackedSurface(env, 'multi-2')
    await sleep(1500)

    const m1 = uniqueId()
    const m2 = uniqueId()
    sendCommand(s1, `echo "S1_${m1}"`)
    sendCommand(s2, `echo "S2_${m2}"`)

    await Promise.all([
      waitForScreen(s1, new RegExp(`S1_${m1}`), 20_000, 50),
      waitForScreen(s2, new RegExp(`S2_${m2}`), 20_000, 50),
    ])
  })

  it('writes output to a file and verifies via the file (file-based assert)', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'file-test')
    await sleep(1000)

    const marker = uniqueId()
    const filePath = `/tmp/pi-herdr-test-${marker}.txt`
    trackTempFile(env, filePath)

    sendCommand(
      surface,
      `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`,
    )

    const content = await waitForFile(
      filePath,
      20_000,
      new RegExp(`FILE_${marker}`),
    )
    assert.ok(
      content.includes(`FILE_${marker}`),
      `File content wrong. Got: ${content}`,
    )
  })

  it('delivers Escape as byte 27 to the target surface', async () => {
    if (!isHerdrIntegrationAvailable()) return
    const surface = createTrackedSurface(env, 'escape-byte-test')
    await sleep(1000)

    const marker = uniqueId()
    const byteFile = `/tmp/pi-herdr-escape-${marker}.txt`
    trackTempFile(env, byteFile)

    const nodeProgram =
      "const fs = require('node:fs');" +
      "if (!process.stdin.isTTY) throw new Error('stdin is not a TTY');" +
      'process.stdin.setRawMode(true);' +
      'process.stdin.resume();' +
      "process.stdout.write('ESC_READY\\n');" +
      "process.stdin.once('data', (chunk) => {" +
      `fs.writeFileSync(${JSON.stringify(byteFile)}, Array.from(chunk).join(','));` +
      'process.exit(0);' +
      '});'
    const command = `node -e ${JSON.stringify(nodeProgram)}`

    sendLongCommand(surface, command)
    await waitForScreen(surface, /ESC_READY/, 15_000, 50)

    sendEscape(surface)

    const content = await waitForFile(byteFile, 15_000, /^27$/)
    assert.equal(content.trim(), '27')
  })

  it('reports agent identity via agent list / agent get', () => {
    if (!isHerdrIntegrationAvailable()) return
    const agents = herdrAgentList()
    assert.ok(Array.isArray(agents))
    const own = agents.find((a) => a.pane_id === process.env.HERDR_PANE_ID)
    assert.ok(own, 'own pane appears in agent list')
    const got = herdrAgentGet(process.env.HERDR_PANE_ID as string)
    assert.equal(got?.pane_id, process.env.HERDR_PANE_ID)
  })
})
