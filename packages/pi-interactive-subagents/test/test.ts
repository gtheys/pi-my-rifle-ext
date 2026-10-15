import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { visibleWidth } from '@mariozechner/pi-tui'
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from '../pi-extension/subagents/activity.ts'
import {
  type AskRecord,
  askIdentityMatches,
  askRecordPath,
  readAskRecord,
  readAskSidecar,
  readReplyRecord,
  removeAskRecord,
  removeAskRecordsForSession,
  removeAskSidecar,
  removeReplyRecord,
  writeAskRecord,
  writeAskSidecar,
  writeReplyRecord,
} from '../pi-extension/subagents/asks.ts'
import {
  ackMatches,
  ackSidecarPath,
  type ControlAck,
  type ControlRecord,
  controlRecordPath,
  readAckSidecar,
  readControlRecord,
  writeAckSidecar,
  writeControlRecord,
} from '../pi-extension/subagents/control.ts'
import {
  compareVersions,
  HERDR_MIN_VERSION,
  HerdrError,
  parseHerdrEnvelope,
  parseHerdrStatus,
} from '../pi-extension/subagents/herdr.ts'
import * as subagentsModule from '../pi-extension/subagents/index.ts'
import * as spawnModule from '../pi-extension/subagents/spawn.ts'
// re-exported for blocked-phase widget tests
import {
  __storeInternals__,
  allocateSemanticRef,
  MAX_RESULT_RECORD_BYTES,
  parseSemanticRef,
  type ResultRefBinding,
  readResultRecord,
  resolveResultRef,
  resultRecordPath,
  writeResultRecord,
} from '../pi-extension/subagents/store.ts'
import {
  __pollForExitTest__,
  POLL_CHECK_ORDER,
  shellEscape,
} from '../pi-extension/subagents/surface.ts'

const resolveDenyTools = subagentsModule.__test__.resolveDenyTools

import {
  appendBranchSummary,
  copySessionFile,
  findLastAssistantMessage,
  getLeafId,
  getNewEntries,
  mergeNewEntries,
  seedSubagentSessionFile,
} from '../pi-extension/subagents/session.ts'
import {
  advanceStatusState,
  applyPendingAck,
  capStatusLines,
  classifyStatus,
  createStatusState,
  expirePendingRequest,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  INTERRUPT_ACK_TIMEOUT_MS,
  loadStatusConfig,
  markPendingRequest,
  observeStatus,
  type PendingControlRequest,
  parseStatusConfig,
} from '../pi-extension/subagents/status.ts'
import {
  decideReplyDelivery,
  exitSidecarPayload,
  findLastStopReason,
  findLatestAssistantError,
  interruptAckPayload,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
} from '../pi-extension/subagents/subagent-done.ts'

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'subagents-test-'))
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, 'test-session.jsonl')
  const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
  writeFileSync(file, content)
  return file
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir()
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = []
  const registeredCommands: Array<any> = []
  const registeredMessageRenderers: Array<any> = []
  const sentUserMessages: string[] = []
  const sentMessages: Array<any> = []
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool)
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command })
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer })
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message)
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options })
      },
      getAllTools() {
        return []
      },
    } as any,
  }
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now
  Date.now = () => now
  try {
    return fn()
  } finally {
    Date.now = originalNow
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = 'You are a test agent.',
) {
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  )
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string
    projectAgentsDir: string
    globalDir: string
    globalAgentsDir: string
  }) => Promise<void> | void,
) {
  const root = createTestDir()
  const previousCwd = process.cwd()
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const projectDir = join(root, 'project')
  const projectAgentsDir = join(projectDir, '.pi', 'agents')
  const globalDir = join(root, 'global')
  const globalAgentsDir = join(globalDir, 'agents')

  mkdirSync(projectAgentsDir, { recursive: true })
  mkdirSync(globalAgentsDir, { recursive: true })
  process.chdir(projectDir)
  process.env.PI_CODING_AGENT_DIR = globalDir

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir })
  } finally {
    process.chdir(previousCwd)
    restoreEnvVar('PI_CODING_AGENT_DIR', previousAgentDir)
    rmSync(root, { recursive: true, force: true })
  }
}
const SESSION_HEADER = { type: 'session', id: 'sess-001', version: 3 }
const MODEL_CHANGE = { type: 'model_change', id: 'mc-001', parentId: null }
const USER_MSG = {
  type: 'message',
  id: 'user-001',
  parentId: 'mc-001',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Hello, plan something' }],
  },
}
const ASSISTANT_MSG = {
  type: 'message',
  id: 'asst-001',
  parentId: 'user-001',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Here is my plan...' }],
  },
}
const ASSISTANT_MSG_2 = {
  type: 'message',
  id: 'asst-002',
  parentId: 'asst-001',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Updated plan with details.' },
    ],
  },
}
const TOOL_RESULT = {
  type: 'message',
  id: 'tool-001',
  parentId: 'asst-001',
  message: {
    role: 'toolResult',
    toolCallId: 'tc-001',
    toolName: 'bash',
    content: [{ type: 'text', text: 'output here' }],
  },
}

// --- Tests ---

describe('session.ts', () => {
  let dir: string

  before(() => {
    dir = createTestDir()
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('getLeafId', () => {
    it('returns last entry id', () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ])
      assert.equal(getLeafId(file), 'asst-001')
    })

    it('returns null for empty file', () => {
      const file = join(dir, 'empty.jsonl')
      writeFileSync(file, '')
      assert.equal(getLeafId(file), null)
    })
  })

  describe('getNewEntries', () => {
    it('returns entries after a given line', () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ])
      const entries = getNewEntries(file, 2)
      assert.equal(entries.length, 2)
      assert.equal(entries[0].id, 'user-001')
      assert.equal(entries[1].id, 'asst-001')
    })

    it('returns empty array when no new entries', () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE])
      const entries = getNewEntries(file, 2)
      assert.equal(entries.length, 0)
    })
  })

  describe('findLastAssistantMessage', () => {
    it('finds last assistant text', () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[]
      const text = findLastAssistantMessage(entries)
      assert.equal(text, 'Updated plan with details.')
    })

    it('skips thinking blocks, gets text only', () => {
      const entries = [ASSISTANT_MSG_2] as any[]
      const text = findLastAssistantMessage(entries)
      assert.equal(text, 'Updated plan with details.')
    })

    it('skips tool results', () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[]
      const text = findLastAssistantMessage(entries)
      assert.equal(text, 'Here is my plan...')
    })

    it('returns null when no assistant messages', () => {
      const entries = [USER_MSG] as any[]
      assert.equal(findLastAssistantMessage(entries), null)
    })

    it('returns null for empty array', () => {
      assert.equal(findLastAssistantMessage([]), null)
    })

    it('skips empty assistant messages and returns real content above', () => {
      const realMsg = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Real summary content.' }],
        },
      }
      const emptyMsg = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
        },
      }
      const entries = [realMsg, emptyMsg] as any[]
      assert.equal(findLastAssistantMessage(entries), 'Real summary content.')
    })

    it('surfaces errorMessage when last assistant ended with stopReason=error and no text', () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Investigating the bug...' }],
        },
      }
      const overloadError = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Anthropic 529 Overloaded after 3 retries',
        },
      }
      const entries = [earlierGood, overloadError] as any[]
      assert.equal(
        findLastAssistantMessage(entries),
        'Subagent error: Anthropic 529 Overloaded after 3 retries',
      )
    })

    it('prefers text content even when an error stopReason is set', () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is partial output.' }],
          stopReason: 'error',
          errorMessage: 'stream interrupted',
        },
      }
      assert.equal(
        findLastAssistantMessage([msg] as any[]),
        'Here is partial output.',
      )
    })

    it('does not invent a summary for a stop=error message with no errorMessage', () => {
      const msg = {
        type: 'message',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
        },
      }
      assert.equal(findLastAssistantMessage([msg] as any[]), null)
    })
  })

  describe('appendBranchSummary', () => {
    it('appends valid branch_summary entry', () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        USER_MSG,
        ASSISTANT_MSG,
      ])
      const id = appendBranchSummary(
        file,
        'user-001',
        'asst-001',
        'The plan was created.',
      )

      assert.ok(id, 'should return an id')
      assert.equal(typeof id, 'string')

      // Read back and verify
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      assert.equal(lines.length, 4) // 3 original + 1 summary

      const summary = JSON.parse(lines[3])
      assert.equal(summary.type, 'branch_summary')
      assert.equal(summary.id, id)
      assert.equal(summary.parentId, 'user-001')
      assert.equal(summary.fromId, 'asst-001')
      assert.equal(summary.summary, 'The plan was created.')
      assert.ok(summary.timestamp)
    })

    it('uses branchPointId as fromId fallback', () => {
      const file = createSessionFile(dir, [SESSION_HEADER])
      appendBranchSummary(file, 'branch-pt', null, 'summary')

      const lines = readFileSync(file, 'utf8').trim().split('\n')
      const summary = JSON.parse(lines[1])
      assert.equal(summary.fromId, 'branch-pt')
    })
  })

  describe('copySessionFile', () => {
    it('creates a copy with different path', () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG])
      const copyDir = join(dir, 'copies')
      mkdirSync(copyDir, { recursive: true })
      const copy = copySessionFile(file, copyDir)

      assert.notEqual(copy, file)
      assert.ok(copy.endsWith('.jsonl'))
      assert.equal(readFileSync(copy, 'utf8'), readFileSync(file, 'utf8'))
    })
  })

  describe('seedSubagentSessionFile', () => {
    it('creates a lineage-only child session with parent linkage and no copied turns', () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ])
      const childFile = join(dir, 'lineage-child.jsonl')

      seedSubagentSessionFile({
        mode: 'lineage-only',
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: '/tmp/child-cwd',
      })

      const lines = readFileSync(childFile, 'utf8').trim().split('\n')
      assert.equal(lines.length, 1)

      const header = JSON.parse(lines[0])
      assert.equal(header.type, 'session')
      assert.equal(header.parentSession, parentFile)
      assert.equal(header.cwd, '/tmp/child-cwd')
    })

    it('creates a forked child session with copied context before the triggering user turn', () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ])
      const childFile = join(dir, 'fork-child.jsonl')

      seedSubagentSessionFile({
        mode: 'fork',
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: '/tmp/fork-child-cwd',
      })

      const entries = readFileSync(childFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(entries.length, 2)
      assert.equal(entries[0].type, 'session')
      assert.equal(entries[0].parentSession, parentFile)
      assert.equal(entries[0].cwd, '/tmp/fork-child-cwd')
      assert.equal(entries[1].type, 'model_change')
      assert.equal(
        entries.some(
          (entry) =>
            entry.type === 'session' && entry.parentSession !== parentFile,
        ),
        false,
      )
      assert.equal(
        entries.some((entry) => entry.type === 'message'),
        false,
      )
    })
  })

  describe('mergeNewEntries', () => {
    it('appends new entries from source to target', () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, 'merge-source.jsonl')
      const targetFile = join(dir, 'merge-target.jsonl')
      writeFileSync(
        sourceFile,
        `${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG]
          .map((e) => JSON.stringify(e))
          .join('\n')}\n`,
      )
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join('\n') +
          '\n',
      )

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2)
      assert.equal(merged.length, 1)
      assert.equal(merged[0].id, 'asst-001')

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, 'utf8').trim().split('\n')
      assert.equal(targetLines.length, 3)
    })
  })
})

describe('status.ts', () => {
  it('parses strict config objects', () => {
    const disabled = parseStatusConfig({ status: { enabled: false } })

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    })
  })

  it('loads a valid config file', () => {
    const examplePath = fileURLToPath(
      new URL('../config.json.example', import.meta.url),
    )
    const config = loadStatusConfig(examplePath)

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    })
  })

  it('loads the shared example when local config is absent', () => {
    withTempDir((dir) => {
      const examplePath = join(dir, 'config.json.example')
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      )

      const config = loadStatusConfig(join(dir, 'config.json'), examplePath)

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      })
    })
  })

  it('fails fast for invalid config shapes', () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: 'false' } }),
      /status\.enabled must be a boolean/,
    )
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true, defaultCadenceSeconds: 60 },
        }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    )
  })

  it('reports when neither local nor shared config exists', () => {
    withTempDir((dir) => {
      assert.throws(
        () =>
          loadStatusConfig(
            join(dir, 'config.json'),
            join(dir, 'config.json.example'),
          ),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      )
    })
  })

  it('reports invalid JSON from the shared example path', () => {
    withTempDir((dir) => {
      const examplePath = join(dir, 'config.json.example')
      writeFileSync(examplePath, '{\n')

      assert.throws(
        () => loadStatusConfig(join(dir, 'config.json'), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      )
    })
  })

  it('fails on invalid local config instead of falling back to the shared example', () => {
    withTempDir((dir) => {
      const configPath = join(dir, 'config.json')
      const examplePath = join(dir, 'config.json.example')
      writeFileSync(configPath, '{\n')
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      )

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      )
    })
  })

  it('keeps a missing snapshot as starting until the fixed watchdog threshold', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(state, { snapshot: 'missing' }, 1_000)

    assert.equal(classifyStatus(state, 60_999).kind, 'starting')
    const stalled = classifyStatus(state, 61_000)
    assert.equal(stalled.kind, 'stalled')
    assert.equal(stalled.statusLabel, null)
  })

  it('classifies active snapshots without aging into stalled', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
        latestEvent: 'tool_execution_start',
      },
      5_000,
    )

    const snapshot = classifyStatus(state, 240_000)
    assert.equal(snapshot.kind, 'active')
    assert.equal(snapshot.activityLabel, 'bash')
    assert.equal(snapshot.activeDurationText, '3m')
  })

  it('classifies waiting snapshots as healthy idle without becoming stalled', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 10_000,
        sequence: 1,
        phase: 'waiting',
        waitingSince: 10_000,
        latestEvent: 'agent_end',
      },
      10_000,
    )

    const snapshot = classifyStatus(state, 240_000)
    assert.equal(snapshot.kind, 'waiting')
    assert.equal(snapshot.waitingDurationText, '3m')
  })

  it('uses elapsed-only fallback for claude-backed subagents', () => {
    const state = createStatusState({ source: 'claude', startTimeMs: 0 })
    const snapshot = classifyStatus(state, 125_000)

    assert.equal(snapshot.kind, 'running')
    assert.equal(snapshot.elapsedText, '2m')
  })

  it('detects stalled transitions and recovery', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(state, { snapshot: 'missing' }, 1_000)

    let advanced = advanceStatusState(state, 95_000)
    assert.equal(advanced.transition, 'stalled')
    assert.equal(advanced.snapshot.kind, 'stalled')

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: 'present',
        updatedAt: 96_000,
        sequence: 1,
        phase: 'waiting',
        waitingSince: 96_000,
        latestEvent: 'agent_end',
      },
      96_000,
    )
    advanced = advanceStatusState(state, 97_000)
    assert.equal(advanced.transition, 'recovered')
    assert.equal(advanced.snapshot.kind, 'waiting')
  })

  it('keeps the last healthy kind during transient snapshot loss', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'streaming',
        activeSince: 5_000,
      },
      5_000,
    )
    state = advanceStatusState(state, 6_000).nextState
    state = observeStatus(state, { snapshot: 'missing' }, 10_000)

    const snapshot = classifyStatus(state, 20_000)
    assert.equal(snapshot.kind, 'active')
    assert.equal(snapshot.statusLabel, null)
  })

  it('forces an active state to waiting after interrupt', () => {
    const now = 20_000
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      5_000,
    )

    assert.equal(classifyStatus(state, now).kind, 'active')

    const forced = forceStatusAfterInterrupt(state, now)
    const snapshot = classifyStatus(forced, now)

    assert.equal(snapshot.kind, 'waiting')
    assert.equal(snapshot.activityLabel, 'interrupted')
    assert.equal(snapshot.waitingDurationText, '0s')
    assert.equal(forced.activeNow, false)
  })

  it('orders same-millisecond snapshots by sequence', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 10_000,
        sequence: 2,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 10_000,
        activityLabel: 'bash',
      },
      10_000,
    )

    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 10_000,
        sequence: 3,
        phase: 'waiting',
        waitingSince: 10_000,
        latestEvent: 'agent_end',
      },
      10_001,
    )

    const snapshot = classifyStatus(state, 11_000)
    assert.equal(snapshot.kind, 'waiting')
    assert.equal(snapshot.latestEvent, 'agent_end')
  })

  it('recovers from a transient snapshot read failure with the same valid snapshot', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 2,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      5_000,
    )
    state = observeStatus(state, { snapshot: 'missing' }, 10_000)
    assert.equal(classifyStatus(state, 10_000).statusLabel, null)

    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 2,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      11_000,
    )

    const snapshot = classifyStatus(state, 11_000)
    assert.equal(snapshot.kind, 'active')
    assert.equal(snapshot.statusLabel, null)
  })

  it('ignores stale and exact old snapshots after interrupt and accepts newer snapshots', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      5_000,
    )
    state = forceStatusAfterInterrupt(state, 20_000)

    const stale = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      21_000,
    )
    let snapshot = classifyStatus(stale, 21_000)
    assert.equal(snapshot.kind, 'waiting')
    assert.equal(snapshot.activityLabel, 'interrupted')

    const sameTimestamp = observeStatus(
      stale,
      {
        snapshot: 'present',
        updatedAt: 20_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 20_000,
        activityLabel: 'bash',
      },
      22_000,
    )
    snapshot = classifyStatus(sameTimestamp, 22_000)
    assert.equal(snapshot.kind, 'waiting')
    assert.equal(snapshot.activityLabel, 'interrupted')

    const resumed = observeStatus(
      sameTimestamp,
      {
        snapshot: 'present',
        sequence: 2,
        updatedAt: 25_000,
        phase: 'active',
        active: true,
        activeScope: 'streaming',
        activeSince: 25_000,
        activityLabel: 'streaming',
      },
      25_000,
    )
    snapshot = classifyStatus(resumed, 25_000)
    assert.equal(snapshot.kind, 'active')
    assert.equal(resumed.activeScope, 'streaming')
  })

  it('normalizes and truncates long newline-heavy names', () => {
    const longName = `Worker\n\n${'very-long-name-'.repeat(12)}`
    const stalledState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      { snapshot: 'missing' },
      1_000,
    )
    const activeState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      {
        snapshot: 'present',
        updatedAt: 299_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 299_000,
        activityLabel: 'write',
      },
      299_000,
    )
    const line = formatStatusLine(
      longName,
      classifyStatus(stalledState, 240_000),
    )
    const recovered = formatTransitionLine(
      longName,
      classifyStatus(activeState, 300_000),
      'recovered',
    )

    assert.doesNotMatch(line, /\n/)
    assert.doesNotMatch(recovered, /\n/)
    assert.ok(
      line.length <= 120,
      `expected bounded line length, got ${line.length}`,
    )
    assert.ok(
      recovered.length <= 120,
      `expected bounded line length, got ${recovered.length}`,
    )
  })

  it('caps visible status lines and reports overflow consistently', () => {
    const waitingState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      {
        snapshot: 'present',
        updatedAt: 180_000,
        sequence: 1,
        phase: 'waiting',
        waitingSince: 180_000,
      },
      180_000,
    )
    const activeState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      {
        snapshot: 'present',
        updatedAt: 419_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 419_000,
        activityLabel: 'bash',
      },
      419_000,
    )
    const waitingLine = formatStatusLine(
      'Worker',
      classifyStatus(waitingState, 300_000),
    )
    const recoveredLine = formatTransitionLine(
      'Worker',
      classifyStatus(activeState, 420_000),
      'recovered',
    )
    const lines = [
      waitingLine,
      recoveredLine,
      'Scout running 2m.',
      'Reviewer running 4m.',
      'Planner running 6m.',
    ]
    const capped = capStatusLines(lines, 3)
    const aggregate = formatStatusAggregate(lines, 3)

    assert.equal(waitingLine, 'Worker running 5m, waiting 2m.')
    assert.equal(
      recoveredLine,
      'Worker running 7m, recovered; active (bash 1s).',
    )
    assert.deepEqual(capped.visibleLines, [
      waitingLine,
      recoveredLine,
      'Scout running 2m.',
    ])
    assert.equal(capped.overflow, 2)
    assert.match(aggregate, /^Subagent status:/)
    assert.match(aggregate, /\+2 more running\./)
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/)
  })
})

describe('subagent discovery', () => {
  const testApi = (subagentsModule as any).__test__

  it('loads session-mode from frontmatter', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'lineage-mode-test-agent',
        [
          'name: lineage-mode-test-agent',
          'model: anthropic/test-lineage',
          'session-mode: lineage-only',
        ].join('\n'),
      )

      const loaded = testApi.loadAgentDefaults('lineage-mode-test-agent')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.sessionMode, 'lineage-only')
    })
  })

  it('loads explicit interactive flag from frontmatter', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'interactive-true-test-agent',
        [
          'name: interactive-true-test-agent',
          'model: anthropic/test-interactive-true',
          'interactive: true',
        ].join('\n'),
      )
      writeAgentFile(
        projectAgentsDir,
        'interactive-false-test-agent',
        [
          'name: interactive-false-test-agent',
          'model: anthropic/test-interactive-false',
          'interactive: false',
        ].join('\n'),
      )

      const loadedTrue = testApi.loadAgentDefaults(
        'interactive-true-test-agent',
      )
      assert.equal(loadedTrue?.interactive, true)

      const loadedFalse = testApi.loadAgentDefaults(
        'interactive-false-test-agent',
      )
      assert.equal(loadedFalse?.interactive, false)
    })
  })

  it('leaves interactive undefined when not set in frontmatter', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'interactive-unset-test-agent',
        [
          'name: interactive-unset-test-agent',
          'model: anthropic/test-interactive-unset',
        ].join('\n'),
      )

      const loaded = testApi.loadAgentDefaults('interactive-unset-test-agent')
      assert.equal(loaded?.interactive, undefined)
    })
  })

  it('resolveEffectiveInteractive defaults to the inverse of auto-exit', () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T' },
        { autoExit: true },
      ),
      false,
    )
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T' },
        { autoExit: false },
      ),
      true,
    )
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: 'A', task: 'T' }, {}),
      true,
    )
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: 'A', task: 'T' }, null),
      true,
    )
  })

  it('resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default', () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T' },
        { autoExit: true, interactive: true },
      ),
      true,
    )
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T' },
        { interactive: false },
      ),
      false,
    )
  })

  it('resolveEffectiveInteractive honors the explicit tool parameter over all else', () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T', interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    )
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'A', task: 'T', interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    )
  })

  it('bundled scout/worker/reviewer agents resolve as non-interactive; planner resolves as interactive', () => {
    for (const name of ['scout', 'worker', 'reviewer']) {
      const defs = testApi.loadAgentDefaults(name)
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`)
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: '' }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      )
    }

    const planner = testApi.loadAgentDefaults('planner')
    assert.ok(planner, 'expected bundled planner to be discoverable')
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: 'planner', task: '' },
        planner,
      ),
      true,
      'planner should resolve as interactive (no auto-exit)',
    )
  })

  it('ignores invalid session-mode values', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'invalid-mode-test-agent',
        [
          'name: invalid-mode-test-agent',
          'model: anthropic/test-invalid',
          'session-mode: sideways',
        ].join('\n'),
      )

      const loaded = testApi.loadAgentDefaults('invalid-mode-test-agent')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.sessionMode, undefined)
    })
  })

  it('resolves session mode with fork override precedence', () => {
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: 'A', task: 'T' }, null),
      'standalone',
    )
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: 'A', task: 'T' },
        { sessionMode: 'lineage-only' },
      ),
      'lineage-only',
    )
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: 'A', task: 'T', fork: true },
        { sessionMode: 'lineage-only' },
      ),
      'fork',
    )
  })

  it('resolves launch behavior for standalone, lineage-only, and fork modes', () => {
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: 'A', task: 'T' }, null),
      {
        sessionMode: 'standalone',
        seededSessionMode: null,
        inheritsConversationContext: false,
        taskDelivery: 'artifact',
      },
    )
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: 'A', task: 'T' },
        { sessionMode: 'lineage-only' },
      ),
      {
        sessionMode: 'lineage-only',
        seededSessionMode: 'lineage-only',
        inheritsConversationContext: false,
        taskDelivery: 'artifact',
      },
    )
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: 'A', task: 'T' },
        { sessionMode: 'fork' },
      ),
      {
        sessionMode: 'fork',
        seededSessionMode: 'fork',
        inheritsConversationContext: true,
        taskDelivery: 'direct',
      },
    )
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: 'A', task: 'T', fork: true },
        { sessionMode: 'lineage-only' },
      ),
      {
        sessionMode: 'fork',
        seededSessionMode: 'fork',
        inheritsConversationContext: true,
        taskDelivery: 'direct',
      },
    )
  })

  it('buildSubagentToolAllowlist preserves requested tools and adds child control tools', () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist('read,bash,web_search'),
      'read,bash,web_search,caller_ping,subagent_done',
    )
  })

  it('buildSubagentToolAllowlist returns null without an explicit tool restriction', () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null)
    assert.equal(testApi.buildSubagentToolAllowlist(''), null)
  })

  it('buildPiPromptArgs inserts separator for artifact-backed launches with skills', () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: 'review,lint',
        taskDelivery: 'artifact',
        taskArg: '@artifact.md',
      }),
      ['', '/skill:review', '/skill:lint', '@artifact.md'],
    )
  })

  it('buildPiPromptArgs omits separator for artifact-backed launches without skills', () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: 'artifact',
        taskArg: '@artifact.md',
      }),
      ['@artifact.md'],
    )
  })

  it('buildPiPromptArgs omits separator for direct launches with skills', () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: 'review',
        taskDelivery: 'direct',
        taskArg: 'do the task',
      }),
      ['/skill:review', 'do the task'],
    )
  })

  it('lists visible agents from discovery', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'visible-discovery-test-agent',
        [
          'name: visible-discovery-test-agent',
          'description: Visible test agent',
          'model: anthropic/test-visible',
        ].join('\n'),
      )

      const { api, registeredTools } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)

      const tool = registeredTools.find(
        (tool) => tool.name === 'subagents_list',
      )
      assert.ok(tool, 'expected subagents_list to be registered')

      const result = await tool.execute()
      const agents = result.details?.agents ?? []

      assert.ok(
        agents.some(
          (agent: any) => agent.name === 'visible-discovery-test-agent',
        ),
      )
      assert.match(result.content[0].text, /visible-discovery-test-agent/)
    })
  })

  it('hides disable-model-invocation agents from listings but keeps direct loading', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'hidden-discovery-test-agent',
        [
          'name: hidden-discovery-test-agent',
          'description: Hidden test agent',
          'model: anthropic/test-hidden',
          'disable-model-invocation: true',
        ].join('\n'),
        'You are the hidden agent.',
      )

      const { api, registeredTools } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)

      const tool = registeredTools.find(
        (tool) => tool.name === 'subagents_list',
      )
      assert.ok(tool, 'expected subagents_list to be registered')

      const result = await tool.execute()
      const agents = result.details?.agents ?? []

      assert.equal(
        agents.some(
          (agent: any) => agent.name === 'hidden-discovery-test-agent',
        ),
        false,
      )
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/)

      const loaded = testApi.loadAgentDefaults('hidden-discovery-test-agent')
      assert.ok(loaded, 'expected hidden agent to remain directly loadable')
      assert.equal(loaded.model, 'anthropic/test-hidden')
      assert.equal(loaded.body, 'You are the hidden agent.')
      assert.equal(loaded.disableModelInvocation, true)
    })
  })

  it('lets a hidden project agent shadow a visible global agent', async () => {
    await withIsolatedAgentEnv(
      async ({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          'shadowed-discovery-test-agent',
          [
            'name: shadowed-discovery-test-agent',
            'description: Global visible agent',
            'model: anthropic/test-global',
          ].join('\n'),
          'You are the global visible agent.',
        )
        writeAgentFile(
          projectAgentsDir,
          'shadowed-discovery-test-agent',
          [
            'name: shadowed-discovery-test-agent',
            'description: Project hidden agent',
            'model: anthropic/test-project',
            'disable-model-invocation: true',
          ].join('\n'),
          'You are the project hidden agent.',
        )

        const { api, registeredTools } = createMockExtensionApi()
        ;(subagentsModule as any).default(api)

        const tool = registeredTools.find(
          (tool) => tool.name === 'subagents_list',
        )
        assert.ok(tool, 'expected subagents_list to be registered')

        const result = await tool.execute()
        const agents = result.details?.agents ?? []

        assert.equal(
          agents.some(
            (agent: any) => agent.name === 'shadowed-discovery-test-agent',
          ),
          false,
        )
        assert.doesNotMatch(
          result.content[0].text,
          /shadowed-discovery-test-agent/,
        )

        const loaded = testApi.loadAgentDefaults(
          'shadowed-discovery-test-agent',
        )
        assert.ok(
          loaded,
          'expected project override to remain directly loadable',
        )
        assert.equal(loaded.model, 'anthropic/test-project')
        assert.equal(loaded.body, 'You are the project hidden agent.')
        assert.equal(loaded.disableModelInvocation, true)
      },
    )
  })
})
describe('subagent-done.ts', () => {
  describe('shouldMarkUserTookOver', () => {
    it('ignores the initial injected task before the first agent run', () => {
      assert.equal(shouldMarkUserTookOver(false), false)
    })

    it('treats later input as manual takeover', () => {
      assert.equal(shouldMarkUserTookOver(true), true)
    })
  })

  describe('shouldAutoExitOnAgentEnd', () => {
    it('auto-exits after normal completion when there was no takeover', () => {
      const messages = [{ role: 'assistant', stopReason: 'stop' }]
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true)
    })

    it('auto-exits after normal completion even when the user sent the prompt', () => {
      const messages = [{ role: 'assistant', stopReason: 'stop' }]
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true)
    })

    it('stays open after Escape aborts the run', () => {
      const messages = [{ role: 'assistant', stopReason: 'aborted' }]
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false)
    })

    it('still exits when the latest turn ended with stopReason=error', () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '529 overloaded',
        },
      ]
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true)
    })
  })

  describe('findLatestAssistantError', () => {
    it('returns the error info from a stopReason=error message', () => {
      const messages = [
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'ok' }],
        },
        { role: 'toolResult', content: [] },
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Anthropic 529 Overloaded',
        },
      ]
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: 'Anthropic 529 Overloaded',
        stopReason: 'error',
      })
    })

    it('returns null when the latest assistant turn completed normally', () => {
      const messages = [
        { role: 'assistant', stopReason: 'error', errorMessage: 'old failure' },
        { role: 'user', content: [] },
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'done' }],
        },
      ]
      assert.equal(findLatestAssistantError(messages), null)
    })

    it('returns null when the latest assistant turn was aborted by the user', () => {
      const messages = [{ role: 'assistant', stopReason: 'aborted' }]
      assert.equal(findLatestAssistantError(messages), null)
    })

    it('falls back to a placeholder when stopReason=error has no errorMessage field', () => {
      const messages = [{ role: 'assistant', stopReason: 'error' }]
      const info = findLatestAssistantError(messages)
      assert.ok(info)
      assert.equal(info?.stopReason, 'error')
      assert.match(info?.errorMessage, /stopReason=error/)
    })

    it('returns null when messages is undefined or empty', () => {
      assert.equal(findLatestAssistantError(undefined), null)
      assert.equal(findLatestAssistantError([]), null)
    })
  })

  describe('exitSidecarPayload', () => {
    // Regression: clean auto-exits must write a {type:'done'} sidecar.
    // Previously only errors wrote one, so completion detection relied on
    // scraping the pane's last 5 visible rows — the post-exit prompt pushed
    // the __SUBAGENT_DONE_ sentinel out of that window and the parent was
    // never woken.
    it('writes done for a clean completion', () => {
      assert.deepEqual(
        exitSidecarPayload([{ role: 'assistant', stopReason: 'stop' }]),
        { type: 'done' },
      )
      assert.deepEqual(exitSidecarPayload(undefined), { type: 'done' })
    })

    it('writes error detail for stopReason=error turns', () => {
      assert.deepEqual(
        exitSidecarPayload([
          { role: 'assistant', stopReason: 'error', errorMessage: '529' },
        ]),
        { type: 'error', errorMessage: '529', stopReason: 'error' },
      )
    })
  })
})

describe('surface.ts interpretExitSidecar', () => {
  const { interpretExitSidecar } = __pollForExitTest__

  it('decodes ping payloads', () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: 'ping',
        name: 'Worker',
        message: 'need help',
      }),
      {
        reason: 'ping',
        exitCode: 0,
        ping: { name: 'Worker', message: 'need help' },
      },
    )
  })

  it('decodes done payloads', () => {
    assert.deepEqual(interpretExitSidecar({ type: 'done' }), {
      reason: 'done',
      exitCode: 0,
    })
  })

  it('decodes error payloads and propagates the message with a non-zero exit code', () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: 'error',
        errorMessage: 'Anthropic 529 Overloaded after 3 retries',
        stopReason: 'error',
      }),
      {
        reason: 'error',
        exitCode: 1,
        errorMessage: 'Anthropic 529 Overloaded after 3 retries',
      },
    )
  })

  it('falls back to a placeholder when error payload has no errorMessage', () => {
    const result = interpretExitSidecar({ type: 'error' })
    assert.equal(result.reason, 'error')
    assert.equal(result.exitCode, 1)
    assert.match(result.errorMessage ?? '', /no errorMessage/)
  })

  it('treats unknown payload shapes as done', () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: 'done', exitCode: 0 })
    assert.deepEqual(interpretExitSidecar(null), {
      reason: 'done',
      exitCode: 0,
    })
  })
})
describe('commands', () => {
  it('/iterate always emits a full-context fork tool call', () => {
    const { api, registeredCommands, sentUserMessages } =
      createMockExtensionApi()

    ;(subagentsModule as any).default(api)

    const iterate = registeredCommands.find(
      (command) => command.name === 'iterate',
    )
    assert.ok(iterate, 'expected /iterate to be registered')

    iterate.handler('Fix the bug', {})

    assert.equal(sentUserMessages.length, 1)
    assert.match(sentUserMessages[0], /fork: true/)
    assert.match(sentUserMessages[0], /name: "Iterate"/)
  })
})

describe('tool registration', () => {
  it('defaults resumed subagents to auto-exit and non-interactive tracking', () => {
    const testApi = (subagentsModule as any).__test__

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    })
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    })
  })

  it('expands spawning false to deny subagent interruption', () => {
    const testApi = (subagentsModule as any).__test__
    const denied = testApi.resolveDenyTools({ spawning: false })

    assert.equal(denied.has('subagent'), true)
    assert.equal(denied.has('subagent_interrupt'), true)
    assert.equal(denied.has('subagent_resume'), true)
  })

  it('renders partial subagent tool-call args without throwing', () => {
    const { api, registeredTools } = createMockExtensionApi()
    ;(subagentsModule as any).default(api)

    const subagentTool = registeredTools.find(
      (tool) => tool.name === 'subagent',
    )
    assert.ok(subagentTool, 'expected subagent tool to be registered')

    const theme = {
      fg(_color: string, text: string) {
        return text
      },
      bold(text: string) {
        return text
      },
    }
    const rendered = subagentTool.renderCall({}, theme)
    const output = rendered.render(80).join('\n')

    assert.match(output, /\(unnamed\)/)
  })

  it('registers subagent_resume with an autoExit override', () => {
    const { api, registeredTools } = createMockExtensionApi()
    ;(subagentsModule as any).default(api)

    const resumeTool = registeredTools.find(
      (tool) => tool.name === 'subagent_resume',
    )
    assert.ok(resumeTool, 'expected subagent_resume tool to be registered')

    const autoExitSchema = resumeTool.parameters.properties.autoExit
    assert.equal(autoExitSchema.type, 'boolean')
    assert.match(autoExitSchema.description, /Defaults to true/)
  })
})

describe('subagent activity snapshots', () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: 'child-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: 'session_start',
      phase: 'starting',
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    }
  }

  it('writes and validates activity files by running child id', () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, 'child-1')
      const recorder = createSubagentActivityRecorder({
        runningChildId: 'child-1',
        activityFile,
        now: () => 1_000,
      })

      recorder.sessionStart()
      recorder.toolExecutionStart('tool-1', 'bash')

      const read = readSubagentActivityFile(activityFile, 'child-1')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'active')
      assert.equal(read.activity.activeScope, 'tool')
      assert.equal(read.activity.toolName, 'bash')

      assert.deepEqual(readSubagentActivityFile(activityFile, 'other-child'), {
        ok: false,
        reason: 'wrong-id',
      })
    })
  })

  it('records waiting and final done states', () => {
    withTempDir((dir) => {
      let currentNow = 2_000
      const activityFile = getSubagentActivityFile(dir, 'child-2')
      const recorder = createSubagentActivityRecorder({
        runningChildId: 'child-2',
        activityFile,
        now: () => currentNow,
      })

      recorder.sessionStart()
      currentNow = 3_000
      recorder.agentEndWaiting()
      let read = readSubagentActivityFile(activityFile, 'child-2')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'waiting')
      assert.equal(read.activity.waitingSince, 3_000)

      currentNow = 4_000
      recorder.subagentDone()
      read = readSubagentActivityFile(activityFile, 'child-2')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'done')
      assert.equal(read.activity.agentActive, false)
    })
  })

  it('rejects malformed activity fields used by classification and rendering', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'subagent-activity'), { recursive: true })
      const cases = [
        { activeSince: 'bad' },
        { waitingSince: 'bad' },
        { activeScope: 'database' },
        { latestEvent: 'unknown' },
        { runningChildId: 42 },
        { toolActive: 'yes' },
        { toolName: 'bad\nname' },
      ]

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`)
        const activity = validActivity({
          runningChildId: `child-${index}`,
          ...overrides,
        })
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`)

        const read = readSubagentActivityFile(activityFile, `child-${index}`)
        assert.equal(read.ok, false)
        assert.equal((read as { ok: false; reason: string }).reason, 'invalid')
      }
    })
  })

  it('does not let tool_result resurrect finished tool activity', () => {
    withTempDir((dir) => {
      let currentNow = 1_000
      const activityFile = getSubagentActivityFile(dir, 'child-3')
      const recorder = createSubagentActivityRecorder({
        runningChildId: 'child-3',
        activityFile,
        now: () => currentNow,
      })

      recorder.sessionStart()
      recorder.agentStart()
      recorder.turnStart(1)
      currentNow = 2_000
      recorder.toolExecutionStart('tool-1', 'bash')
      currentNow = 3_000
      recorder.toolExecutionEnd('tool-1', 'bash')
      currentNow = 4_000
      recorder.toolResult('tool-1', 'bash')

      const read = readSubagentActivityFile(activityFile, 'child-3')
      assert.ok(read.ok)
      assert.equal(read.activity.toolActive, false)
      assert.equal(read.activity.activeScope, 'turn')
    })
  })

  it('does not mark reload shutdown as the final done snapshot', () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, 'child-4')
      const recorder = createSubagentActivityRecorder({
        runningChildId: 'child-4',
        activityFile,
        now: () => 1_000,
      })

      recorder.sessionStart()
      recorder.sessionShutdown('reload')

      const read = readSubagentActivityFile(activityFile, 'child-4')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'starting')
      assert.equal(read.activity.latestEvent, 'session_start')
    })
  })

  it('cancels pending throttled writes on reload shutdown', async () => {
    const dir = createTestDir()
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000
        const activityFile = getSubagentActivityFile(dir, 'child-5')
        const recorder = createSubagentActivityRecorder({
          runningChildId: 'child-5',
          activityFile,
          now: () => currentNow,
        })

        recorder.sessionStart()
        currentNow = 1_100
        recorder.messageUpdate('delta')
        recorder.sessionShutdown('reload')

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, 'child-5')
          assert.ok(read.ok)
          assert.equal(read.activity.phase, 'starting')
          assert.equal(read.activity.latestEvent, 'session_start')
          resolve()
        }, 650)
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('subagent interruption', () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: 'a1',
      name: 'Worker',
      task: '',
      surface: 'pane-1',
      startTime: 0,
      sessionFile: 'worker.jsonl',
      interactive: false,
      statusState: createStatusState({ source: 'pi', startTimeMs: 0 }),
      ...overrides,
    }
  }

  it('registers subagent_interrupt in the main session extension', () => {
    const { api, registeredTools } = createMockExtensionApi()

    ;(subagentsModule as any).default(api)

    assert.equal(
      registeredTools.some((tool) => tool.name === 'subagent_interrupt'),
      true,
    )
  })

  it('resolves interrupt targets by exact id and reports name ambiguity', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    runningMap.clear()

    try {
      runningMap.set(
        'a1',
        makeRunning({
          id: 'a1',
          name: 'Worker',
          surface: 'a1',
          sessionFile: 'a1.jsonl',
        }),
      )
      runningMap.set(
        'b2',
        makeRunning({
          id: 'b2',
          name: 'Worker',
          surface: 'b2',
          sessionFile: 'b2.jsonl',
        }),
      )
      runningMap.set(
        'c3',
        makeRunning({
          id: 'c3',
          name: 'Scout',
          surface: 'c3',
          sessionFile: 'c3.jsonl',
        }),
      )

      const byId = testApi.resolveInterruptTarget({ id: 'c3', name: 'Worker' })
      assert.equal(byId.running.id, 'c3')

      const ambiguous = testApi.resolveInterruptTarget({ name: 'Worker' })
      assert.match(ambiguous.error, /Ambiguous subagent name/)
    } finally {
      runningMap.clear()
    }
  })

  it('returns an explicit error when Escape delivery fails', () => {
    const testApi = (subagentsModule as any).__test__
    let aborted = false
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true
        },
      },
    })

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error('mux write failed')
    })

    assert.match(result.error, /Failed to send Escape/)
    assert.equal(aborted, false)
    assert.equal('interruptRequested' in running, false)
  })

  it('leaves status unchanged when Escape delivery fails in the tool path', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    runningMap.clear()

    const activeState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      5_000,
    )

    try {
      runningMap.set('a1', makeRunning({ statusState: activeState }))

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentInterrupt({ name: 'Worker' }, () => {
          throw new Error('mux write failed')
        }),
      )

      assert.match(result.content[0].text, /Failed to send Escape/)
      assert.equal(
        classifyStatus(runningMap.get('a1').statusState, 20_000).kind,
        'active',
      )
    } finally {
      runningMap.clear()
    }
  })

  it('sends Escape without aborting or mutating running state', () => {
    const testApi = (subagentsModule as any).__test__
    let aborted = false
    let sentSurface = ''
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true
        },
      },
    })

    const result = testApi.requestSubagentInterrupt(
      running,
      (surface: string) => {
        sentSurface = surface
      },
    )

    assert.deepEqual(result, { ok: true })
    assert.equal(sentSurface, 'pane-1')
    assert.equal(aborted, false)
    assert.equal('interruptRequested' in running, false)
  })

  it('refreshes the latest activity snapshot before forcing local interrupt waiting', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sentSurface = ''
    runningMap.clear()

    withTempDir((dir) => {
      mkdirSync(join(dir, 'subagent-activity'), { recursive: true })
      const activityFile = getSubagentActivityFile(dir, 'a1')
      const activity = {
        version: 1,
        runningChildId: 'a1',
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: 'tool_execution_start',
        phase: 'active',
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: 'tool',
        activeSince: 19_000,
        toolName: 'bash',
      }
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`)

      try {
        runningMap.set(
          'a1',
          makeRunning({
            activityFile,
            statusState: createStatusState({ source: 'pi', startTimeMs: 0 }),
          }),
        )

        withMockedNow(20_000, () =>
          testApi.handleSubagentInterrupt(
            { name: 'Worker' },
            (surface: string) => {
              sentSurface = surface
            },
          ),
        )

        assert.equal(sentSurface, 'pane-1')
        const state = runningMap.get('a1').statusState
        const snapshot = classifyStatus(state, 20_000)
        assert.equal(snapshot.kind, 'waiting')
        assert.equal(snapshot.activityLabel, 'interrupted')
        assert.equal(state.lastActivityAtMs, 20_000)
        assert.equal(state.lastActivitySequence, 7)
        assert.equal(state.localOverrideSequence, 7)
      } finally {
        runningMap.clear()
      }
    })
  })

  it('acknowledges Pi-backed interrupt requests and forces local status waiting', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sentSurface = ''
    runningMap.clear()

    const activeState = observeStatus(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
      },
      5_000,
    )

    try {
      runningMap.set('a1', makeRunning({ statusState: activeState }))

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentInterrupt(
          { name: 'Worker' },
          (surface: string) => {
            sentSurface = surface
          },
        ),
      )

      assert.equal(sentSurface, 'pane-1')
      assert.equal(
        result.content[0].text,
        'Interrupt requested for subagent "Worker". Awaiting child acknowledgement.',
      )
      assert.equal(result.details.ack, 'pending')
      assert.equal(result.details.status, 'interrupt_requested')
      assert.equal(result.details.id, 'a1')
      assert.equal(result.details.name, 'Worker')
      const snapshot = classifyStatus(runningMap.get('a1').statusState, 20_000)
      assert.equal(snapshot.kind, 'waiting')
      assert.equal(snapshot.activityLabel, 'interrupted')
      assert.equal(runningMap.has('a1'), true)
    } finally {
      runningMap.clear()
    }
  })

  it('sends Escape again for repeated interrupt requests', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    const surfaces: string[] = []
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())

      testApi.handleSubagentInterrupt({ name: 'Worker' }, (surface: string) => {
        surfaces.push(surface)
      })
      testApi.handleSubagentInterrupt({ name: 'Worker' }, (surface: string) => {
        surfaces.push(surface)
      })

      assert.deepEqual(surfaces, ['pane-1', 'pane-1'])
      assert.equal(runningMap.has('a1'), true)
    } finally {
      runningMap.clear()
    }
  })

  it('rejects Claude-backed interrupt requests before delivery', () => {
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let delivered = false
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning({ cli: 'claude' }))

      const result = testApi.handleSubagentInterrupt({ name: 'Worker' }, () => {
        delivered = true
      })

      assert.equal(delivered, false)
      assert.match(
        result.content[0].text,
        /currently supported only for Pi-backed subagents/i,
      )
      assert.deepEqual(result.details, {
        error: 'claude interrupt unsupported',
        id: 'a1',
        name: 'Worker',
      })
    } finally {
      runningMap.clear()
    }
  })

  it('formats exit code 130 as an ordinary failure', () => {
    const testApi = (subagentsModule as any).__test__
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: 'Sub-agent exited with code 130',
        sessionFile: '/tmp/subagent.jsonl',
      },
      'Worker',
    )

    assert.match(presentation, /failed \(exit code 130\)/)
    assert.doesNotMatch(presentation, /interrupted/)
    assert.match(presentation, /Resume: pi --session/)
  })

  it('renders a clear provider/agent error when errorMessage is set', () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: 'ignored when errorMessage is present',
        sessionFile: '/tmp/subagent.jsonl',
        errorMessage: 'Anthropic 529 Overloaded after 3 retries',
      },
      'Worker',
    )

    assert.match(presentation, /Sub-agent "Worker" failed/)
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/)
    assert.match(
      presentation,
      /Error: Anthropic 529 Overloaded after 3 retries/,
    )
    assert.match(presentation, /subagent_resume/)
    assert.match(presentation, /Resume: pi --session/)
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/)
  })
})

describe('subagent status renderer', () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text
      },
      bg(_color: string, text: string) {
        return text
      },
      bold(text: string) {
        return text
      },
    }
  }

  it('renders only capped lines plus overflow', () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi()
    ;(subagentsModule as any).default(api)

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === 'subagent_status',
    )
    assert.ok(
      rendererEntry,
      'expected subagent_status renderer to be registered',
    )

    const visibleLines = [
      'Worker running 5m, active (bash 2m).',
      'Scout running 3m, waiting 1m.',
      'Reviewer running 2m, active (streaming 30s).',
      'Planner running 4m, waiting 2m.',
    ]
    const rendered = rendererEntry.renderer(
      {
        customType: 'subagent_status',
        content: 'Subagent status:\n• Worker running 5m, active (bash 2m).',
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    )
    const output = rendered.render(80).join('\n')

    assert.match(output, /Subagent status/)
    for (const line of visibleLines) {
      assert.match(
        output,
        new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
    }
    assert.match(output, /\+2 more running\./)
  })

  it('stays within narrow widths', () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi()
    ;(subagentsModule as any).default(api)

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === 'subagent_status',
    )
    assert.ok(
      rendererEntry,
      'expected subagent_status renderer to be registered',
    )

    const rendered = rendererEntry.renderer(
      {
        customType: 'subagent_status',
        content: 'Subagent status:\n• Worker running 5m, active (bash 2m).',
        details: {
          lines: ['Worker running 5m, active (bash 2m).'],
          overflow: 0,
        },
      },
      { expanded: true },
      createTheme(),
    )

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        )
      }
    }
  })
})

describe('plan dispatch', () => {
  describe('classifyPlanArg', () => {
    it('routes everything to the aven planner (aven-first dispatch)', () => {
      assert.equal(subagentsModule.classifyPlanArg('IMP-7070'), 'aven')
      assert.equal(subagentsModule.classifyPlanArg('DP-92 fix login'), 'aven')
      assert.equal(subagentsModule.classifyPlanArg('add dark mode'), 'aven')
      assert.equal(subagentsModule.classifyPlanArg('implement x'), 'aven')
      assert.equal(subagentsModule.classifyPlanArg('imp-7070'), 'aven')
    })
  })

  describe('readPlanSkill', () => {
    it('resolves an existing skill file with content', () => {
      const r = subagentsModule.readPlanSkill('feature-plan-aven')
      assert.ok(r)
      assert.ok(existsSync(r.path))
      assert.ok(r.content.startsWith('---'))
    })

    it('returns null for a nonexistent skill', () => {
      assert.equal(
        subagentsModule.readPlanSkill('definitely-not-a-skill'),
        null,
      )
    })
  })
})

// --- Phase 0: durable foundation ---

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  DEFAULT_SUBAGENTS_CONFIG,
  globalSubagentsConfigPath,
  loadSubagentsConfig,
  projectSubagentsConfigPath,
  scaffoldGlobalSubagentsConfig,
  validateSubagentsConfig,
} from '../pi-extension/subagents/config.ts'
import {
  ensureSubagentsDataDir,
  subagentsDataRoot,
} from '../pi-extension/subagents/dataroot.ts'
import {
  acquireProcessLock,
  isProcessLockClaim,
  keyedProcessLockPath,
  type ProcessLockClaim,
  ProcessLockOccupiedError,
  readProcessLockStatus,
} from '../pi-extension/subagents/lock.ts'
import {
  type ChildIdentity,
  inboxDir,
  listLivePeers,
  peerLockPath,
  presencePath,
  publishPresence,
  readInbox,
  removeInboxEntry,
  resolvePeer,
  sendPeerMessage,
} from '../pi-extension/subagents/peers.ts'

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('dataroot.ts', () => {
  it('builds the data root under the agent dir', () => {
    assert.equal(subagentsDataRoot('/agents'), join('/agents', 'pi-subagents'))
  })

  it('creates lazily-named subdirs with 0700 and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-dataroot-'))
    const dir = ensureSubagentsDataDir('results', root)
    assert.equal(dir, join(root, 'results'))
    assert.ok(statSync(dir).isDirectory())
    assert.equal(modeOf(root), 0o700)
    assert.equal(modeOf(dir), 0o700)
    assert.equal(ensureSubagentsDataDir('results', root), dir)
  })
})

describe('config.ts', () => {
  it('validates a correct config and rejects bad shapes', () => {
    assert.deepEqual(
      validateSubagentsConfig({ status: { enabled: true } }, 't'),
      {
        status: { enabled: true },
      },
    )
    assert.throws(
      () => validateSubagentsConfig({ status: { enabled: 'yes' } }, 't'),
      /Invalid subagents config in t/,
    )
    assert.throws(
      () =>
        validateSubagentsConfig({ status: { enabled: true, extra: 1 } }, 't'),
      /Invalid subagents config in t/,
    )
    assert.throws(
      () => validateSubagentsConfig(null, 't'),
      /Invalid subagents config in t/,
    )
  })

  it('scaffolds the global config only when missing and never overwrites', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'subagents-agentdir-'))
    const path = globalSubagentsConfigPath(agentDir)
    assert.equal(scaffoldGlobalSubagentsConfig(agentDir), path)
    assert.ok(existsSync(path))
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(onDisk.status.enabled, true)
    assert.ok(typeof onDisk.$schema === 'string')

    writeFileSync(path, '{"status":{"enabled":false}}')
    scaffoldGlobalSubagentsConfig(agentDir)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      status: { enabled: false },
    })
  })

  it('falls back to the global config and defaults', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'subagents-agentdir-'))
    const cwd = mkdtempSync(join(tmpdir(), 'subagents-cwd-'))
    const loaded = loadSubagentsConfig(cwd, agentDir)
    assert.deepEqual(loaded.config, DEFAULT_SUBAGENTS_CONFIG)
    assert.equal(loaded.source, globalSubagentsConfigPath(agentDir))
  })

  it('lets the project override win and fails fast on invalid config', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'subagents-agentdir-'))
    const cwd = mkdtempSync(join(tmpdir(), 'subagents-cwd-'))
    const projectPath = projectSubagentsConfigPath(cwd)
    mkdirSync(dirname(projectPath), { recursive: true })
    writeFileSync(projectPath, '{"status":{"enabled":false}}')

    const loaded = loadSubagentsConfig(cwd, agentDir)
    assert.equal(loaded.config.status.enabled, false)
    assert.equal(loaded.source, projectPath)

    writeFileSync(projectPath, '{')
    assert.throws(
      () => loadSubagentsConfig(cwd, agentDir),
      /Invalid JSON in subagents config/,
    )
    writeFileSync(projectPath, '{"status":{"enabled":1}}')
    assert.throws(
      () => loadSubagentsConfig(cwd, agentDir),
      /Invalid subagents config/,
    )
  })
})

describe('lock.ts', () => {
  it('validates claim shape', () => {
    const claim: ProcessLockClaim = {
      pid: process.pid,
      id: 'e5a8d13e-1a2b-4c3d-9e2f-0123456789ab',
    }
    assert.ok(isProcessLockClaim(claim))
    assert.ok(!isProcessLockClaim({ pid: -1, id: claim.id }))
    assert.ok(!isProcessLockClaim({ pid: 1, id: 'not-a-uuid' }))
    assert.ok(!isProcessLockClaim(null))
  })

  it('acquires, observes, and releases a lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagents-lock-'))
    const path = join(dir, 'lock')
    const lease = acquireProcessLock(path, { name: 'test lock' })
    assert.equal(lease.claim.pid, process.pid)
    const status = readProcessLockStatus(path)
    assert.deepEqual(status.claim, lease.claim)
    assert.ok(status.live)
    lease.release()
    assert.throws(() => readProcessLockStatus(path))
  })

  it('rejects a second live claimant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagents-lock-'))
    const path = join(dir, 'lock')
    const lease = acquireProcessLock(path)
    assert.throws(
      () => acquireProcessLock(path, { name: 'test lock' }),
      ProcessLockOccupiedError,
    )
    lease.release()
    const second = acquireProcessLock(path)
    second.release()
  })

  it('takes over a stale claim from a dead pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagents-lock-'))
    const path = join(dir, 'lock')
    // Process.kill(pid=largest-possible) can't be used safely; instead write a
    // claim with a pid that cannot exist (no PID will ever be 2^22+ on Linux).
    const stale: ProcessLockClaim = {
      pid: 0x400000,
      id: 'e5a8d13e-1a2b-4c3d-9e2f-0123456789ab',
    }
    mkdirSync(path, { mode: 0o700 })
    writeFileSync(join(path, `${stale.pid}-${stale.id}`), JSON.stringify(stale))
    assert.equal(readProcessLockStatus(path).live, false)
    let removed = false
    const lease = acquireProcessLock(path, {
      afterStaleOwnerRemoved: () => {
        removed = true
      },
    })
    assert.ok(removed)
    assert.equal(lease.claim.pid, process.pid)
    lease.release()
  })

  it('derives stable keyed lock paths', () => {
    const a = keyedProcessLockPath('session:/tmp/x.jsonl')
    const b = keyedProcessLockPath('session:/tmp/x.jsonl')
    const c = keyedProcessLockPath('session:/tmp/y.jsonl')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.ok(a.startsWith(join(tmpdir(), 'pi-subagents', 'locks', 'lock-')))
  })
})

describe('store.ts durable result store', () => {
  let storeRoot: string

  before(() => {
    storeRoot = join(mkdtempSync(join(tmpdir(), 'store-')), 'pi-subagents')
  })
  after(() => {
    rmSync(storeRoot, { recursive: true, force: true })
  })

  it('writes and reads a result record atomically at the canonical path', () => {
    const written = writeResultRecord(
      {
        childId: 'child-1',
        name: 'scout',
        summary: 'found three files',
        sessionFile: '/tmp/child.jsonl',
      },
      storeRoot,
    )
    assert.ok(existsSync(written.path))
    assert.equal(written.path, resultRecordPath(written.canonicalId, storeRoot))
    assert.ok(written.path.startsWith(join(storeRoot, 'results', '')))
    const record = readResultRecord(written.path)
    assert.equal(record.canonicalId, written.canonicalId)
    assert.equal(record.name, 'scout')
    assert.equal(record.summary, 'found three files')
    assert.deepEqual(record.artifactPaths, [])
    assert.ok(record.createdAt)
    // no tmp sibling left behind
    assert.ok(
      !existsSync(join(storeRoot, 'results', `.tmp-${written.canonicalId}`)),
    )
  })

  it('rejects records above the byte ceiling (fail closed)', () => {
    assert.throws(
      () =>
        writeResultRecord(
          {
            childId: 'child-2',
            name: 'scout',
            summary: 'x'.repeat(MAX_RESULT_RECORD_BYTES + 1),
            sessionFile: null,
          },
          storeRoot,
        ),
      (err: unknown) =>
        (err as { code?: string }).code === 'RESULT_RECORD_TOO_LARGE',
    )
  })

  it('parses semantic refs strictly', () => {
    assert.deepEqual(parseSemanticRef('result:scout#3'), {
      name: 'scout',
      n: 3,
    })
    assert.equal(parseSemanticRef('result:scout'), null)
    assert.equal(parseSemanticRef('result:scout#0'), null)
    assert.equal(parseSemanticRef('result:scout#abc'), null)
    assert.equal(parseSemanticRef('result:sc out#1'), null)
  })

  it('sanitizes names for filesystem paths', () => {
    assert.equal(__storeInternals__.sanitizeName('my agent'), 'my_agent')
    assert.equal(__storeInternals__.sanitizeName('..'), '_')
    assert.equal(__storeInternals__.sanitizeName(''), '_')
  })

  it('allocates monotonic, never-reused semantic refs per name', () => {
    const a = allocateSemanticRef('monotonic', storeRoot)
    const b = allocateSemanticRef('monotonic', storeRoot)
    const other = allocateSemanticRef('other-name', storeRoot)
    assert.match(a, /^result:monotonic#(\d+)$/)
    assert.match(b, /^result:monotonic#(\d+)$/)
    const nA = Number(a.split('#')[1])
    const nB = Number(b.split('#')[1])
    assert.ok(nB > nA)
    assert.match(other, /^result:other-name#1$/)
  })

  it('covers concurrent allocation: two allocators get distinct n', async () => {
    const storeUrl = new URL(
      '../pi-extension/subagents/store.ts',
      import.meta.url,
    ).href
    const workerSrc = `
      const { parentPort, workerData } = require('node:worker_threads')
      import(workerData.storeUrl).then((m) => {
        const ref = m.allocateSemanticRef(workerData.name, workerData.root)
        parentPort.postMessage(ref)
      })
    `
    const refs: string[] = await Promise.all(
      [0, 1].map(
        (i) =>
          new Promise<string>((resolve, reject) => {
            const worker = new Worker(workerSrc, {
              eval: true,
              workerData: { name: 'racy', root: storeRoot, storeUrl },
            })
            worker.on('message', resolve)
            worker.on('error', reject)
            void i
          }),
      ),
    )
    const n1 = Number(refs[0].split('#')[1])
    const n2 = Number(refs[1].split('#')[1])
    assert.notEqual(n1, n2)
    const highest = Number(allocateSemanticRef('racy', storeRoot).split('#')[1])
    assert.ok(highest > n1 && highest > n2)
  })

  it('resolves a semantic ref to the canonical record path (hidden binding round trip)', () => {
    const written = writeResultRecord(
      {
        childId: 'child-3',
        name: 'worker',
        summary: 'done',
        sessionFile: null,
      },
      storeRoot,
    )
    const ref = allocateSemanticRef('worker', storeRoot, written.canonicalId)
    const binding: ResultRefBinding = { ref, canonicalId: written.canonicalId }
    const resolved = resolveResultRef(binding.ref, storeRoot)
    assert.equal(resolved, written.path)
    const record = readResultRecord(resolved as string)
    assert.equal(record.canonicalId, binding.canonicalId)
  })

  it('fails closed on unknown or malformed ref resolution', () => {
    assert.equal(resolveResultRef('result:never#99999', storeRoot), null)
    assert.equal(resolveResultRef('garbage', storeRoot), null)
  })
})

describe('request/ack handshake (PMR-DNPZ)', () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: 'a1',
      name: 'Worker',
      task: '',
      surface: 'pane-1',
      startTime: 0,
      sessionFile: 'a1.jsonl',
      interactive: false,
      statusState: createStatusState({ source: 'pi', startTimeMs: 0 }),
      ...overrides,
    }
  }

  function makeControlRecord(
    overrides: Record<string, unknown> = {},
  ): ControlRecord {
    return {
      requestId: 'req-1',
      childId: 'a1',
      sessionFile: 'worker.jsonl',
      kind: 'interrupt',
      payload: {},
      sentAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  function makeAck(overrides: Record<string, unknown> = {}): ControlAck {
    return {
      requestId: 'req-1',
      accepted: true,
      code: 'idle',
      ...overrides,
    }
  }

  function makePending(
    overrides: Record<string, unknown> = {},
  ): PendingControlRequest {
    return {
      requestId: 'req-1',
      kind: 'interrupt',
      sentAtMs: 10_000,
      ...overrides,
    }
  }

  it('writes and reads control records via the data root (round trip)', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-control-'))
    try {
      const record = makeControlRecord()
      writeControlRecord(record, root)
      const read = readControlRecord(record.childId, root)
      assert.deepEqual(read, record)
      assert.equal(readControlRecord('no-such-child', root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('correlates acks on requestId + childId + sessionFile (identity revalidation)', () => {
    const record = makeControlRecord()
    const ack = makeAck()
    assert.equal(
      ackMatches({ record, ack, childId: 'a1', sessionFile: 'worker.jsonl' }),
      true,
    )
    assert.equal(
      ackMatches({
        record,
        ack: makeAck({ requestId: 'req-OTHER' }),
        childId: 'a1',
        sessionFile: 'worker.jsonl',
      }),
      false,
    )
    assert.equal(
      ackMatches({
        record,
        ack,
        childId: 'other',
        sessionFile: 'worker.jsonl',
      }),
      false,
    )
    assert.equal(
      ackMatches({ record, ack, childId: 'a1', sessionFile: 'other.jsonl' }),
      false,
    )
  })

  it('writes and reads ack sidecars colocated with the session file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagents-ack-'))
    try {
      const sessionFile = join(dir, 'child.jsonl')
      assert.equal(readAckSidecar(sessionFile), null)
      writeAckSidecar(sessionFile, makeAck())
      const ack = readAckSidecar(sessionFile)
      assert.equal(ack?.requestId, 'req-1')
      assert.equal(ackSidecarPath(sessionFile), `${sessionFile}.ack`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks a pending request and applies only the matching ack', () => {
    let state = markPendingRequest(
      forceStatusAfterInterrupt(
        createStatusState({ source: 'pi', startTimeMs: 0 }),
        10_000,
      ),
      makePending(),
    )
    assert.equal(state.pendingRequest?.requestId, 'req-1')

    const wrong = applyPendingAck(state, 'req-OTHER')
    assert.equal(wrong.outcome, 'ignored')
    assert.equal(wrong.state.pendingRequest?.requestId, 'req-1')

    const applied = applyPendingAck(state, 'req-1')
    assert.equal(applied.outcome, 'acked')
    assert.equal(applied.state.pendingRequest, null)
    assert.equal(applied.state.latestEvent, 'interrupt_acked')
  })

  it('answer pending requests correlate on the askId and expire like interrupts (WXG0 phase 5)', () => {
    let state = markPendingRequest(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      makePending({ requestId: 'ask-1', kind: 'answer' }),
    )
    assert.equal(state.pendingRequest?.kind, 'answer')

    // Wrong askId is ignored, state untouched.
    const wrong = applyPendingAck(state, 'ask-OTHER')
    assert.equal(wrong.outcome, 'ignored')
    assert.equal(wrong.state.pendingRequest?.requestId, 'ask-1')

    // Matching askId acks and clears the pending request.
    const applied = applyPendingAck(state, 'ask-1')
    assert.equal(applied.outcome, 'acked')
    assert.equal(applied.state.pendingRequest, null)

    // Bounded timeout still applies to answers.
    let timedOut = markPendingRequest(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      makePending({ requestId: 'ask-2', kind: 'answer', sentAtMs: 20_000 }),
    )
    const early = expirePendingRequest(
      timedOut,
      20_000 + INTERRUPT_ACK_TIMEOUT_MS - 1,
    )
    assert.equal(early.outcome, 'pending')
    const late = expirePendingRequest(
      timedOut,
      20_000 + INTERRUPT_ACK_TIMEOUT_MS,
    )
    assert.equal(late.outcome, 'timeout')
    assert.equal(late.state.pendingRequest, null)
  })

  it('expires a pending request after the bounded ack window', () => {
    let state = markPendingRequest(
      createStatusState({ source: 'pi', startTimeMs: 0 }),
      makePending(),
    )

    const before = expirePendingRequest(
      state,
      10_000 + INTERRUPT_ACK_TIMEOUT_MS - 1,
    )
    assert.equal(before.outcome, 'pending')
    assert.notEqual(before.state.pendingRequest, null)

    const after = expirePendingRequest(state, 10_000 + INTERRUPT_ACK_TIMEOUT_MS)
    assert.equal(after.outcome, 'timeout')
    assert.equal(after.state.pendingRequest, null)
    assert.equal(after.state.latestEvent, 'interrupt_unacknowledged')
  })

  it('interrupt tool writes a durable record and reports ack pending', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-interrupt-io-'))
    const written: ControlRecord[] = []
    const io = {
      writeControlRecord: (record: ControlRecord) => {
        written.push(record)
        writeControlRecord(record, root)
      },
      readAckSidecar: () => null,
      readControlRecord: (childId: string) => readControlRecord(childId, root),
      cleanupAck: () => {},
    }
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())
      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentInterrupt({ id: 'a1' }, () => {}, io),
      )

      assert.equal(result.details.ack, 'pending')
      assert.equal(written.length, 1)
      assert.equal(written[0].childId, 'a1')
      assert.equal(written[0].sessionFile, 'a1.jsonl')
      assert.equal(written[0].kind, 'interrupt')
      const persisted = readControlRecord('a1', root)
      assert.equal(persisted?.requestId, written[0].requestId)
      const state = runningMap.get('a1').statusState
      assert.equal(state.pendingRequest?.requestId, written[0].requestId)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to fire-and-forget with a warning when the record write fails', () => {
    const io = {
      writeControlRecord: () => {
        throw new Error('disk full')
      },
      readAckSidecar: () => null,
      readControlRecord: () => null,
      cleanupAck: () => {},
    }
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = false
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())
      const result = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        () => {
          sent = true
        },
        io,
      )

      assert.equal(sent, true)
      assert.equal(result.details.ack, 'unavailable')
      assert.match(result.content[0].text, /fire-and-forget/)
    } finally {
      runningMap.clear()
    }
  })

  it('child acks only aborted turns that have a pending interrupt record', () => {
    const record = makeControlRecord()
    assert.equal(interruptAckPayload('aborted', record)?.requestId, 'req-1')
    assert.equal(interruptAckPayload('stop', record), null)
    assert.equal(interruptAckPayload(undefined, record), null)
    assert.equal(interruptAckPayload('aborted', null), null)
    assert.equal(
      interruptAckPayload('aborted', makeControlRecord({ kind: 'answer' })),
      null,
    )
  })

  it('extracts the latest assistant stopReason', () => {
    assert.equal(
      findLastStopReason([
        { role: 'user', content: 'go' },
        { role: 'assistant', stopReason: 'aborted' },
      ]),
      'aborted',
    )
    assert.equal(findLastStopReason([{ role: 'assistant' }]), null)
    assert.equal(findLastStopReason([]), null)
    assert.equal(findLastStopReason(undefined), null)
  })
})

describe('asks.ts (PMR-WXG0 blocking ask_owner)', () => {
  function makeAskRecord(overrides: Record<string, unknown> = {}) {
    return {
      askId: 'ask-1',
      childId: 'child-1',
      name: 'Worker',
      question: 'Which database?',
      sessionFile: '/tmp/child-1.jsonl',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('writes and reads ask records atomically by childId', () => {
    withTempDir((dir) => {
      writeAskRecord(makeAskRecord(), dir)
      const record = readAskRecord('child-1', dir)
      assert.ok(record)
      assert.equal(record?.askId, 'ask-1')
      assert.equal(record?.sessionFile, '/tmp/child-1.jsonl')
      assert.equal(readAskRecord('missing', dir), null)
    })
  })

  it('rejects malformed ask records (fail closed)', () => {
    withTempDir((dir) => {
      const path = askRecordPath('child-2', dir)
      writeFileSync(path, JSON.stringify({ question: 'no identity' }))
      assert.equal(readAskRecord('child-2', dir), null)
      writeFileSync(path, 'not json')
      assert.equal(readAskRecord('child-2', dir), null)
    })
  })

  it('validates ask identity before an answer is applied', () => {
    const record = makeAskRecord()
    assert.equal(
      askIdentityMatches({
        record,
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      true,
    )
    assert.equal(
      askIdentityMatches({
        record,
        askId: 'ask-1',
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      true,
    )
    assert.equal(
      askIdentityMatches({
        record,
        askId: 'other',
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      false,
    )
    assert.equal(
      askIdentityMatches({
        record,
        childId: 'other-child',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      false,
    )
    assert.equal(
      askIdentityMatches({
        record,
        childId: 'child-1',
        sessionFile: '/tmp/other.jsonl',
      }),
      false,
    )
  })

  it('round-trips the .ask sidecar and reply record', () => {
    withTempDir((dir) => {
      writeAskSidecar('/tmp/x.jsonl', 'ask-9')
      assert.deepEqual(readAskSidecar('/tmp/x.jsonl'), { askId: 'ask-9' })
      removeAskSidecar('/tmp/x.jsonl')
      assert.equal(readAskSidecar('/tmp/x.jsonl'), null)

      writeAskRecord(makeAskRecord({ askId: 'ask-9' }), dir)
      writeReplyRecord(
        'child-1',
        { askId: 'ask-9', message: 'use postgres', repliedAt: 'now' },
        dir,
      )
      const reply = readReplyRecord('child-1', dir)
      assert.equal(reply?.askId, 'ask-9')
      assert.equal(reply?.message, 'use postgres')
    })
  })

  it('mailbox pump delivers only identity-matching replies (PMR-WXG0 phase 5)', () => {
    const record = makeAskRecord()
    const reply = { askId: 'ask-1', message: 'use postgres', repliedAt: 'now' }

    // Nothing to deliver yet.
    assert.equal(
      decideReplyDelivery({
        reply: null,
        record,
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      'idle',
    )
    assert.equal(
      decideReplyDelivery({
        reply,
        record: null,
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      'idle',
    )

    // Matching identity delivers.
    assert.equal(
      decideReplyDelivery({
        reply,
        record,
        childId: 'child-1',
        sessionFile: '/tmp/child-1.jsonl',
      }),
      'deliver',
    )

    // Superseded askId, wrong child, wrong session — never delivered.
    const mismatches: Array<[AskRecord, string, string]> = [
      [makeAskRecord({ askId: 'ask-OLD' }), 'child-1', '/tmp/child-1.jsonl'],
      [makeAskRecord({ childId: 'child-2' }), 'child-1', '/tmp/child-1.jsonl'],
      [
        makeAskRecord({ sessionFile: '/tmp/other.jsonl' }),
        'child-1',
        '/tmp/child-1.jsonl',
      ],
    ]
    for (const [rec, childId, sessionFile] of mismatches) {
      assert.equal(
        decideReplyDelivery({ reply, record: rec, childId, sessionFile }),
        'identity_mismatch',
      )
    }
  })

  it('pump cleanup removes reply + ask records only after ingestion', () => {
    withTempDir((dir) => {
      writeAskRecord(makeAskRecord(), dir)
      writeReplyRecord(
        'child-1',
        { askId: 'ask-1', message: 'go', repliedAt: 'now' },
        dir,
      )
      // Simulate the child's post-ingestion cleanup.
      removeReplyRecord('child-1', dir)
      removeAskRecord('child-1', dir)
      assert.equal(readReplyRecord('child-1', dir), null)
      assert.equal(readAskRecord('child-1', dir), null)
      // Idempotent: second removal is a no-op.
      removeReplyRecord('child-1', dir)
      removeAskRecord('child-1', dir)
    })
  })

  it('removes ask records by sessionFile for resume cleanup', () => {
    withTempDir((dir) => {
      writeAskRecord(makeAskRecord(), dir)
      writeAskRecord(
        makeAskRecord({
          askId: 'ask-2',
          childId: 'child-2',
          sessionFile: '/tmp/other.jsonl',
        }),
        dir,
      )
      const removed = removeAskRecordsForSession('/tmp/child-1.jsonl', dir)
      assert.equal(removed, 1)
      assert.equal(readAskRecord('child-1', dir), null)
      assert.ok(readAskRecord('child-2', dir))
    })
  })
})

describe('status widget rows (PMR-TABUX)', () => {
  function widgetAgent(id: string, name: string, ageMs: number) {
    return {
      id,
      name,
      task: '',
      surface: `pane-${id}`,
      paneId: `w1:p${id}`,
      startTime: 1_000_000 - ageMs,
      sessionFile: `sess-${id}`,
      interactive: false,
      statusState: createStatusState({
        source: 'pi' as const,
        startTimeMs: 1_000_000 - ageMs,
      }),
    }
  }

  it('renders header + marker/label/status/elapsed rows with hit regions', () => {
    const { renderSupervisionRows } = subagentsModule
    const rendered = renderSupervisionRows(
      [widgetAgent('a1', 'Worker', 13_000)],
      1_000_000,
    )
    assert.equal(rendered.lines.length, 2)
    assert.match(rendered.lines[0], /Subagents · 1 running/)
    // Fresh state (never observed) classifies as starting — marker + label +
    // status + elapsed are what matters here.
    assert.match(rendered.lines[1], /^[●◌] Worker · (working|starting) /)
    assert.match(rendered.lines[1], /13s/)
    assert.equal(rendered.hits.length, 1)
    assert.equal(rendered.hits[0].childId, 'a1')
    assert.equal(rendered.hits[0].row, 1)
    assert.ok(rendered.hits[0].to > rendered.hits[0].from)
  })

  it('marks starting entries transiently and blocked children with ◐', () => {
    const { renderSupervisionRows, statusKindOf, markerFor } = subagentsModule
    const starting = {
      ...widgetAgent('a1', 'Worker', 1_000),
      starting: true,
    }
    assert.equal(statusKindOf(starting, 1_000_000), 'starting')
    assert.equal(markerFor('starting'), '◌')

    const rendered = renderSupervisionRows([starting], 1_000_000)
    assert.match(rendered.lines[1], /^◌ Worker · starting /)
  })

  it('caps rows and shows the … N more overflow line', () => {
    const { renderSupervisionRows } = subagentsModule
    const agents = []
    for (let i = 0; i < 9; i++) {
      agents.push(widgetAgent(`a${i}`, `Agent${i}`, (i + 1) * 1000))
    }
    const rendered = renderSupervisionRows(agents, 1_000_000)
    // header + 6 rows + overflow
    assert.equal(rendered.lines.length, 8)
    assert.equal(rendered.lines[7], '… 3 more')
    assert.equal(rendered.hits.length, 6)
  })

  it('shows stale in the header when a snapshot read failed', () => {
    const { renderSupervisionRows } = subagentsModule
    const agent = {
      ...widgetAgent('a1', 'Worker', 5_000),
      activityRead: { ok: false, reason: 'missing' as const },
    }
    const rendered = renderSupervisionRows([agent], 1_000_000)
    assert.match(rendered.lines[0], /stale/)
  })

  it('matches left-clicks against hit regions only at the render width', () => {
    const { matchHitRegion } = subagentsModule
    const regions = [{ row: 1, from: 2, to: 8, childId: 'a1' }]
    assert.equal(
      matchHitRegion(regions, { x: 4, y: 1, width: 80 }, 80)?.childId,
      'a1',
    )
    assert.equal(matchHitRegion(regions, { x: 4, y: 1, width: 100 }, 80), null)
    assert.equal(matchHitRegion(regions, { x: 4, y: 2, width: 80 }, 80), null)
    assert.equal(matchHitRegion(regions, { x: 1, y: 1, width: 80 }, 80), null)
    assert.equal(matchHitRegion(regions, { x: 8, y: 1, width: 80 }, 80), null)
  })
})

describe('focus verification gate (PMR-TABUX)', () => {
  const { canFocusAgent } = spawnModule

  const target = {
    childId: 'a1',
    sessionFile: '/tmp/sess.jsonl',
    paneId: 'w1:p9',
    tabId: 'w1:t1',
    workspaceId: 'w1',
  }

  it('focuses only when herdr reports the same pane/tab/workspace', () => {
    assert.deepEqual(
      canFocusAgent(target, {
        pane_id: 'w1:p9',
        tab_id: 'w1:t1',
        workspace_id: 'w1',
      }),
      { ok: true, paneId: 'w1:p9' },
    )
  })

  it('is inert when the agent is gone, starting, or moved', () => {
    assert.equal(canFocusAgent(target, null).ok, false)
    assert.equal(
      canFocusAgent(
        { ...target, starting: true },
        {
          pane_id: 'w1:p9',
        },
      ).ok,
      false,
    )
    assert.equal(canFocusAgent(target, { pane_id: 'w1:pX' }).ok, false)
    assert.equal(
      canFocusAgent(target, {
        pane_id: 'w1:p9',
        tab_id: 'w1:tX',
      }).ok,
      false,
    )
    assert.equal(
      canFocusAgent({ ...target, paneId: undefined }, { pane_id: 'w1:p9' }).ok,
      false,
    )
  })
})

describe('rollback bookkeeping (PMR-TABUX)', () => {
  const { pickRollbackTabs } = spawnModule

  it('closes only tabs the spawn created, never user tabs', () => {
    assert.deepEqual(pickRollbackTabs(['t1', 't2'], ['t1', 'user-a', 't3']), [
      't1',
    ])
    assert.deepEqual(pickRollbackTabs([], ['t1']), [])
    assert.deepEqual(pickRollbackTabs(['t1'], []), [])
  })
})

describe('pollForExit check order (PMR-TABUX)', () => {
  it('observes .exit first, .ask before the liveness probe; scrape/.code gone', () => {
    const order = POLL_CHECK_ORDER
    assert.ok(order.indexOf('exit') < order.indexOf('ask'))
    assert.ok(order.indexOf('ask') < order.indexOf('liveness'))
    const names = order as readonly string[]
    assert.equal(names.includes('screen'), false)
    assert.equal(names.includes('code'), false)
    assert.equal(names.includes('sentinel'), false)
  })
})
describe('pollForExit crash inference (PMR-TABUX)', () => {
  function opts(overrides: Record<string, unknown> = {}) {
    return {
      interval: 5,
      sessionFile: '/tmp/does-not-matter.jsonl',
      isAlive: () => true,
      ...overrides,
    } as any
  }

  it('resolves from the .exit sidecar when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poll-exit-'))
    const sessionFile = join(dir, 's.jsonl')
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: 'done' }),
      'utf8',
    )
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const result = await pollForExit(
      'w1:p1',
      AbortSignal.timeout(1000),
      opts({ sessionFile }),
    )
    assert.equal(result.reason, 'done')
    rmSync(dir, { recursive: true, force: true })
  })

  it('fail-closed: pane gone + no .exit ⇒ error result, never success', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const result = await pollForExit(
      'w1:pGONE',
      AbortSignal.timeout(1000),
      opts({ isAlive: () => false }),
    )
    assert.equal(result.reason, 'error')
    assert.equal(result.exitCode, 1)
    assert.match(
      result.errorMessage ?? '',
      /disappeared without an exit sidecar/,
    )
  })

  it('probe errors fail OPEN (treated alive)', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const controller = new AbortController()
    const p = pollForExit(
      'w1:p1',
      controller.signal,
      opts({
        isAlive: () => {
          throw new Error('herdr unreachable')
        },
      }),
    )
    // No error thrown for the probe failure; abort to end the poll.
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(p, /Aborted/)
  })
})

describe('blocked activity phase (PMR-WXG0)', () => {
  it('keeps phase blocked across agent_end until the answer starts a run', () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, 'child-b')
      const recorder = createSubagentActivityRecorder({
        runningChildId: 'child-b',
        activityFile,
      })

      recorder.sessionStart()
      recorder.agentStart()
      recorder.turnStart(1)
      recorder.blockedAsking()

      let read = readSubagentActivityFile(activityFile, 'child-b')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'blocked')
      assert.ok(read.activity.blockedSince != null)

      recorder.turnEnd(1)
      recorder.agentEndWaiting()
      read = readSubagentActivityFile(activityFile, 'child-b')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'blocked')
      assert.equal(read.activity.waitingSince, undefined)

      // Owner's answer arrives → next run flips back to active and unblocks.
      recorder.beforeAgentStart()
      read = readSubagentActivityFile(activityFile, 'child-b')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'active')
      assert.equal(read.activity.blockedSince, undefined)

      recorder.agentEndWaiting()
      read = readSubagentActivityFile(activityFile, 'child-b')
      assert.ok(read.ok)
      assert.equal(read.activity.phase, 'waiting')
    })
  })
})

describe('blocked status classification (PMR-WXG0)', () => {
  function blockedState() {
    const state = createStatusState({ source: 'pi', startTimeMs: 0 })
    return observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 1_000,
        sequence: 1,
        phase: 'blocked',
        blockedSince: 1_000,
        latestEvent: 'ask_owner',
      },
      1_000,
    )
  }

  it('classifies blocked children as blocked, never stalled', () => {
    const snapshot = classifyStatus(blockedState(), 5_000_000)
    assert.equal(snapshot.kind, 'blocked')
    assert.equal(snapshot.blockedDurationText, '1h 23m')
    assert.match(formatStatusLine('Worker', snapshot), /blocked/)
  })

  it('advances without a stalled/recovered transition while blocked', () => {
    const { transition } = advanceStatusState(blockedState(), 5_000_000)
    assert.equal(transition, null)
  })
})

describe('infrastructure child tools (PMR-WXG0)', () => {
  it('never lets deny-tools or spawning:false exclude ask_owner', () => {
    const denied = resolveDenyTools({
      denyTools: 'ask_owner,web_fetch',
      spawning: false,
    })
    assert.equal(denied.has('ask_owner'), false)
    assert.equal(denied.has('web_fetch'), true)
    assert.equal(denied.has('subagent'), true)
  })
})

describe('herdr.ts verb layer (PMR-M48Y)', () => {
  describe('parseHerdrEnvelope', () => {
    const args = ['pane', 'wait-output', 'w1:p1']

    it('parses the {id, result} envelope and returns result', () => {
      const raw = '{"id":"cli:pane:wait-output","result":{"matched":"yes"}}'
      assert.deepEqual(parseHerdrEnvelope<Record<string, string>>(args, raw), {
        matched: 'yes',
      })
    })

    it('fails closed on non-JSON output with a clear error', () => {
      assert.throws(
        () => parseHerdrEnvelope(args, 'panic: socket gone\n'),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /non-JSON output/)
          assert.match(err.message, /pane wait-output w1:p1/)
          return true
        },
      )
    })

    it('surfaces herdr error envelopes', () => {
      const raw =
        '{"id":"x","error":{"code":"agent_pane_busy","message":"busy"}}'
      assert.throws(
        () => parseHerdrEnvelope(args, raw),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /agent_pane_busy/)
          return true
        },
      )
    })

    it('rejects JSON without id/result', () => {
      assert.throws(
        () => parseHerdrEnvelope(args, '{"foo":1}'),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /missing id\/result/)
          return true
        },
      )
    })
  })

  describe('compareVersions', () => {
    it('orders semver strings', () => {
      assert.ok(compareVersions('0.9.0', '0.9.1') < 0)
      assert.ok(compareVersions('0.9.1', '0.9.1') === 0)
      assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
      assert.ok(compareVersions('1.0', '0.9.9') > 0)
    })
  })

  describe('parseHerdrStatus (preflight + version gate)', () => {
    it('rejects non-JSON output with a clear error', () => {
      assert.throws(
        () => parseHerdrStatus('herdr: command not found'),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /non-JSON/)
          return true
        },
      )
    })

    it('rejects an unreachable/not-running server', () => {
      const fixture = JSON.stringify({
        client: { version: '0.9.1' },
        server: { status: 'stopped', running: false },
      })
      assert.throws(
        () => parseHerdrStatus(fixture),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /not running/)
          assert.match(err.message, /herdr pi/)
          return true
        },
      )
    })

    it('rejects versions below the gate with an upgrade hint', () => {
      const fixture = JSON.stringify({
        client: { version: '0.9.0' },
        server: { status: 'running', running: true, version: '0.9.0' },
      })
      assert.throws(
        () => parseHerdrStatus(fixture),
        (err: unknown) => {
          assert.ok(err instanceof HerdrError)
          assert.match(err.message, /0\.9\.0 is too old/)
          assert.match(err.message, /herdr upgrade/)
          return true
        },
      )
    })

    it('accepts a running server at or above the gate', () => {
      const fixture = JSON.stringify({
        client: { version: '0.9.1' },
        server: {
          status: 'running',
          running: true,
          version: '0.9.1',
          protocol: 22,
        },
      })
      const status = parseHerdrStatus(fixture)
      assert.equal(status.server?.version, '0.9.1')
    })
  })
})

describe('peers.ts (PMR-98S6 peer-to-peer messaging)', () => {
  const DEAD_PID = 0x400000
  let peersRoot: string
  let counter = 0

  // Never touch the real agent dir in tests — every call passes peersRoot.
  function fakePresence(params: {
    childId: string
    sessionFile: string
    claim: ProcessLockClaim
    name?: string
  }): Record<string, unknown> {
    return {
      version: 1,
      childId: params.childId,
      sessionId: basename(params.sessionFile, '.jsonl'),
      sessionFile: params.sessionFile,
      name: params.name ?? params.childId,
      cwd: '/tmp',
      claim: params.claim,
      updatedAt: new Date().toISOString(),
    }
  }

  function identityFor(childId: string): ChildIdentity {
    counter += 1
    return {
      childId,
      sessionFile: join(peersRoot, 'sessions', `${childId}-${counter}.jsonl`),
      name: childId,
      cwd: '/tmp',
    }
  }

  // Hand-publish a presence record whose claim is a dead pid (no lock dir).
  function publishDeadPresence(childId: string): void {
    writeFileSync(
      presencePath(childId, peersRoot),
      JSON.stringify(
        fakePresence({
          childId,
          sessionFile: `/nonexistent/${childId}.jsonl`,
          claim: { pid: DEAD_PID, id: randomUUID() },
        }),
      ),
    )
  }

  before(() => {
    peersRoot = join(mkdtempSync(join(tmpdir(), 'peers-')), 'pi-subagents')
  })
  after(() => {
    rmSync(peersRoot, { recursive: true, force: true })
  })

  it('publishes presence, lists self + live peer, release removes record', () => {
    const a = identityFor('alpha')
    const b = identityFor('beta')
    const releaseA = publishPresence(a, peersRoot)
    const releaseB = publishPresence(b, peersRoot)
    try {
      const peers = listLivePeers(a, peersRoot)
      const self = peers.find((p) => p.self)
      const other = peers.find((p) => p.childId === b.childId)
      assert.ok(self)
      assert.equal(self.childId, a.childId)
      assert.ok(other)
      assert.equal(other.name, 'beta')
    } finally {
      releaseA()
      releaseB()
    }
    assert.ok(!existsSync(presencePath(a.childId, peersRoot)))
    assert.ok(!existsSync(presencePath(b.childId, peersRoot)))
  })

  it('filters dead-claim, malformed and takeover-stale presence records', () => {
    const live = identityFor('live')
    const releaseLive = publishPresence(live, peersRoot)
    try {
      // Dead pid: no lock dir behind the record at all.
      publishDeadPresence('ghost')
      // Malformed record file.
      writeFileSync(presencePath('broken', peersRoot), '{not json')
      // Wrong schema version.
      writeFileSync(
        presencePath('oldversion', peersRoot),
        JSON.stringify({
          ...fakePresence({
            childId: 'oldversion',
            sessionFile: '/nonexistent/x.jsonl',
            claim: { pid: process.pid, id: randomUUID() },
          }),
          version: 99,
        }),
      )
      // Stale claim: lock dir exists but with a DEAD pid, record matches it.
      const staleSession = join(peersRoot, 'sessions', 'stale.jsonl')
      const staleClaim: ProcessLockClaim = {
        pid: DEAD_PID,
        id: 'e5a8d13e-1a2b-4c3d-9e2f-0123456789ab',
      }
      const staleLockPath = peerLockPath(staleSession)
      mkdirSync(staleLockPath, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(staleLockPath, `${staleClaim.pid}-${staleClaim.id}`),
        JSON.stringify(staleClaim),
      )
      writeFileSync(
        presencePath('stale', peersRoot),
        JSON.stringify(
          fakePresence({
            childId: 'stale',
            sessionFile: staleSession,
            claim: staleClaim,
          }),
        ),
      )
      // Takeover: lock now held by US (live) but the record claims the old
      // generation id — must be filtered as superseded.
      const takenOver = identityFor('takenover')
      const leaseUs = acquireProcessLock(peerLockPath(takenOver.sessionFile))
      const releaseUs = () => leaseUs.release()
      writeFileSync(
        presencePath('takenover', peersRoot),
        JSON.stringify(
          fakePresence({
            childId: 'takenover',
            sessionFile: takenOver.sessionFile,
            claim: { pid: process.pid, id: randomUUID() },
          }),
        ),
      )

      const peers = listLivePeers(live, peersRoot)
      const ids = peers.map((p) => p.childId)
      assert.ok(ids.includes(live.childId))
      assert.ok(!ids.includes('ghost'))
      assert.ok(!ids.includes('broken'))
      assert.ok(!ids.includes('oldversion'))
      assert.ok(!ids.includes('stale'))
      assert.ok(!ids.includes('takenover'))
      releaseUs()
    } finally {
      releaseLive()
    }
  })

  it('refuses presence records above the 4 KiB cap', () => {
    const big = identityFor('bigname')
    big.name = 'x'.repeat(5000)
    assert.throws(
      () => publishPresence(big, peersRoot),
      /presence record exceeds 4096 bytes/,
    )
  })

  it('round-trips a message between peers, forwarding resultRef', () => {
    const a = identityFor('sender')
    const b = identityFor('receiver')
    const releaseA = publishPresence(a, peersRoot)
    const releaseB = publishPresence(b, peersRoot)
    try {
      const target = resolvePeer('receiver', a, peersRoot)
      assert.equal(target.childId, b.childId)
      const sent = sendPeerMessage({
        toChildId: target.childId,
        from: a,
        message: 'compare findings',
        resultRef: 'result:findings#1',
        root: peersRoot,
      })
      assert.ok(existsSync(sent.path))
      const inbox = readInbox(b.childId, peersRoot)
      assert.equal(inbox.length, 1)
      assert.equal(inbox[0].message.message, 'compare findings')
      assert.equal(inbox[0].message.from.childId, a.childId)
      assert.equal(inbox[0].message.resultRef, 'result:findings#1')
      removeInboxEntry(inbox[0].path)
      assert.equal(readInbox(b.childId, peersRoot).length, 0)
      assert.ok(!existsSync(sent.path))
    } finally {
      releaseA()
      releaseB()
    }
  })

  it('allocates monotonically increasing inbox seqs', () => {
    const b = identityFor('seqbox')
    const a = identityFor('seqsend')
    const releaseA = publishPresence(a, peersRoot)
    const releaseB = publishPresence(b, peersRoot)
    try {
      const first = sendPeerMessage({
        toChildId: b.childId,
        from: a,
        message: 'one',
        root: peersRoot,
      })
      const second = sendPeerMessage({
        toChildId: b.childId,
        from: a,
        message: 'two',
        root: peersRoot,
      })
      assert.ok(first.path < second.path)
      const inbox = readInbox(b.childId, peersRoot)
      assert.deepEqual(
        inbox.map((e) => e.message.message),
        ['one', 'two'],
      )
    } finally {
      releaseA()
      releaseB()
    }
  })

  it('rejects messages above the 8 KiB cap with a clear error', () => {
    const a = identityFor('bigsender')
    const b = identityFor('biginbox')
    assert.throws(
      () =>
        sendPeerMessage({
          toChildId: b.childId,
          from: a,
          message: 'y'.repeat(9000),
          root: peersRoot,
        }),
      /inbox cap is 8192 bytes/,
    )
    assert.equal(readInbox(b.childId, peersRoot).length, 0)
  })

  it('skips malformed inbox entries instead of surfacing them', () => {
    const b = identityFor('messyinbox')
    const dir = inboxDir(b.childId, peersRoot)
    writeFileSync(join(dir, 'garbage.json'), '{oops')
    writeFileSync(
      join(dir, 'wrongversion.json'),
      JSON.stringify({ version: 42, message: 'nope' }),
    )
    assert.equal(readInbox(b.childId, peersRoot).length, 0)
  })

  it('resolvePeer reports missing and ambiguous peers', () => {
    const a = identityFor('resolver')
    const releaseA = publishPresence(a, peersRoot)
    try {
      assert.throws(
        () => resolvePeer('nobody', a, peersRoot),
        /No live peer found/,
      )
      // Ambiguity: two live peers sharing a name.
      const dup1 = identityFor('dup-child-1')
      const dup2 = identityFor('dup-child-2')
      dup1.name = 'twin'
      dup2.name = 'twin'
      const releaseD1 = publishPresence(dup1, peersRoot)
      const releaseD2 = publishPresence(dup2, peersRoot)
      try {
        assert.throws(() => resolvePeer('twin', a, peersRoot), /ambiguous/)
      } finally {
        releaseD1()
        releaseD2()
      }
    } finally {
      releaseA()
    }
  })
})
