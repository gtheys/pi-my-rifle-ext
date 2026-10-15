/**
 * Integration tests for durable branch-owned assignments (PMR-Z5KR).
 *
 * REAL pi sessions + REAL LLM calls, herdr-only. File-based assertions on
 * <agentDir>/pi-subagents/assignments/.
 *
 * 1. Verified completion REMOVES the assignment record.
 * 2. Restart survival: parent dies mid-run, the record persists on disk, the
 *    spared child keeps running in its herdr tab and completes, and a NEW
 *    parent rediscovers the orphan from files alone (subagents_list).
 *
 * Run inside herdr: npm run test:integration
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { getAgentDir } from '@mariozechner/pi-coding-agent'
import { listAssignments } from '../../pi-extension/subagents/assignments.ts'
import { subagentsDataRoot } from '../../pi-extension/subagents/dataroot.ts'
import {
  cleanupTestEnv,
  closeSurface,
  createTestEnv,
  createTrackedSurface,
  isHerdrIntegrationAvailable,
  PI_TIMEOUT,
  readScreen,
  sleep,
  startPi,
  type TestEnv,
  trackTempFile,
  uniqueId,
  untrackSurface,
  waitForFile,
} from './harness.ts'

if (!isHerdrIntegrationAvailable()) {
  console.log(
    '⚠️  Not inside herdr (HERDR_PANE_ID unset) — skipping assignment integration tests',
  )
}

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

/** Find the assignment record file whose content names `needle`. */
function findAssignmentFile(
  dir: string,
  needle: string,
): { path: string; content: string } | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    try {
      const content = readFileSync(path, 'utf8')
      if (content.includes(needle)) return { path, content }
    } catch {}
  }
  return null
}

describe('assignments [herdr] (PMR-Z5KR)', {
  timeout: PI_TIMEOUT * 4,
}, () => {
  let env: TestEnv

  before(() => {
    if (isHerdrIntegrationAvailable()) env = createTestEnv()
  })

  after(() => {
    if (env) cleanupTestEnv(env)
  })

  it('writes the record at spawn and removes it on verified completion', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-assign-${id}.txt`
    trackTempFile(env, markerFile)
    const assignmentsDir = join(subagentsDataRoot(getAgentDir()), 'assignments')

    const surface = createTrackedSurface(env, `assign-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Assign-${id}"`,
      `  agent: "test-echo"`,
      // AIDEV-NOTE: the sleep keeps the record's lifetime deterministic — a
      // fast-failing child (provider error) removes its record within
      // seconds and the 1s poll below can miss it entirely.
      `  task: "Run this bash command: sleep 15; echo 'DONE_${id}' > '${markerFile}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // Record appears at spawn, keyed by childId, naming the child.
    let found: { path: string; content: string }
    try {
      found = await waitFor(
        () => findAssignmentFile(assignmentsDir, `Assign-${id}`),
        PI_TIMEOUT * 2,
        `assignment record for Assign-${id}`,
      )
    } catch (err) {
      // Diagnostics: what did the parent actually do + what IS on disk?
      const screen = readScreen(surface, 300)
      const dirDump = existsSync(assignmentsDir)
        ? readdirSync(assignmentsDir).join(', ')
        : '(assignments dir missing)'
      throw new Error(
        `${(err as Error).message}\nAssignments dir: ${dirDump}\nParent screen tail:\n${screen.slice(-2000)}`,
      )
    }
    const record = JSON.parse(found.content) as {
      childId: string
      status: string
      claim: { pid: number; id: string }
    }
    assert.ok(record.childId, 'record should name its childId')
    assert.ok(record.claim.pid > 0, 'record should carry the parent claim pid')

    // Verified completion (`.exit` observed by the watcher) REMOVES the record.
    await waitForFile(markerFile, PI_TIMEOUT, /DONE_/)
    await waitFor(
      () => {
        if (existsSync(found.path)) return null
        return 'removed'
      },
      PI_TIMEOUT,
      `removal of assignment record ${found.path} after verified completion`,
    )
  })

  it('parent death: record persists, spared child completes, new parent sees the orphan', async () => {
    const id = uniqueId()
    const markerFile = `/tmp/pi-integ-orphan-${id}.txt`
    const listFile = `/tmp/pi-integ-orphan-list-${id}.txt`
    trackTempFile(env, markerFile)
    trackTempFile(env, listFile)
    const assignmentsDir = join(subagentsDataRoot(getAgentDir()), 'assignments')

    const surface = createTrackedSurface(env, `orphan-${id}`)
    await sleep(1000)

    const task = [
      `Call the subagent tool with these EXACT parameters:`,
      `  name: "Orphan-${id}"`,
      `  agent: "test-echo"`,
      `  task: "Run this bash command: sleep 45; echo 'SURVIVED_${id}' > '${markerFile}'"`,
      `Do not do anything else. Just call the subagent tool once.`,
    ].join('\n')

    startPi(surface, env.dir, task)

    // Wait for the spawn (record on disk), then KILL the parent pane —
    // orchestrator death. The child's herdr-owned tab must survive
    // (session_shutdown spares children with durable assignments; an abrupt
    // kill leaves the tab untouched either way).
    let found: { path: string; content: string }
    try {
      found = await waitFor(
        () => findAssignmentFile(assignmentsDir, `Orphan-${id}`),
        PI_TIMEOUT * 2,
        `assignment record for Orphan-${id}`,
      )
    } catch (err) {
      // Diagnostics: what did the parent actually do?
      const screen = readScreen(surface, 300)
      throw new Error(
        `${(err as Error).message}\nParent screen tail:\n${screen.slice(-2000)}`,
      )
    }
    closeSurface(surface)
    untrackSurface(env, surface)

    // The record persists on disk after the parent is gone.
    await sleep(2000)
    assert.ok(
      existsSync(found.path),
      `assignment record must survive parent death: ${found.path}`,
    )

    // Files-alone classification from a fresh reader: the claim pid is dead,
    // so the record reads as an orphan with a resume hint.
    const orphanView = await waitFor(
      () => {
        const view = listAssignments(subagentsDataRoot(getAgentDir())).find(
          (v) => v.state !== 'unknown' && v.record.name === `Orphan-${id}`,
        )
        if (!view) return null
        if (view.state === 'owned') return null // parent pid still tearing down
        return view
      },
      PI_TIMEOUT,
      `orphan classification for Orphan-${id}`,
    )
    assert.equal(orphanView.state, 'orphaned')
    if (orphanView.state === 'orphaned') {
      assert.match(orphanView.resumeHint ?? '', /subagent_resume/)
    }

    // A NEW parent rediscovers the orphan through the tool surface.
    const surface2 = createTrackedSurface(env, `newparent-${id}`)
    await sleep(1000)
    const task2 = [
      `Call the subagents_list tool once.`,
      `Then write the COMPLETE raw text of the tool output to '${listFile}' using the bash tool (use a heredoc, do not paraphrase).`,
      `Do not do anything else.`,
    ].join('\n')
    startPi(surface2, env.dir, task2)

    const listing = await waitForFile(
      listFile,
      PI_TIMEOUT,
      new RegExp(`Orphan-${id}[\\s\\S]*ORPHANED|ORPHANED[\\s\\S]*Orphan-${id}`),
    )
    assert.ok(listing.includes(`Orphan-${id}`))

    // The spared child kept running and completed despite the parent's death.
    const content = await waitForFile(markerFile, PI_TIMEOUT * 2, /SURVIVED_/)
    assert.ok(content.includes(`SURVIVED_${id}`))

    // Nobody removes the orphan record (the owning parent is dead) — the
    // test cleans it up so the host assignments dir stays tidy.
    rmSync(found.path, { force: true })
  })
})
