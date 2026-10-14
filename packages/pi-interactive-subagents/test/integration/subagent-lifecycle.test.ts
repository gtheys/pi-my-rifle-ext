/**
 * Integration tests for the full subagent lifecycle — herdr-only (PMR-TABUX).
 *
 * These tests spawn REAL pi sessions with REAL LLM calls. Each test runs pi
 * in a herdr pane with a task that uses the subagent tool, and verifies the
 * outcome via marker files (file-based asserts) and pane output.
 *
 * Costs: ~$0.01-0.05 per test run.
 * Duration: ~30-90s per test.
 *
 * Run inside herdr: npm run test:integration
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: zai/glm-5.3-flash)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { getAgentDir } from '@mariozechner/pi-coding-agent'
import { readAskRecord } from '../../pi-extension/subagents/asks.ts'
import { subagentsDataRoot } from '../../pi-extension/subagents/dataroot.ts'
import {
  cleanupTestEnv,
  createTestEnv,
  createTrackedSurface,
  getFocusedSurface,
  isHerdrIntegrationAvailable,
  PI_TIMEOUT,
  readScreen,
  sendCommand,
  sleep,
  startPi,
  type TestEnv,
  trackTempFile,
  uniqueId,
  waitForFile,
  waitForFocusedSurface,
  waitForScreen,
} from './harness.ts'

if (!isHerdrIntegrationAvailable()) {
  console.log(
    '⚠️  Not inside herdr (HERDR_PANE_ID unset) — skipping subagent lifecycle integration tests',
  )
}

/**
 * Poll `fn()` until it returns truthy; returns its value. File-based waits
 * for the WXG0 mailbox round trip.
 */
async function waitFor<T>(
  fn: () => T | null,
  timeout: number,
  what: string,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = fn()
    if (value) return value
    await sleep(1000)
  }
  throw new Error(`Timeout (${timeout}ms) waiting for ${what}`)
}

/**
 * Find the ask record whose question contains `needle` in the shared asks
 * dir. Returns its path + childId. Scanning (vs a known childId) is required
 * because the test does not know the childId the parent assigned.
 */
function findAskRecordByQuestion(
  asksDir: string,
  needle: string,
): { path: string; childId: string; content: string } | null {
  if (!existsSync(asksDir)) return null
  for (const entry of readdirSync(asksDir)) {
    if (!entry.endsWith('.json') || entry.endsWith('.reply.json')) continue
    const path = join(asksDir, entry)
    const content = readFileSync(path, 'utf8')
    if (!content.includes(needle)) continue
    const childId = entry.slice(0, -'.json'.length)
    if (!readAskRecord(childId, subagentsDataRoot(getAgentDir()))) continue
    return { path, childId, content }
  }
  return null
}

describe('subagent-lifecycle [herdr]', {
  timeout: PI_TIMEOUT * 3,
}, () => {
  let env: TestEnv

  before(() => {
    if (isHerdrIntegrationAvailable()) env = createTestEnv()
  })

  after(() => {
    if (env) cleanupTestEnv(env)
  })

  // ── Basic spawn + completion ──

  it('spawns a subagent that writes a file and verifies the session', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-echo-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `echo-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Echo-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
      `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // Verify: subagent created the marker file
    const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/)
    assert.ok(
      content.includes(`PASS_${id}`),
      `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
    )

    // Verify: outer pi received the subagent result
    const screen = await waitForScreen(
      surface,
      /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
      PI_TIMEOUT,
    )

    // Verify: session file was created (shown in steer result)
    const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/)
    if (sessionMatch) {
      const sessionFile = sessionMatch[1]
      assert.ok(
        existsSync(sessionFile),
        `Subagent session file should exist: ${sessionFile}`,
      )

      const lines = readFileSync(sessionFile, 'utf8').trim().split('\n')
      assert.ok(
        lines.length >= 2,
        `Session should have ≥2 entries, got ${lines.length}`,
      )

      const header = JSON.parse(lines[0])
      assert.equal(
        header.type,
        'session',
        'First entry should be session header',
      )
      assert.ok(header.id, 'Session header should have an id')
    }
  })

  // ── In-progress activity snapshots ──

  it('keeps a long active tool call from surfacing false stalled status', async () => {
    const id = uniqueId()
    const startFile = `/tmp/pi-integ-status-start-${id}.txt`
    const markerFile = `/tmp/pi-integ-status-${id}.txt`
    trackTempFile(env, startFile)
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `status-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Status-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
      `After you receive the subagent result, say STATUS_TEST_DONE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    const activeScreen = await waitForScreen(
      surface,
      /active[\s\S]*bash|bash[\s\S]*active/i,
      PI_TIMEOUT,
      300,
    )
    assert.doesNotMatch(
      activeScreen,
      /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
    )

    await waitForFile(startFile, PI_TIMEOUT, /START_/)
    assert.equal(
      existsSync(markerFile),
      false,
      'Completion marker should not exist before the long sleep',
    )
    await sleep(65_000)
    assert.equal(
      existsSync(markerFile),
      false,
      'Completion marker should not exist before the watchdog assertion',
    )
    const watchdogScreen = readScreen(surface, 300)
    assert.doesNotMatch(
      watchdogScreen,
      /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
    )

    const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/)
    assert.ok(
      content.includes(`STATUS_${id}`),
      `Marker file should contain STATUS_${id}`,
    )

    const completionScreen = await waitForScreen(
      surface,
      /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
      PI_TIMEOUT,
      300,
    )
    assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen))
  })

  // ── Parallel subagent spawn ──

  it('spawns two subagents in parallel and both complete', async () => {
    const id = uniqueId()
    const fileA = `/tmp/pi-integ-para-${id}-a.txt`
    const fileB = `/tmp/pi-integ-para-${id}-b.txt`
    trackTempFile(env, fileA)
    trackTempFile(env, fileB)

    const surface = createTrackedSurface(env, `parallel-${id}`)
    await sleep(1000)

    const task = [
      `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
      ``,
      `First call:`,
      `  name: "ParaA-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
      ``,
      `Second call:`,
      `  name: "ParaB-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
      ``,
      `Call both subagent tools NOW, do not wait between them.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // Both marker files should appear
    const [contentA, contentB] = await Promise.all([
      waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
      waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
    ])

    assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`)
    assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`)
  })

  // ── Fork mode ──

  it('fork mode creates a child session linked to the parent', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-fork-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `fork-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Fork-${id}"`,
      `  fork: true`,
      `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
      `Do not set the agent parameter. Just set name, fork, and task.`,
      `After you receive the result, say FORK_COMPLETE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // Verify: forked subagent created the file
    const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/)
    assert.ok(
      content.includes(`FORK_OK_${id}`),
      `Fork marker file should exist with content`,
    )

    // Wait for the outer pi to show the result
    const screen = await waitForScreen(
      surface,
      /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
      PI_TIMEOUT,
    )

    // Verify: the forked session has a parent link
    const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/)
    if (sessionMatch) {
      const sessionFile = sessionMatch[1]
      assert.ok(
        existsSync(sessionFile),
        `Fork session file should exist: ${sessionFile}`,
      )

      const entries = readFileSync(sessionFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      const header = entries[0]
      assert.equal(
        header.type,
        'session',
        'First entry should be session header',
      )
      assert.ok(
        header.parentSession,
        'Fork session should have parentSession field',
      )
      // Fork sessions include parent context (model_change entries etc.)
      assert.ok(
        entries.length >= 2,
        'Fork session should have context entries beyond header',
      )
    }
  })

  // ── caller_ping ──

  it('subagent caller_ping sends notification back to the parent', async () => {
    const id = uniqueId()

    const surface = createTrackedSurface(env, `ping-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Ping-${id}"`,
      `  agent: "test-ping"`,
      `  task: "PING_TEST_${id}"`,
      `Just call the subagent tool once. Do not do anything else before calling it.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // The test-ping agent calls caller_ping, which steers a "needs help" message
    // back to the outer pi. Look for it on screen.
    const screen = await waitForScreen(
      surface,
      /needs help|PING|caller_ping|ping/i,
      PI_TIMEOUT,
    )

    assert.ok(
      /needs help|PING/i.test(screen),
      `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
    )
  })

  // ── ask_owner round trip (PMR-WXG0) ──

  it('ask_owner blocks the child, answer_subagent queues the reply and the pump completes it', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-ask-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `ask-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Ask-${id}"`,
      `  agent: "test-ask"`,
      `  task: "ASK_ROUNDTRIP_${id}"`,
      `Just call the subagent tool once. Do not do anything else before calling it.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // File-based round trip (WXG0 phase 5 mailbox pump): wait for the durable
    // ask record the child wrote, not for a screen scrape.
    const asksDir = join(subagentsDataRoot(getAgentDir()), 'asks')
    const askRecordPathForThis = await waitFor(
      () => findAskRecordByQuestion(asksDir, `ASK_ROUNDTRIP_${id}`),
      PI_TIMEOUT,
      `ask record for ASK_ROUNDTRIP_${id} in ${asksDir}`,
    )
    const askRecord = JSON.parse(askRecordPathForThis.content) as {
      askId: string
      childId: string
      sessionFile: string
    }
    assert.equal(askRecord.childId, askRecordPathForThis.childId)

    // Parent-side: deliver the answer via answer_subagent (askId optional).
    sendCommand(
      surface,
      `Use answer_subagent with name "Ask-${id}" and message: ` +
        `Write ANSWER_${id} to ${markerFile} using bash, then call subagent_done.`,
    )

    // Reply record appears once answer_subagent queued it...
    const replyPath = askRecordPathForThis.path.replace(
      /\.json$/,
      '.reply.json',
    )
    const reply = await waitForFile(replyPath, PI_TIMEOUT, /askId/)
    assert.equal(JSON.parse(reply).askId, askRecord.askId)

    // ...the child pump ingests it and writes the ack sidecar...
    await waitForFile(`${askRecord.sessionFile}.ack`, PI_TIMEOUT)

    // ...then continues the SAME session: writes the marker and exits with
    // the normal `.exit` sidecar.
    const content = await waitForFile(markerFile, PI_TIMEOUT, /ANSWER/)
    assert.ok(
      content.includes(`ANSWER_${id}`),
      `Child should have run the answered instruction. Got: ${content.trim()}`,
    )
    const exitPayload = await waitForFile(`${askRecord.sessionFile}.exit`)
    assert.match(exitPayload, /"type":"done"/)

    // Post-ingestion cleanup: ask + reply records removed (at-least-once
    // window closed).
    await waitFor(
      () => {
        if (existsSync(replyPath)) return null
        if (existsSync(askRecordPathForThis.path)) return null
        return 'cleaned'
      },
      PI_TIMEOUT,
      `cleanup of ask/reply records for ${askRecord.childId}`,
    )
  })

  // ── Agent discovery ──

  it('subagent discovers project-local test agents', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-discovery-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `discovery-${id}`)
    await sleep(1000)

    // Use subagents_list to verify test agents are discoverable,
    // then spawn one to prove it works end-to-end.
    const task = [
      `First, call the subagents_list tool to see available agents.`,
      `Then call the subagent tool:`,
      `  name: "Disco-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
      `After you receive the subagent result, say DISCOVERY_DONE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // The test-echo agent (discovered from project .pi/agents/) should work
    const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/)
    assert.ok(
      content.includes(`DISCO_${id}`),
      `Discovery test marker should exist`,
    )
  })

  // ── Background-tab spawn (PMR-TABUX) ──

  it('spawns a subagent into a background tab and never steals focus', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-nofocus-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `nofocus-${id}`)
    await sleep(1000)

    // Hold focus on OUR pane before and during the spawn.
    const anchor = process.env.HERDR_PANE_ID as string
    await waitForFocusedSurface(anchor, 10_000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "NoFocus-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/)
    assert.ok(content.includes(`PASS_${id}`))

    // Focus must still be on the test anchor (never the spawned tab).
    assert.equal(getFocusedSurface(), anchor)
  })

  // ── Subagent with custom system prompt ──

  it('passes systemPrompt to subagent', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`
    trackTempFile(env, markerFile)

    const surface = createTrackedSurface(env, `sysprompt-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these parameters:`,
      `  name: "SysP-${id}"`,
      `  agent: "test-echo"`,
      `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
      `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
      `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/)
    assert.ok(
      content.includes(`SYSPROMPT_${id}`),
      `System prompt test marker should exist`,
    )
  })
})
