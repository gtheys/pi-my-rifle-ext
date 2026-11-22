import assert from 'node:assert/strict'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  after,
  afterEach,
  before,
  describe,
  it,
  type TestContext,
} from 'node:test'
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
  assignmentPath,
  deriveResumeHint,
  findAssignmentByBranch,
  findStartingAssignment,
  hasLiveAssignmentForParent,
  listAssignments,
  readAssignment,
  recordAssignmentUsage,
  removeAssignment,
  updateAssignmentStatus,
  writeAssignment,
} from '../pi-extension/subagents/assignments.ts'
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
import {
  buildRetirementStub,
  DEFAULT_RETIREMENT_KEEP_RECENT,
  DEFAULT_RETIREMENT_MIN_BYTES,
  RETIRED_STUB_PREFIX,
  retireSettledSubagentPayloads,
  shouldArmRetirement,
} from '../pi-extension/subagents/retirement.ts'
import * as spawnModule from '../pi-extension/subagents/spawn.ts'
// re-exported for blocked-phase widget tests
import {
  __storeInternals__,
  allocateSemanticRef,
  inspectResultRef,
  MAX_RESULT_RECORD_BYTES,
  parseSemanticRef,
  RESULT_REF_EXPIRED_MESSAGE,
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
import {
  claimInterruptWatermark,
  type InterruptWatermark,
  interruptWatermarkMatches,
  interruptWatermarkPath,
  readInterruptWatermark,
} from '../pi-extension/subagents/watermark.ts'

const resolveDenyTools = subagentsModule.__test__.resolveDenyTools

// AIDEV-NOTE (PMR-70GJ): chmod-based failure injection (chmodSync(dir,
// 0o500) → EACCES) only forces the failure when the suite runs as NON-root —
// as root the write succeeds and the test fails loudly (or worse, an
// early-return variant reports green with zero coverage). Skip these tests
// with a clear message when root.
function skipIfRoot(t: TestContext): boolean {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('chmod failure injection is ineffective as root (EACCES bypassed)')
    return true
  }
  return false
}

/** withTempDir for async bodies: the temp dir must outlive the awaited run. */
async function withTempDirAsync<T>(
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = createTestDir()
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
  classifyTurnStall,
  createStatusState,
  DEFAULT_STALL_THRESHOLDS,
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
  QUIET_STALL_AFTER_MS,
  STREAM_STALL_AFTER_MS,
  type StallThresholds,
  stallErrorMessage,
} from '../pi-extension/subagents/status.ts'
import subagentDoneExtension, {
  decideReplyDelivery,
  decideThresholdIntercept,
  exitSidecarPayload,
  findLastStopReason,
  findLatestAssistantError,
  interruptAckPayload,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
} from '../pi-extension/subagents/subagent-done.ts'
import { mkTmpDir } from './tmpdir.ts'

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
  // AIDEV-NOTE (PMR-AD0H): additive event capture so tests can fire
  // lifecycle handlers (e.g. session_start widget reconcile) against the
  // mock api. Pure bookkeeping — existing registrations are unaffected.
  const eventHandlers = new Map<string, Array<(event: any, ctx: any) => void>>()
  const sentUserMessages: string[] = []
  const sentMessages: Array<any> = []
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    eventHandlers,
    sentUserMessages,
    sentMessages,
    api: {
      on(event: string, handler: (event: any, ctx: any) => void) {
        const handlers = eventHandlers.get(event) ?? []
        handlers.push(handler)
        eventHandlers.set(event, handlers)
      },
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

// AIDEV-NOTE: tests run as a subagent (e.g. spec-publish pre-push hook) inherit
// PI_SUBAGENT_ID/PI_DENY_TOOLS, which makes the extension skip tool
// registration and fails registration tests. Scrub them for the whole run.
for (const name of [
  'PI_SUBAGENT_ID',
  'PI_SUBAGENT_SESSION',
  'PI_SUBAGENT_AGENT',
  'PI_DENY_TOOLS',
]) {
  delete process.env[name]
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

  // PMR-YFRB siblings for the pin above: present+active snapshots DO age
  // into stalled, scope-aware — streaming uses the short bucket (provider
  // moved to the long bucket, PMR-S1PT), everything else
  // (provider/tool/turn/null) the long bucket.
  it('ages a frozen streaming active snapshot into stalled (dead turn)', () => {
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
        latestEvent: 'before_provider_request',
      },
      5_000,
    )

    const justBefore = classifyStatus(state, 154_999)
    assert.equal(justBefore.kind, 'active')

    const aged = classifyStatus(state, 155_000)
    assert.equal(aged.kind, 'stalled')
    assert.equal(aged.statusLabel, 'dead turn')
  })

  it('keeps an actively streaming snapshot healthy', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 150_000,
        sequence: 2,
        phase: 'active',
        active: true,
        activeScope: 'streaming',
        activeSince: 5_000,
      },
      150_000,
    )

    const snapshot = classifyStatus(state, 155_000)
    assert.equal(snapshot.kind, 'active')
    assert.equal(snapshot.statusLabel, null)
  })

  it('never ages active snapshots when the watchdog is disabled', () => {
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

    const disabled: StallThresholds = {
      enabled: false,
      streamStallAfterMs: STREAM_STALL_AFTER_MS,
      quietStallAfterMs: QUIET_STALL_AFTER_MS,
    }
    const snapshot = classifyStatus(state, 10_000_000, disabled)
    assert.equal(snapshot.kind, 'active')
  })

  it('ages a frozen tool active snapshot only at the quiet threshold', () => {
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

    const justBefore = classifyStatus(state, 1_804_999)
    assert.equal(justBefore.kind, 'active')

    const aged = classifyStatus(state, 1_805_000)
    assert.equal(aged.kind, 'stalled')
    assert.equal(aged.statusLabel, 'dead turn')
  })

  it('recovers a dead-turn stalled state when activity resumes', () => {
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
    let advanced = advanceStatusState(state, 155_000)
    assert.equal(advanced.snapshot.kind, 'stalled')
    assert.equal(advanced.transition, 'stalled')
    state = advanced.nextState

    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 156_000,
        sequence: 2,
        phase: 'active',
        active: true,
        activeScope: 'streaming',
        activeSince: 5_000,
      },
      156_000,
    )
    advanced = advanceStatusState(state, 157_000)
    assert.equal(advanced.snapshot.kind, 'active')
    assert.equal(advanced.transition, 'recovered')
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

  // PMR-SMHB regression: healthy long-running workers were flagged
  // 'stalled (wrong activity id)' once identity churn produced wrong-id
  // reads. A writer behind the file is evidence of life — never stall it.
  it('never classifies wrong-id snapshot problems as stalled', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 7,
        phase: 'active',
        active: true,
        activeScope: 'tool',
        activeSince: 5_000,
        activityLabel: 'bash',
        latestEvent: 'tool_execution_start',
      },
      5_000,
    )
    state = advanceStatusState(state, 6_000).nextState
    state = observeStatus(state, { snapshot: 'wrong-id' }, 10_000)

    const shortlyAfter = classifyStatus(state, 15_000)
    assert.equal(shortlyAfter.kind, 'active')
    assert.equal(shortlyAfter.statusLabel, 'wrong activity id')

    const longAfter = classifyStatus(state, 240_000)
    assert.equal(longAfter.kind, 'active')
    assert.equal(longAfter.statusLabel, 'wrong activity id')

    const advanced = advanceStatusState(state, 240_000)
    assert.equal(advanced.snapshot.kind, 'active')
    assert.equal(advanced.transition, null)
  })

  it('holds starting for never-validated wrong-id snapshots instead of stalling', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(state, { snapshot: 'wrong-id' }, 1_000)

    assert.equal(classifyStatus(state, 60_999).kind, 'starting')
    const aged = classifyStatus(state, 240_000)
    assert.equal(aged.kind, 'starting')
    assert.equal(aged.statusLabel, 'wrong activity id')
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

describe('classifyTurnStall (PMR-YFRB)', () => {
  function activeState(scope: string | null, lastActivityAtMs: number) {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: lastActivityAtMs,
        sequence: 1,
        phase: 'active',
        active: true,
        activeScope: scope ?? undefined,
        activeSince: lastActivityAtMs,
      },
      lastActivityAtMs,
    )
    return state
  }

  it('does not stall a streaming scope just before the threshold', () => {
    const verdict = classifyTurnStall(activeState('streaming', 0), 149_999)
    assert.equal(verdict.stalled, false)
    assert.equal(verdict.reason, null)
  })

  it('stalls a streaming scope at exactly the threshold (dead turn)', () => {
    const verdict = classifyTurnStall(activeState('streaming', 0), 150_000)
    assert.equal(verdict.stalled, true)
    assert.equal(verdict.reason, 'dead-turn')
    assert.equal(verdict.activeScope, 'streaming')
    assert.equal(verdict.stalledForMs, 150_000)
  })

  it('keeps provider scope alive until the long bucket (pre-first-token silence is legitimate)', () => {
    // PMR-S1PT: provider includes before_provider_request → first delta,
    // which can legitimately stay silent past the short deadline (large
    // prompt processing, 429/529 retry backoff) — short bucket would
    // false-kill a healthy child mid-request.
    const short = classifyTurnStall(activeState('provider', 0), 150_000)
    assert.equal(short.stalled, false)

    const long = classifyTurnStall(activeState('provider', 0), 1_800_000)
    assert.equal(long.stalled, true)
    assert.equal(long.reason, 'dead-turn')
    assert.equal(long.activeScope, 'provider')
  })

  it('keeps tool scope alive until the long bucket', () => {
    const short = classifyTurnStall(activeState('tool', 0), 1_799_999)
    assert.equal(short.stalled, false)

    const long = classifyTurnStall(activeState('tool', 0), 1_800_000)
    assert.equal(long.stalled, true)
    assert.equal(long.reason, 'dead-turn')
  })

  it('treats turn and null scopes as long-bucket', () => {
    const turn = classifyTurnStall(activeState('turn', 0), 200_000)
    assert.equal(turn.stalled, false)

    const nullScope = classifyTurnStall(activeState(null, 0), 1_800_000)
    assert.equal(nullScope.stalled, true)
    assert.equal(nullScope.reason, 'dead-turn')
  })

  it('reports no-activity for a sustained missing snapshot', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(state, { snapshot: 'missing' }, 1_000)

    const before = classifyTurnStall(state, 1_800_999)
    assert.equal(before.stalled, false)

    const aged = classifyTurnStall(state, 1_801_000)
    assert.equal(aged.stalled, true)
    assert.equal(aged.reason, 'no-activity')
    assert.equal(aged.activeScope, null)
  })

  it('reports no-activity for a sustained wrong-id snapshot', () => {
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
      },
      5_000,
    )
    state = observeStatus(state, { snapshot: 'wrong-id' }, 10_000)

    const aged = classifyTurnStall(state, 1_809_999)
    assert.equal(aged.stalled, false)

    const longAfter = classifyTurnStall(state, 1_810_000)
    assert.equal(longAfter.stalled, true)
    assert.equal(longAfter.reason, 'no-activity')
  })

  it('never stalls a blocked phase regardless of age', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'blocked',
        blockedSince: 5_000,
      },
      5_000,
    )

    const verdict = classifyTurnStall(state, 10 * QUIET_STALL_AFTER_MS)
    assert.equal(verdict.stalled, false)
  })

  it('never stalls a waiting phase regardless of age', () => {
    let state = createStatusState({ source: 'pi', startTimeMs: 0 })
    state = observeStatus(
      state,
      {
        snapshot: 'present',
        updatedAt: 5_000,
        sequence: 1,
        phase: 'waiting',
        waitingSince: 5_000,
      },
      5_000,
    )

    const verdict = classifyTurnStall(state, 10 * QUIET_STALL_AFTER_MS)
    assert.equal(verdict.stalled, false)
  })

  it('never stalls a claude-sourced state', () => {
    const state = createStatusState({ source: 'claude', startTimeMs: 0 })
    const verdict = classifyTurnStall(state, 10_000_000)
    assert.equal(verdict.stalled, false)
  })

  it('never stalls when the watchdog is disabled', () => {
    const verdict = classifyTurnStall(activeState('streaming', 0), 10_000_000, {
      enabled: false,
      streamStallAfterMs: 150_000,
      quietStallAfterMs: 1_800_000,
    })
    assert.equal(verdict.stalled, false)
  })

  it('exposes the default thresholds', () => {
    assert.equal(STREAM_STALL_AFTER_MS, 150_000)
    assert.equal(QUIET_STALL_AFTER_MS, 1_800_000)
    assert.deepEqual(DEFAULT_STALL_THRESHOLDS, {
      enabled: true,
      streamStallAfterMs: 150_000,
      quietStallAfterMs: 1_800_000,
    })
  })

  it('formats a stall error message with scope and duration', () => {
    const streaming = stallErrorMessage(
      classifyTurnStall(activeState('streaming', 0), 200_000),
    )
    assert.match(streaming, /^Subagent turn stalled/)
    assert.match(streaming, /streaming/)
    assert.match(streaming, /3m/)

    const missing = stallErrorMessage(
      classifyTurnStall(
        (() => {
          let state = createStatusState({ source: 'pi', startTimeMs: 0 })
          state = observeStatus(state, { snapshot: 'missing' }, 1_000)
          return state
        })(),
        1_900_000,
      ),
    )
    assert.match(missing, /^Subagent turn stalled/)
    assert.match(missing, /snapshot missing/)
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

  // PMR-RKH5: governed spawning — `spawning` is an enum
  // (true | false | manager-approval); invalid values reject the file.
  it('parses spawning enum values from frontmatter', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      for (const [value, expected] of [
        ['true', true],
        ['false', false],
        ['manager-approval', 'manager-approval'],
      ] as const) {
        const name = `spawning-${value}-test-agent`
        writeAgentFile(
          projectAgentsDir,
          name,
          [`name: ${name}`, `spawning: ${value}`].join('\n'),
        )
        const loaded = testApi.loadAgentDefaults(name)
        assert.ok(loaded, `expected ${name} to load`)
        assert.equal(loaded.spawning, expected)
      }
    })
  })

  it('leaves spawning undefined when not set in frontmatter', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'spawning-unset-test-agent',
        'name: spawning-unset-test-agent',
      )
      const loaded = testApi.loadAgentDefaults('spawning-unset-test-agent')
      assert.equal(loaded?.spawning, undefined)
    })
  })

  it('rejects agent file with invalid spawning value', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'spawning-invalid-test-agent',
        ['name: spawning-invalid-test-agent', 'spawning: sideways'].join('\n'),
      )
      assert.throws(
        () => testApi.loadAgentDefaults('spawning-invalid-test-agent'),
        /invalid spawning value "sideways".*manager-approval/,
      )
    })
  })

  it('skips agent files with invalid spawning during discovery', async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        'spawning-invalid-test-agent',
        ['name: spawning-invalid-test-agent', 'spawning: sideways'].join('\n'),
      )
      writeAgentFile(
        projectAgentsDir,
        'spawning-valid-test-agent',
        ['name: spawning-valid-test-agent', 'spawning: manager-approval'].join(
          '\n',
        ),
      )
      const discovered = testApi.discoverAgentDefinitions()
      const names = discovered.map((d: { name: string }) => d.name)
      assert.ok(
        !names.includes('spawning-invalid-test-agent'),
        'invalid spawning file must be rejected from discovery',
      )
      assert.ok(names.includes('spawning-valid-test-agent'))
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
      'read,bash,web_search,caller_ping,subagent_done,ask_owner,message_owner,list_peers,message_peer',
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

  describe('decideThresholdIntercept', () => {
    const gate = { enabled: true, isChild: true }

    it('cancels and retires on the first threshold event', () => {
      assert.deepEqual(
        decideThresholdIntercept({
          reason: 'threshold',
          ...gate,
          interceptUsed: false,
        }),
        { cancel: true, retire: true },
      )
    })

    it('falls through to native compaction on the second threshold event', () => {
      assert.deepEqual(
        decideThresholdIntercept({
          reason: 'threshold',
          ...gate,
          interceptUsed: true,
        }),
        { cancel: false, retire: false },
      )
    })

    it('never touches manual or emergency compaction', () => {
      for (const reason of ['manual', 'emergency']) {
        assert.deepEqual(
          decideThresholdIntercept({
            reason,
            ...gate,
            interceptUsed: false,
          }),
          { cancel: false, retire: false },
        )
      }
    })

    it('is inert when the gate is off or the session is not a child', () => {
      assert.deepEqual(
        decideThresholdIntercept({
          reason: 'threshold',
          enabled: false,
          isChild: true,
          interceptUsed: false,
        }),
        { cancel: false, retire: false },
      )
      assert.deepEqual(
        decideThresholdIntercept({
          reason: 'threshold',
          enabled: true,
          isChild: false,
          interceptUsed: false,
        }),
        { cancel: false, retire: false },
      )
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

  // PMR-RKH5: manager-approval gate — model spawns denied and pointed at
  // /subagent; user-initiated /subagent bypasses the tool path entirely.
  it('manager-approval gate denies model spawns with /subagent instructions', () => {
    const testApi = (subagentsModule as any).__test__
    const denial = testApi.managerApprovalDenial(
      { spawning: 'manager-approval' },
      'deployer',
    )
    assert.match(denial, /requires user approval/)
    assert.match(denial, /\/subagent deployer/)
    assert.match(denial, /Do not retry/)
  })

  it('manager-approval gate allows ungated and boolean spawning agents', () => {
    const testApi = (subagentsModule as any).__test__
    assert.equal(testApi.managerApprovalDenial(null, 'x'), null)
    assert.equal(testApi.managerApprovalDenial({}, 'x'), null)
    assert.equal(testApi.managerApprovalDenial({ spawning: true }, 'x'), null)
    assert.equal(testApi.managerApprovalDenial({ spawning: false }, 'x'), null)
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

  it('appends recovery guidance to failure presentations (PMR-PCF7)', () => {
    const testApi = (subagentsModule as any).__test__
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 10,
        summary: 'Sub-agent exited with code 1',
        sessionFile: '/tmp/worker.jsonl',
      },
      'Worker',
      'Recovery: subagent_resume({ sessionPath: "/tmp/worker.jsonl" }).',
    )
    assert.match(presentation, /failed \(exit code 1\)/)
    assert.match(
      presentation,
      /Recovery: subagent_resume\(\{ sessionPath: "\/tmp\/worker\.jsonl" \}\)\./,
    )
  })

  it('keeps successful presentations unchanged even with guidance available', () => {
    const testApi = (subagentsModule as any).__test__
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 0,
        elapsed: 10,
        summary: 'All done',
        sessionFile: '/tmp/worker.jsonl',
      },
      'Worker',
      'Recovery: subagent_resume({ sessionPath: "/tmp/worker.jsonl" }).',
    )
    assert.match(presentation, /completed \(10s\)/)
    assert.doesNotMatch(presentation, /Recovery:/)
  })

  it('recoveryGuidanceFor: resume hint for a verified session path', () => {
    const testApi = (subagentsModule as any).__test__
    const isolated = join(mkTmpDir('guidance-'), 'pi-subagents')
    mkdirSync(isolated, { recursive: true })
    try {
      const sessionFile = join(isolated, 'session.jsonl')
      writeFileSync(sessionFile, '{}')
      writeAssignment(draftGuidance('g-resume', { sessionFile }), isolated)
      const guidance = testApi.recoveryGuidanceFor(
        { id: 'g-resume', sessionFile },
        isolated,
      )
      assert.ok(guidance)
      assert.match(guidance, /Recovery: subagent_resume\(\{ sessionPath:/)
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('recoveryGuidanceFor: re-spawn guidance for a starting record with no pane', () => {
    const testApi = (subagentsModule as any).__test__
    const isolated = join(mkTmpDir('guidance-'), 'pi-subagents')
    try {
      writeAssignment(
        draftGuidance('g-respawn', { status: 'starting' }),
        isolated,
      )
      const guidance = testApi.recoveryGuidanceFor(
        { id: 'g-respawn' },
        isolated,
      )
      assert.ok(guidance)
      assert.match(guidance, /re-issue the same spawn/)
      assert.doesNotMatch(guidance, /subagent_resume/)
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('recoveryGuidanceFor: fails closed with no guessed resume command', () => {
    const testApi = (subagentsModule as any).__test__
    const isolated = join(mkTmpDir('guidance-'), 'pi-subagents')
    try {
      // missing record
      assert.equal(
        testApi.recoveryGuidanceFor({ id: 'g-none' }, isolated),
        undefined,
      )
      // sessionFile mismatch between record and watcher-observed path
      writeAssignment(draftGuidance('g-mismatch'), isolated)
      assert.equal(
        testApi.recoveryGuidanceFor(
          { id: 'g-mismatch', sessionFile: '/tmp/other.jsonl' },
          isolated,
        ),
        undefined,
      )
      // record path that does not exist on disk
      assert.equal(
        testApi.recoveryGuidanceFor(
          { id: 'g-mismatch', sessionFile: '/tmp/g-mismatch.jsonl' },
          isolated,
        ),
        undefined,
      )
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('deriveResumeHint: re-issue-spawn for starting records without a pane, resume otherwise', () => {
    const starting = draftGuidance('hint-1', { status: 'starting' })
    assert.match(deriveResumeHint(starting) ?? '', /re-issue the same spawn/)
    const withPane = draftGuidance('hint-2', {
      status: 'starting',
      paneId: 'p1',
    })
    assert.match(
      deriveResumeHint(withPane) ?? '',
      /subagent_resume\(\{ sessionPath: "\/tmp\/hint-2\.jsonl" \}\)/,
    )
    assert.equal(deriveResumeHint({ ...starting, sessionFile: '' }), undefined)
  })

  function draftGuidance(
    childId: string,
    overrides?: Partial<Parameters<typeof writeAssignment>[0]>,
  ) {
    return {
      childId,
      name: `agent-${childId}`,
      task: 'do the thing',
      sessionFile: `/tmp/${childId}.jsonl`,
      cwd: '/tmp',
      status: 'working' as const,
      claim: { pid: process.pid, id: 'parent-session-1' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    }
  }

  it('recoveryGuidanceFor: verified agent-error exit falls back to the watcher sessionFile', () => {
    const testApi = (subagentsModule as any).__test__
    const isolated = join(mkTmpDir('guidance-'), 'pi-subagents')
    mkdirSync(isolated, { recursive: true })
    try {
      const sessionFile = join(isolated, 'session.jsonl')
      writeFileSync(sessionFile, '{}')
      // The dominant failure: a verified agent-error exit settles (removes)
      // the record before guidance is read — no record on disk.
      assert.equal(
        testApi.recoveryGuidanceFor({ id: 'g-settled', sessionFile }, isolated),
        undefined,
      )
      const guidance = testApi.recoveryGuidanceFor(
        { id: 'g-settled', sessionFile },
        isolated,
        { verifiedFailure: true },
      )
      assert.ok(guidance)
      assert.match(guidance, /Recovery: subagent_resume\(\{ sessionPath:/)
      // Fail closed: verified flag alone is not enough — a session file that
      // does not exist on disk must not produce a resume command.
      assert.equal(
        testApi.recoveryGuidanceFor(
          { id: 'g-settled', sessionFile: '/tmp/g-settled-missing.jsonl' },
          isolated,
          { verifiedFailure: true },
        ),
        undefined,
      )
      // Crash-inferred endings (verifiedFailure unset) stay silent.
      assert.equal(
        testApi.recoveryGuidanceFor({ id: 'g-settled', sessionFile }, isolated),
        undefined,
      )
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
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
import { basename, relative, sep } from 'node:path'
import { asksDir } from '../pi-extension/subagents/asks.ts'
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
  SUBAGENTS_DATA_DIR_NAMES,
  subagentsDataRoot,
} from '../pi-extension/subagents/dataroot.ts'
import {
  deliveredMarkerPath,
  hasDelivered,
  markDelivered,
} from '../pi-extension/subagents/delivered.ts'
import {
  coalesceOwnerMessages,
  OWNER_MESSAGE_MAX_BYTES,
  type OwnerInboxEntry,
  ownerInboxDir,
  readOwnerInbox,
  removeOwnerMessage,
  sendOwnerMessage,
} from '../pi-extension/subagents/inbox.ts'
import {
  acquireProcessLock,
  isProcessLockClaim,
  keyedProcessLockPath,
  type ProcessLockClaim,
  ProcessLockOccupiedError,
  readProcessLockStatus,
} from '../pi-extension/subagents/lock.ts'
import {
  isPeerRecipientBinding,
  type PeerRecipientBinding,
  peerBindingPath,
  readPeerBinding,
  touchPeerBinding,
  writePeerBinding,
} from '../pi-extension/subagents/peer-bindings.ts'
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
import {
  type PruneReport,
  pruneSubagentsData,
} from '../pi-extension/subagents/retention.ts'
import {
  buildAggregateSnapshot,
  defaultSnapshotReadIo,
} from '../pi-extension/subagents/snapshot.ts'
import {
  allocateSpawnIdentity,
  deriveChildId,
  nextSpawnSeq,
} from '../pi-extension/subagents/spawnseq.ts'
import {
  type ChildToolEffectMemo,
  effectFingerprint,
  effectMemoPath,
  readEffectMemo,
  rewriteEffectMemo,
  writeEffectMemo,
} from '../pi-extension/subagents/tool-effects.ts'
import {
  childGitEnv,
  createSubagentWorktree,
  deriveWorktreeBranch,
  findMainRepoRoot,
  slugifyWorktree,
  WorktreeError,
  worktreePathFor,
} from '../pi-extension/subagents/worktrees.ts'

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('dataroot.ts', () => {
  it('builds the data root under the agent dir', () => {
    assert.equal(subagentsDataRoot('/agents'), join('/agents', 'pi-subagents'))
  })

  it('creates lazily-named subdirs with 0700 and is idempotent', () => {
    const root = mkTmpDir('subagents-dataroot-')
    const dir = ensureSubagentsDataDir('results', root)
    assert.equal(dir, join(root, 'results'))
    assert.ok(statSync(dir).isDirectory())
    assert.equal(modeOf(root), 0o700)
    assert.equal(modeOf(dir), 0o700)
    assert.equal(ensureSubagentsDataDir('results', root), dir)
  })

  it("includes 'tool-effects' in the data dir names and creates it 0700 (PMR-ZJCP)", () => {
    assert.ok(SUBAGENTS_DATA_DIR_NAMES.includes('tool-effects'))
    const root = mkTmpDir('subagents-dataroot-')
    const dir = ensureSubagentsDataDir('tool-effects', root)
    assert.equal(dir, join(root, 'tool-effects'))
    assert.ok(statSync(dir).isDirectory())
    assert.equal(modeOf(dir), 0o700)
  })

  it("includes 'peer-bindings' in the data dir names and creates it 0700", () => {
    assert.ok(SUBAGENTS_DATA_DIR_NAMES.includes('peer-bindings'))
    const root = mkTmpDir('subagents-dataroot-')
    const dir = ensureSubagentsDataDir('peer-bindings', root)
    assert.equal(dir, join(root, 'peer-bindings'))
    assert.ok(statSync(dir).isDirectory())
    assert.equal(modeOf(dir), 0o700)
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

  it('accepts status.hideWhenIdle and defaults it on (PMR-AD0H)', () => {
    assert.equal(DEFAULT_SUBAGENTS_CONFIG.status.hideWhenIdle, true)
    assert.deepEqual(
      validateSubagentsConfig(
        { status: { enabled: true, hideWhenIdle: false } },
        't',
      ),
      { status: { enabled: true, hideWhenIdle: false } },
    )
    // Absent in a pre-existing config ⇒ stays absent; the consumer treats
    // anything but explicit false as hide-when-idle on.
    const absent = validateSubagentsConfig({ status: { enabled: true } }, 't')
    assert.equal(absent.status.hideWhenIdle, undefined)
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true, hideWhenIdle: 'no' } },
          't',
        ),
      /Invalid subagents config in t/,
    )
  })

  it('accepts the watchdog object with opt-out semantics (PMR-YFRB)', () => {
    assert.deepEqual(DEFAULT_SUBAGENTS_CONFIG.watchdog, {
      enabled: true,
      streamStallAfterMs: 150_000,
      quietStallAfterMs: 1_800_000,
    })
    // Absent watchdog ⇒ absent in the typed config (consumer defaults on).
    const absent = validateSubagentsConfig({ status: { enabled: true } }, 't')
    assert.equal(absent.watchdog, undefined)
    // Full object passes through.
    const full = validateSubagentsConfig(
      {
        status: { enabled: true },
        watchdog: {
          enabled: false,
          streamStallAfterMs: 60_000,
          quietStallAfterMs: 600_000,
        },
      },
      't',
    )
    assert.deepEqual(full.watchdog, {
      enabled: false,
      streamStallAfterMs: 60_000,
      quietStallAfterMs: 600_000,
    })
    // Partial object passes through; reconstruction fills nothing implicitly.
    const partial = validateSubagentsConfig(
      { status: { enabled: true }, watchdog: { enabled: false } },
      't',
    )
    assert.deepEqual(partial.watchdog, { enabled: false })
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true }, watchdog: { nope: 1 } },
          't',
        ),
      /Invalid subagents config in t/,
    )
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true }, watchdog: { enabled: 'no' } },
          't',
        ),
      /Invalid subagents config in t/,
    )
  })

  it('accepts optional integer retentionDays, opt-IN (PMR-KT90)', () => {
    // Absent ⇒ absent in the typed config (legacy no-pruning behavior).
    const absent = validateSubagentsConfig({ status: { enabled: true } }, 't')
    assert.equal(absent.retentionDays, undefined)
    assert.equal('retentionDays' in DEFAULT_SUBAGENTS_CONFIG, false)
    // Present ⇒ passes through.
    assert.deepEqual(
      validateSubagentsConfig(
        { status: { enabled: true }, retentionDays: 30 },
        't',
      ),
      { status: { enabled: true }, retentionDays: 30 },
    )
    // Rejects 0, negatives, floats, strings, and unknown siblings.
    for (const bad of [0, -5, 1.5, '30']) {
      assert.throws(
        () =>
          validateSubagentsConfig(
            { status: { enabled: true }, retentionDays: bad },
            't',
          ),
        /Invalid subagents config in t/,
      )
    }
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true }, retentionDays: 30, nope: 1 },
          't',
        ),
      /Invalid subagents config in t/,
    )
    // Scaffold never writes the key into new configs.
    const agentDir = mkTmpDir('subagents-agentdir-')
    scaffoldGlobalSubagentsConfig(agentDir)
    const onDisk = JSON.parse(
      readFileSync(globalSubagentsConfigPath(agentDir), 'utf8'),
    )
    assert.equal('retentionDays' in onDisk, false)
  })

  it('scaffolds the global config only when missing and never overwrites', () => {
    const agentDir = mkTmpDir('subagents-agentdir-')
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
    const agentDir = mkTmpDir('subagents-agentdir-')
    const cwd = mkTmpDir('subagents-cwd-')
    const loaded = loadSubagentsConfig(cwd, agentDir)
    assert.deepEqual(loaded.config, DEFAULT_SUBAGENTS_CONFIG)
    assert.equal(loaded.source, globalSubagentsConfigPath(agentDir))
  })

  it('lets the project override win and fails fast on invalid config', () => {
    const agentDir = mkTmpDir('subagents-agentdir-')
    const cwd = mkTmpDir('subagents-cwd-')
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
    const dir = mkTmpDir('subagents-lock-')
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
    const dir = mkTmpDir('subagents-lock-')
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
    const dir = mkTmpDir('subagents-lock-')
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
    storeRoot = join(mkTmpDir('store-'), 'pi-subagents')
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

describe('inspectResultRef tri-state (PMR-KT90)', () => {
  let storeRoot: string
  before(() => {
    storeRoot = mkdtempSync(join(tmpdir(), 'pi-subagents-inspect-'))
  })
  after(() => {
    rmSync(storeRoot, { recursive: true, force: true })
  })

  it('returns the record path for a live record', () => {
    const written = writeResultRecord(
      {
        childId: 'c-1',
        name: 'worker',
        summary: 'done',
        sessionFile: null,
      },
      storeRoot,
    )
    const ref = allocateSemanticRef('worker', storeRoot, written.canonicalId)
    assert.deepEqual(inspectResultRef(ref, storeRoot), {
      kind: 'path',
      path: written.path,
    })
  })

  it('returns expired when the marker survives but the record is pruned', () => {
    // Marker with a canonicalId that has no results record on disk — the only
    // state results-pruning can newly produce.
    const ref = allocateSemanticRef('worker', storeRoot, randomUUID())
    assert.deepEqual(inspectResultRef(ref, storeRoot), { kind: 'expired' })
  })

  it('returns missing for absent and empty markers', () => {
    assert.deepEqual(inspectResultRef('result:worker#99999', storeRoot), {
      kind: 'missing',
    })
    const emptyRef = allocateSemanticRef('worker', storeRoot)
    assert.deepEqual(inspectResultRef(emptyRef, storeRoot), {
      kind: 'missing',
    })
  })

  it('returns missing for garbage refs', () => {
    assert.deepEqual(inspectResultRef('garbage', storeRoot), {
      kind: 'missing',
    })
  })

  it('exports the expired message verbatim', () => {
    assert.equal(
      RESULT_REF_EXPIRED_MESSAGE,
      'result expired by retention policy',
    )
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

describe('interrupt watermark (PMR-J3WY replay-safe interrupts)', () => {
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

  function makeWatermark(overrides: Record<string, unknown> = {}) {
    return {
      toolCallId: 'tc-1',
      childId: 'a1',
      sessionFile: 'a1.jsonl',
      requestId: 'req-1',
      sentAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  function makeWatermarkIo(root: string, written: ControlRecord[]) {
    return {
      writeControlRecord: (record: ControlRecord) => {
        written.push(record)
      },
      readAckSidecar: () => null,
      readControlRecord: () => null,
      cleanupAck: () => {},
      readInterruptWatermark: (toolCallId: string) =>
        readInterruptWatermark(toolCallId, root),
      claimInterruptWatermark: (watermark: InterruptWatermark) =>
        claimInterruptWatermark(watermark, root),
    }
  }

  it('claims the watermark before the first send and correlates the requestId', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    const written: ControlRecord[] = []
    const io = makeWatermarkIo(root, written)
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = 0
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())
      const result = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        () => {
          sent++
        },
        io,
        'tc-1',
      )

      assert.equal(sent, 1)
      assert.equal(result.details.status, 'interrupt_requested')
      const watermark = readInterruptWatermark('tc-1', root)
      assert.ok(watermark)
      assert.equal(watermark?.childId, 'a1')
      assert.equal(watermark?.sessionFile, 'a1.jsonl')
      assert.equal(written.length, 1)
      assert.equal(written[0].requestId, watermark?.requestId)
      const state = runningMap.get('a1').statusState
      assert.equal(state.pendingRequest?.requestId, watermark?.requestId)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('suppresses a replayed interrupt: no second Escape, no second pending request', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    const written: ControlRecord[] = []
    const io = makeWatermarkIo(root, written)
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = 0
    const send = () => {
      sent++
    }
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())
      const first = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        send,
        io,
        'tc-1',
      )
      assert.equal(first.details.status, 'interrupt_requested')
      const firstRequestId = written[0].requestId

      const replay = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        send,
        io,
        'tc-1',
      )
      assert.equal(replay.details.status, 'interrupt_replayed')
      assert.equal(sent, 1)
      assert.equal(written.length, 1)
      const state = runningMap.get('a1').statusState
      assert.equal(state.pendingRequest?.requestId, firstRequestId)

      // Simulated parent restart: the in-memory map is rebuilt from scratch,
      // so the fresh entry carries no pending request. The durable watermark
      // alone must still suppress the replay.
      runningMap.clear()
      runningMap.set('a1', makeRunning())
      const afterRestart = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        send,
        io,
        'tc-1',
      )
      assert.equal(afterRestart.details.status, 'interrupt_replayed')
      assert.equal(sent, 1)
      assert.equal(written.length, 1)
      const freshState = runningMap.get('a1').statusState
      assert.equal(freshState.pendingRequest, null)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to send Escape when the watermark names a different child or session', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    const written: ControlRecord[] = []
    const io = makeWatermarkIo(root, written)
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = 0
    runningMap.clear()

    try {
      claimInterruptWatermark(
        makeWatermark({ childId: 'other', sessionFile: 'other.jsonl' }),
        root,
      )
      runningMap.set('a1', makeRunning())
      const result = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        () => {
          sent++
        },
        io,
        'tc-1',
      )

      assert.equal(sent, 0)
      assert.equal(
        result.details.error,
        'interrupt watermark identity mismatch',
      )
      assert.equal(written.length, 0)
      const state = runningMap.get('a1').statusState
      assert.equal(state.pendingRequest, null)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // PMR-TR96: the two remaining watermark-gate branches — a throwing claim
  // degrades fail-open to the legacy send (same precedent as the control
  // record write), and a lost claim race re-reads the winner and suppresses.
  it('degrades to the legacy send when the watermark claim throws (fail-open)', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    const written: ControlRecord[] = []
    const io = {
      ...makeWatermarkIo(root, written),
      claimInterruptWatermark: () => {
        throw new Error('disk full')
      },
    }
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = 0
    runningMap.clear()

    try {
      runningMap.set('a1', makeRunning())
      const result = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        () => {
          sent++
        },
        io,
        'tc-1',
      )

      assert.equal(sent, 1, 'a claim throw must not block the Escape')
      assert.equal(result.details.status, 'interrupt_requested')
      assert.equal(written.length, 1)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lost claim race re-reads the winner watermark and suppresses the send', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    const written: ControlRecord[] = []
    const io = {
      ...makeWatermarkIo(root, written),
      // A concurrent claimer always wins.
      claimInterruptWatermark: () => false,
    }
    const testApi = (subagentsModule as any).__test__
    const runningMap = testApi.runningSubagents as Map<string, any>
    let sent = 0
    runningMap.clear()

    try {
      // Pre-seed the winner's watermark (matching identity).
      claimInterruptWatermark(makeWatermark(), root)
      runningMap.set('a1', makeRunning())
      const result = testApi.handleSubagentInterrupt(
        { id: 'a1' },
        () => {
          sent++
        },
        io,
        'tc-1',
      )

      assert.equal(sent, 0)
      assert.equal(result.details.status, 'interrupt_replayed')
      assert.equal(written.length, 0)
    } finally {
      runningMap.clear()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('watermark primitives claim once, round trip, and fail closed on malformed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-'))
    try {
      const watermark = makeWatermark()
      assert.equal(claimInterruptWatermark(watermark, root), true)
      assert.equal(claimInterruptWatermark(watermark, root), false)
      assert.deepEqual(readInterruptWatermark('tc-1', root), watermark)
      assert.equal(readInterruptWatermark('no-such-call', root), null)
      assert.equal(interruptWatermarkMatches(watermark, 'a1', 'a1.jsonl'), true)
      assert.equal(
        interruptWatermarkMatches(watermark, 'a2', 'a1.jsonl'),
        false,
      )
      assert.equal(
        interruptWatermarkMatches(watermark, 'a1', 'a2.jsonl'),
        false,
      )

      writeFileSync(interruptWatermarkPath('bad', root), 'not json')
      assert.equal(readInterruptWatermark('bad', root), null)
      writeFileSync(
        interruptWatermarkPath('partial', root),
        JSON.stringify({ toolCallId: 'partial' }),
      )
      assert.equal(readInterruptWatermark('partial', root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('readInterruptWatermark fails closed when the stored toolCallId differs from the filename key', () => {
    // The filename is a lossy sanitized key: a stale or colliding file must
    // not be trusted as this call's watermark (PMR-DYQN).
    const root = mkdtempSync(join(tmpdir(), 'subagents-watermark-id-'))
    try {
      // `a/b` and `a b` both sanitize to `a_b.json` (every
      // non-[A-Za-z0-9._-] char maps to `_`); claim `a/b`'s file first, then
      // write a record whose stored id is the genuinely colliding twin `a b`.
      writeFileSync(
        interruptWatermarkPath('a/b', root),
        JSON.stringify(makeWatermark({ toolCallId: 'a b' })),
      )
      assert.equal(readInterruptWatermark('a/b', root), null)
      assert.notEqual(readInterruptWatermark('a b', root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
    // PMR-X7BH: rows carry a kind emoji, bold name, italic status — strip SGR
    // before the shape match, then pin the bold-name SGR once.
    assert.match(
      rendered.lines[1].replace(/\x1b\[[0-9;]*m/g, ''),
      /^[●◌] 🏃 Worker · (working|starting) /,
    )
    assert.ok(rendered.lines[1].includes('\x1b[1mWorker\x1b[22m'))
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
    assert.match(
      rendered.lines[1].replace(/\x1b\[[0-9;]*m/g, ''),
      /^◌ 🏃 Worker · starting /,
    )
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

describe('subagents widget lifecycle (PMR-AD0H)', () => {
  const testApi = (subagentsModule as any).__test__ as {
    updateWidgetForTest: (ctx: unknown) => void
    isWidgetRegisteredForTest: () => boolean
    setWidgetRegisteredForTest: (value: boolean) => void
    setWidgetTuiForTest: (tui: { requestRender: () => void } | null) => void
    setHideWhenIdleForTest: (value: boolean | undefined) => void
    runningSubagents: Map<string, unknown>
  }

  function recordingWidgetCtx() {
    const widgets: Array<[string, unknown]> = []
    const statuses: Array<[string, string | undefined]> = []
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(key: string, content: unknown) {
          widgets.push([key, content])
        },
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text])
        },
      },
    }
    return { ctx, widgets, statuses }
  }

  function resetWidgetState() {
    testApi.setWidgetRegisteredForTest(false)
    testApi.setWidgetTuiForTest(null)
    testApi.setHideWhenIdleForTest(undefined)
  }

  it('unregisters a registered widget when the map is empty', () => {
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({ requestRender() {} })
    const { ctx, widgets } = recordingWidgetCtx()
    try {
      testApi.updateWidgetForTest(ctx)

      assert.deepEqual(widgets, [['subagent-status', undefined]])
      assert.equal(testApi.isWidgetRegisteredForTest(), false)
    } finally {
      resetWidgetState()
    }
  })

  it('unregisters defensively even when the module flags say unregistered', () => {
    // /reload orphan: pi's UI kept the old component, but this module
    // instance has no registration state — removal must not be flag-gated.
    testApi.setWidgetRegisteredForTest(false)
    testApi.setWidgetTuiForTest(null)
    const { ctx, widgets } = recordingWidgetCtx()
    try {
      testApi.updateWidgetForTest(ctx)

      assert.deepEqual(widgets, [['subagent-status', undefined]])
      assert.equal(testApi.isWidgetRegisteredForTest(), false)
    } finally {
      resetWidgetState()
    }
  })

  it('keeps a registered widget visible at zero when hideWhenIdle=false', () => {
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({ requestRender() {} })
    testApi.setHideWhenIdleForTest(false)
    const { ctx, widgets } = recordingWidgetCtx()
    try {
      testApi.updateWidgetForTest(ctx)

      assert.deepEqual(widgets, [])
      assert.equal(testApi.isWidgetRegisteredForTest(), true)
    } finally {
      resetWidgetState()
    }
  })

  it('takes the cheap requestRender path when registered and non-empty', () => {
    let renders = 0
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({
      requestRender() {
        renders++
      },
    })
    const { ctx, widgets } = recordingWidgetCtx()
    testApi.runningSubagents.set('widget-lifecycle-fixture', {
      id: 'widget-lifecycle-fixture',
    })
    try {
      testApi.updateWidgetForTest(ctx)

      assert.equal(renders, 1)
      assert.deepEqual(widgets, [])
      assert.equal(testApi.isWidgetRegisteredForTest(), true)
    } finally {
      testApi.runningSubagents.delete('widget-lifecycle-fixture')
      resetWidgetState()
    }
  })

  it('sets the footer status before the cheap-path early return (PMR-C3B6)', () => {
    // A running subagent + registered widget takes the cheap path, but the
    // footer must still be recorded — proving setStatus runs before the
    // early return, not only on the full render path.
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({ requestRender() {} })
    const { ctx, widgets, statuses } = recordingWidgetCtx()
    testApi.runningSubagents.set('widget-lifecycle-fixture', {
      id: 'widget-lifecycle-fixture',
    })
    try {
      testApi.updateWidgetForTest(ctx)

      assert.deepEqual(statuses, [['subagents', '🤖 1 running']])
      assert.deepEqual(widgets, [])
    } finally {
      testApi.runningSubagents.delete('widget-lifecycle-fixture')
      resetWidgetState()
    }
  })

  it('clears the footer status at zero with the hideWhenIdle default', () => {
    const { ctx, statuses } = recordingWidgetCtx()
    try {
      testApi.updateWidgetForTest(ctx)

      const last = statuses[statuses.length - 1]
      assert.deepEqual(last, ['subagents', undefined])
    } finally {
      resetWidgetState()
    }
  })

  it('clears the footer status at zero when hideWhenIdle=false', () => {
    testApi.setHideWhenIdleForTest(false)
    const { ctx, statuses } = recordingWidgetCtx()
    try {
      testApi.updateWidgetForTest(ctx)

      const last = statuses[statuses.length - 1]
      assert.deepEqual(last, ['subagents', undefined])
    } finally {
      resetWidgetState()
    }
  })

  it('re-sets the footer on a fresh ctx during reconcile with running subagents', () => {
    // After a session switch the new ctx must receive the footer again,
    // even though the widget itself stays on the cheap path.
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({ requestRender() {} })
    const first = recordingWidgetCtx()
    testApi.runningSubagents.set('widget-lifecycle-fixture', {
      id: 'widget-lifecycle-fixture',
    })
    try {
      testApi.updateWidgetForTest(first.ctx)

      const fresh = recordingWidgetCtx()
      testApi.updateWidgetForTest(fresh.ctx)

      assert.deepEqual(fresh.statuses, [['subagents', '🤖 1 running']])
      assert.deepEqual(fresh.widgets, [])
    } finally {
      testApi.runningSubagents.delete('widget-lifecycle-fixture')
      resetWidgetState()
    }
  })

  it('swallows setStatus throws from a stale ctx and still handles the widget', () => {
    // A stale ctx (/reload orphan) may not support setStatus; the throw
    // must not escape and the widget unregister below must still run.
    testApi.setWidgetRegisteredForTest(true)
    testApi.setWidgetTuiForTest({ requestRender() {} })
    const widgets: Array<[string, unknown]> = []
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(key: string, content: unknown) {
          widgets.push([key, content])
        },
        setStatus(_key: string, _text: string | undefined) {
          throw new Error('stale ctx')
        },
      },
    }
    try {
      testApi.updateWidgetForTest(ctx)

      assert.deepEqual(widgets, [['subagent-status', undefined]])
      assert.equal(testApi.isWidgetRegisteredForTest(), false)
    } finally {
      resetWidgetState()
    }
  })

  it('reconciles registration on session_start after a session switch', async () => {
    await withIsolatedAgentEnv(async ({ projectDir }) => {
      resetWidgetState()
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)

      const handlers = eventHandlers.get('session_start') ?? []
      assert.equal(handlers.length, 1)
      const { ctx, widgets } = recordingWidgetCtx()
      handlers[0](
        {},
        {
          ...ctx,
          cwd: projectDir,
          sessionManager: { getSessionId: () => 'widget-lifecycle-session' },
        },
      )

      assert.deepEqual(widgets, [['subagent-status', undefined]])
      assert.equal(testApi.isWidgetRegisteredForTest(), false)
    })
  })

  it('session_start reconcile keeps an opted-in widget untouched when hideWhenIdle=false (PMR-6XS4)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir }) => {
      // hideWhenIdle=false comes from project config: session_start reloads
      // config from disk (loadAndCacheStatusConfig) before reconciling, so a
      // setHideWhenIdleForTest seed would be overwritten.
      const configDir = join(projectDir, '.pi', 'pi-subagents')
      mkdirSync(configDir, { recursive: true })
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ status: { enabled: true, hideWhenIdle: false } }),
      )

      resetWidgetState()
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)

      const handlers = eventHandlers.get('session_start') ?? []
      assert.equal(handlers.length, 1)
      // Widget registered before the session switch (the persistent
      // "0 running" box is the intentional opt-out)...
      testApi.setWidgetRegisteredForTest(true)
      testApi.setWidgetTuiForTest({ requestRender() {} })
      const { ctx, widgets } = recordingWidgetCtx()
      handlers[0](
        {},
        {
          ...ctx,
          cwd: projectDir,
          sessionManager: { getSessionId: () => 'widget-lifecycle-session' },
        },
      )

      // ...must leave the box untouched: no removal call, registration stays.
      assert.deepEqual(widgets, [])
      assert.equal(testApi.isWidgetRegisteredForTest(), true)
      // session_start cached hideWhenIdle=false on globalThis — restore the
      // default-on cache so later suites start from the default.
      resetWidgetState()
    })
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
  it('observes .exit first, .ask before the liveness probe; stall last (PMR-YFRB)', () => {
    const order = POLL_CHECK_ORDER
    assert.ok(order.indexOf('exit') < order.indexOf('ask'))
    assert.ok(order.indexOf('ask') < order.indexOf('liveness'))
    assert.ok(order.indexOf('liveness') < order.indexOf('stall'))
    assert.equal(order[order.length - 1], 'stall')
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

  // AIDEV-NOTE (PMR-YFRB): checkStall precedence — the watchdog hook is the
  // LAST check of the tick, so verified exits, the blocked-`.ask` carve-out,
  // and definitive crash inference always win over a stall escalation.
  const stalledResult = {
    reason: 'error',
    exitCode: 1,
    errorMessage: 'Subagent turn stalled: no activity for too long.',
  } as const

  it('checkStall non-null result resolves the poll (stall fires)', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const result = await pollForExit(
      'w1:p1',
      AbortSignal.timeout(1000),
      opts({ checkStall: () => ({ ...stalledResult }) }),
    )
    assert.equal(result.reason, 'error')
    assert.match(result.errorMessage ?? '', /turn stalled/)
  })

  it('.exit sidecar beats a would-fire checkStall', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const dir = mkdtempSync(join(tmpdir(), 'poll-exit-'))
    const sessionFile = join(dir, 's.jsonl')
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: 'done' }),
      'utf8',
    )
    const result = await pollForExit(
      'w1:p1',
      AbortSignal.timeout(1000),
      opts({ sessionFile, checkStall: () => ({ ...stalledResult }) }),
    )
    assert.equal(result.reason, 'done')
    rmSync(dir, { recursive: true, force: true })
  })

  it('.ask present + would-fire checkStall keeps polling (blocked carve-out wins)', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const dir = mkdtempSync(join(tmpdir(), 'poll-ask-'))
    const sessionFile = join(dir, 's.jsonl')
    writeFileSync(`${sessionFile}.ask`, JSON.stringify({ askId: 'a1' }), 'utf8')
    const controller = new AbortController()
    let stallCalls = 0
    const p = pollForExit(
      'w1:p1',
      controller.signal,
      opts({
        sessionFile,
        checkStall: () => {
          stallCalls++
          return { ...stalledResult }
        },
      }),
    )
    // Give the loop a few ticks; stall never resolves because `.ask`
    // short-circuits each tick before the watchdog ever runs.
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(p, /Aborted/)
    // The watchdog hook was never reached while the `.ask` sidecar persisted.
    assert.equal(stallCalls, 0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('isAlive false + would-fire checkStall: crash-inference message wins', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const result = await pollForExit(
      'w1:pGONE',
      AbortSignal.timeout(1000),
      opts({
        isAlive: () => false,
        checkStall: () => ({ ...stalledResult }),
      }),
    )
    assert.equal(result.reason, 'error')
    assert.equal(result.exitCode, 1)
    assert.match(
      result.errorMessage ?? '',
      /disappeared without an exit sidecar/,
    )
  })
})

describe('stall watchdog escalation wiring (PMR-YFRB phase 3)', () => {
  const testApi = (subagentsModule as any).__test__ as {
    getWatchdogThresholds: () => StallThresholds
    setWatchdogThresholdsForTest: (value: StallThresholds | undefined) => void
  }
  const SHRUNK: StallThresholds = {
    enabled: true,
    streamStallAfterMs: 30,
    quietStallAfterMs: 30,
  }

  after(() => {
    testApi.setWatchdogThresholdsForTest(undefined)
  })

  // Real activity snapshot on disk — the observe → classify → escalate chain
  // reads THIS file, not a synthetic statusState.
  function writeActivitySnapshot(
    dir: string,
    id: string,
    updatedAt: number,
  ): string {
    const activityFile = getSubagentActivityFile(dir, id)
    mkdirSync(dirname(activityFile), { recursive: true })
    writeFileSync(
      activityFile,
      JSON.stringify({
        version: 1,
        runningChildId: id,
        createdAt: updatedAt - 60_000,
        updatedAt,
        sequence: 1,
        latestEvent: 'before_provider_request',
        phase: 'active',
        agentActive: true,
        turnActive: true,
        providerActive: true,
        toolActive: false,
        activeScope: 'streaming',
        activeSince: updatedAt - 60_000,
      }),
      'utf8',
    )
    return activityFile
  }

  function fakeRunner(
    activityFile: string | undefined,
    overrides: { interactive?: boolean; cli?: string } = {},
  ) {
    return {
      id: 'child-stall',
      name: 'Worker',
      task: '',
      surface: 'w1:p1',
      paneId: 'w1:p1',
      startTime: Date.now() - 60_000,
      sessionFile: '',
      activityFile,
      interactive: overrides.interactive === true,
      ...(overrides.cli !== undefined ? { cli: overrides.cli } : {}),
      statusState: createStatusState({
        source:
          overrides.cli === 'claude' ? ('claude' as const) : ('pi' as const),
        startTimeMs: Date.now() - 60_000,
      }),
    } as any
  }

  it('maps absent watchdog config to defaults and disabled to legacy', () => {
    const { watchdogThresholdsFromConfig } = subagentsModule
    assert.deepEqual(watchdogThresholdsFromConfig(undefined), {
      enabled: true,
      streamStallAfterMs: STREAM_STALL_AFTER_MS,
      quietStallAfterMs: QUIET_STALL_AFTER_MS,
    })
    assert.deepEqual(watchdogThresholdsFromConfig({}), {
      enabled: true,
      streamStallAfterMs: STREAM_STALL_AFTER_MS,
      quietStallAfterMs: QUIET_STALL_AFTER_MS,
    })
    assert.deepEqual(watchdogThresholdsFromConfig({ enabled: false }), {
      enabled: false,
      streamStallAfterMs: STREAM_STALL_AFTER_MS,
      quietStallAfterMs: QUIET_STALL_AFTER_MS,
    })
    assert.deepEqual(watchdogThresholdsFromConfig({ streamStallAfterMs: 42 }), {
      enabled: true,
      streamStallAfterMs: 42,
      quietStallAfterMs: QUIET_STALL_AFTER_MS,
    })
  })

  it('caches thresholds on globalThis with a default fallback', () => {
    testApi.setWatchdogThresholdsForTest(SHRUNK)
    assert.deepEqual(testApi.getWatchdogThresholds(), SHRUNK)
    testApi.setWatchdogThresholdsForTest(undefined)
    assert.equal(testApi.getWatchdogThresholds().enabled, true)
    assert.equal(
      testApi.getWatchdogThresholds().streamStallAfterMs,
      STREAM_STALL_AFTER_MS,
    )
  })

  it('carve-outs: interactive and claude children get no escalation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-carve-'))
    try {
      testApi.setWatchdogThresholdsForTest(SHRUNK)
      const activityFile = writeActivitySnapshot(
        dir,
        'child-stall',
        Date.now() - 60_000,
      )
      const interactive = subagentsModule.makeCheckStall(
        fakeRunner(activityFile, { interactive: true }),
      )
      assert.equal(interactive(), null)
      const claude = subagentsModule.makeCheckStall(
        fakeRunner(activityFile, { cli: 'claude' }),
      )
      assert.equal(claude(), null)
    } finally {
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('error precedence: stall message wins over a partial assistant message', () => {
    const { resolvePiResultSummary } = subagentsModule
    withTempDir((dir) => {
      const sessionFile = join(dir, 's.jsonl')
      // Dead turn: a partial thinking-only assistant entry is the LAST entry.
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [],
          },
        })}\n`,
        'utf8',
      )
      const stall = {
        reason: 'error',
        exitCode: 1,
        errorMessage: 'Subagent turn stalled: streaming inactive for 1s.',
      } as any
      assert.equal(
        resolvePiResultSummary(stall, sessionFile),
        'Subagent error: Subagent turn stalled: streaming inactive for 1s.',
      )
      // Non-error results keep the assistant-message-first behavior.
      const doneWithAssistant = {
        reason: 'done',
        exitCode: 0,
      } as any
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Real summary content.' }],
          },
        })}\n`,
        'utf8',
      )
      assert.equal(
        resolvePiResultSummary(doneWithAssistant, sessionFile),
        'Real summary content.',
      )
    })
  })

  it('(a) dead-turn repro: frozen streaming snapshot + live pane escalates', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const dir = mkdtempSync(join(tmpdir(), 'stall-dead-turn-'))
    try {
      testApi.setWatchdogThresholdsForTest(SHRUNK)
      const activityFile = writeActivitySnapshot(
        dir,
        'child-stall',
        Date.now() - 1_000,
      )
      const running = fakeRunner(activityFile)
      const result = await pollForExit('w1:p1', AbortSignal.timeout(2000), {
        interval: 5,
        sessionFile: join(dir, 's.jsonl'),
        isAlive: () => true,
        checkStall: subagentsModule.makeCheckStall(running),
      } as any)
      assert.equal(result.reason, 'error')
      assert.equal(result.exitCode, 1)
      assert.match(
        result.errorMessage ?? '',
        /Subagent turn stalled: streaming inactive/,
      )
    } finally {
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('(b) vanished-pane repro: throwing probe + missing snapshot escalates', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const dir = mkdtempSync(join(tmpdir(), 'stall-vanished-'))
    try {
      testApi.setWatchdogThresholdsForTest({
        enabled: true,
        streamStallAfterMs: 30,
        quietStallAfterMs: 20,
      })
      // No activity file ever written; probe fails open (throws → alive).
      const running = fakeRunner(getSubagentActivityFile(dir, 'child-stall'))
      const started = Date.now()
      const result = await pollForExit('w1:p1', AbortSignal.timeout(2000), {
        interval: 5,
        sessionFile: join(dir, 's.jsonl'),
        isAlive: () => {
          throw new Error('herdr unreachable')
        },
        checkStall: subagentsModule.makeCheckStall(running),
      } as any)
      assert.equal(result.reason, 'error')
      assert.equal(result.exitCode, 1)
      assert.match(
        result.errorMessage ?? '',
        /Subagent turn stalled: no activity snapshot/,
      )
      assert.ok(Date.now() - started < 1_500)
    } finally {
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('(c) no-false-positive: advancing streaming activity never escalates', async () => {
    const { pollForExit } = await import('../pi-extension/subagents/surface.ts')
    const dir = mkdtempSync(join(tmpdir(), 'stall-advancing-'))
    const activityFile = getSubagentActivityFile(dir, 'child-stall')
    const writer = setInterval(() => {
      try {
        writeActivitySnapshot(dir, 'child-stall', Date.now())
      } catch {}
    }, 10)
    try {
      testApi.setWatchdogThresholdsForTest({
        enabled: true,
        streamStallAfterMs: 60,
        quietStallAfterMs: 60,
      })
      writeActivitySnapshot(dir, 'child-stall', Date.now())
      const running = fakeRunner(activityFile)
      // ~90+ ticks at interval 5; the abort (not a stall) must end the poll.
      await assert.rejects(
        pollForExit('w1:p1', AbortSignal.timeout(500), {
          interval: 5,
          sessionFile: join(dir, 's.jsonl'),
          isAlive: () => true,
          checkStall: subagentsModule.makeCheckStall(running),
        } as any),
        /Aborted/,
      )
    } finally {
      clearInterval(writer)
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('(d) widget: dead-turn snapshot renders stalled marker + dead turn detail', () => {
    const { renderSupervisionRows, statusKindOf, markerFor } = subagentsModule
    const dir = mkdtempSync(join(tmpdir(), 'stall-widget-'))
    try {
      testApi.setWatchdogThresholdsForTest(SHRUNK)
      const now = Date.now()
      let state = createStatusState({ source: 'pi', startTimeMs: now - 60_000 })
      state = observeStatus(
        state,
        {
          snapshot: 'present',
          updatedAt: now - 1_000,
          sequence: 1,
          phase: 'active',
          active: true,
          activeScope: 'streaming',
          activeSince: now - 1_000,
          latestEvent: 'before_provider_request',
        },
        now,
      )
      const running = {
        id: 'child-stall',
        name: 'Worker',
        task: '',
        surface: 'pane-child-stall',
        paneId: 'w1:pchild-stall',
        startTime: now - 60_000,
        sessionFile: 'sess-1',
        interactive: false,
        statusState: state,
      } as any
      assert.equal(statusKindOf(running, now), 'stalled')
      assert.equal(markerFor('stalled'), '?')
      const rendered = renderSupervisionRows([running], now)
      assert.match(
        rendered.lines[1].replace(/\x1b\[[0-9;]*m/g, ''),
        /^\? ⚠️ Worker · stalled /,
      )
      const snapshot = classifyStatus(running.statusState, now, SHRUNK)
      assert.match(formatStatusLine(running.name, snapshot), /dead turn/)
    } finally {
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('(e) widget: formatAgentRow renders stalled row for a dead-turn snapshot (PMR-YFRB)', () => {
    const { formatAgentRow } = subagentsModule.__test__
    const { statusKindOf, markerFor } = subagentsModule
    const dir = mkdtempSync(join(tmpdir(), 'stall-row-'))
    try {
      testApi.setWatchdogThresholdsForTest(SHRUNK)
      const now = Date.now()
      let state = createStatusState({ source: 'pi', startTimeMs: now - 60_000 })
      state = observeStatus(
        state,
        {
          snapshot: 'present',
          updatedAt: now - 1_000,
          sequence: 1,
          phase: 'active',
          active: true,
          activeScope: 'streaming',
          activeSince: now - 1_000,
          latestEvent: 'before_provider_request',
        },
        now,
      )
      const running = {
        id: 'child-row',
        name: 'RowWorker',
        task: '',
        surface: 'pane-child-row',
        paneId: 'w1:pchild-row',
        startTime: now - 60_000,
        sessionFile: 'sess-1',
        interactive: false,
        statusState: state,
      } as any
      assert.equal(statusKindOf(running, now), 'stalled')
      // The detail label lives at classification level: formatAgentRow renders
      // the kind ('stalled'), not statusLabel, so assert 'dead turn' at its
      // actual source (the row-level label rendering is covered by the
      // formatStatusLine/renderSupervisionRows tests above).
      const snapshot = classifyStatus(running.statusState, now, SHRUNK)
      assert.equal(snapshot.statusLabel, 'dead turn')
      const row = formatAgentRow(running, now)
      assert.match(
        row.line.replace(/\x1b\[[0-9;]*m/g, ''),
        /^\? ⚠️ RowWorker · stalled /,
      )
      assert.equal(markerFor('stalled'), '?')
    } finally {
      testApi.setWatchdogThresholdsForTest(undefined)
      rmSync(dir, { recursive: true, force: true })
    }
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
    peersRoot = join(mkTmpDir('peers-'), 'pi-subagents')
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

describe('inbox.ts (PMR-QCVA owner messaging)', () => {
  let inboxRoot: string

  before(() => {
    inboxRoot = join(mkTmpDir('owner-inbox-'), 'pi-subagents')
  })
  after(() => {
    rmSync(inboxRoot, { recursive: true, force: true })
  })

  it('writes durable records, drains exactly once, deletes drained files', () => {
    const parent = 'parent-session-1'
    const first = sendOwnerMessage({
      parentSessionId: parent,
      childId: 'kid1',
      name: 'Kid One',
      message: 'hello owner',
      root: inboxRoot,
    })
    const second = sendOwnerMessage({
      parentSessionId: parent,
      childId: 'kid2',
      message: 'multi\nline message',
      root: inboxRoot,
    })
    const entries = readOwnerInbox(parent, inboxRoot)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].message.childId, 'kid1')
    assert.equal(entries[0].message.name, 'Kid One')
    assert.equal(entries[1].message.message, 'multi\nline message')
    assert.notEqual(first.path, second.path)

    // Drain: remove each entry exactly once, inbox then reads empty.
    for (const entry of entries) removeOwnerMessage(entry.path)
    assert.equal(readOwnerInbox(parent, inboxRoot).length, 0)
    // Double remove is a no-op (idempotent unlink).
    removeOwnerMessage(first.path)
  })

  it('isolates inboxes per parent session id and per-child seq', () => {
    sendOwnerMessage({
      parentSessionId: 'parent-a',
      childId: 'kid',
      message: 'for a',
      root: inboxRoot,
    })
    sendOwnerMessage({
      parentSessionId: 'parent-b',
      childId: 'kid',
      message: 'for b',
      root: inboxRoot,
    })
    sendOwnerMessage({
      parentSessionId: 'parent-a',
      childId: 'kid',
      message: 'for a again',
      root: inboxRoot,
    })
    const a = readOwnerInbox('parent-a', inboxRoot)
    const b = readOwnerInbox('parent-b', inboxRoot)
    assert.equal(a.length, 2)
    assert.equal(b.length, 1)
    assert.equal(a[1].message.message, 'for a again')
  })

  it('rejects messages above the 8 KiB cap', () => {
    assert.throws(
      () =>
        sendOwnerMessage({
          parentSessionId: 'cap-parent',
          childId: 'kid',
          message: 'x'.repeat(OWNER_MESSAGE_MAX_BYTES),
          root: inboxRoot,
        }),
      /cap/,
    )
  })

  it('coalesces one bullet per message and caps with overflow', () => {
    const entries: OwnerInboxEntry[] = [
      {
        path: '/p/1.json',
        message: {
          version: 1,
          messageId: 'm1',
          childId: 'kid1',
          name: 'Scout',
          message: 'first finding\nmore detail',
          sentAt: new Date().toISOString(),
        },
      },
      {
        path: '/p/2.json',
        message: {
          version: 1,
          messageId: 'm2',
          childId: 'kid2',
          message: 'second',
          sentAt: new Date().toISOString(),
        },
      },
      {
        path: '/p/3.json',
        message: {
          version: 1,
          messageId: 'm3',
          childId: 'kid3',
          name: 'Third',
          message: 'third',
          sentAt: new Date().toISOString(),
        },
      },
    ]
    const coalesced = coalesceOwnerMessages(entries, 2)
    assert.deepEqual(coalesced.lines, [
      'Scout: first finding',
      'kid2: second',
      'Third: third',
    ])
    assert.deepEqual(coalesced.visibleLines, [
      'Scout: first finding',
      'kid2: second',
    ])
    assert.equal(coalesced.overflow, 1)
  })

  it('ignores malformed records instead of surfacing them', () => {
    const parent = 'malformed-parent'
    const dir = ownerInboxDir(parent, inboxRoot)
    writeFileSync(join(dir, 'kid-000001.json'), '{not json')
    writeFileSync(
      join(dir, 'kid-000002.json'),
      JSON.stringify({ version: 999, message: 'wrong' }),
    )
    const entries = readOwnerInbox(parent, inboxRoot)
    assert.equal(entries.length, 0)
    // Cleanup so later assertions on other parents stay isolated.
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── worktrees.ts (PMR-11TD) ──

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

describe('worktrees.ts (PMR-11TD)', () => {
  // AIDEV-NOTE: PMR-S6W3 — fixture git calls must not inherit hook env
  // (GIT_DIR et al.) either, or they would hit the ambient repo.
  function gitExec(
    args: string[],
    options: { stdio?: 'ignore' | 'pipe' } = {},
  ): string {
    return execFileSync('git', args, {
      encoding: 'utf8',
      ...options,
      env: childGitEnv(),
    })
  }

  // AIDEV-NOTE: PMR-CM6D cleanup-collision guard. The old cleanup blindly
  // rmSync'd ~/.herdr/worktrees/<basename(repo)>, which could destroy a REAL
  // same-named repo's worktree dir. Now only worktree dirs whose `.git` file
  // points into the fixture repo are removed, and the slug dir is dropped
  // only when left empty.
  function removeFixtureWorktreeDir(repo: string): void {
    const slugDir = join(homedir(), '.herdr', 'worktrees', basename(repo))
    if (!existsSync(slugDir)) return
    for (const entry of readdirSync(slugDir)) {
      const gitFile = join(slugDir, entry, '.git')
      if (!existsSync(gitFile)) continue
      const content = readFileSync(gitFile, 'utf8')
      if (content.includes(realpathSync(repo))) {
        rmSync(join(slugDir, entry), { recursive: true, force: true })
      }
    }
    try {
      rmdirSync(slugDir)
    } catch {}
  }

  function gitInitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wt-unit-'))
    gitExec(['init', '-q', dir])
    gitExec(['-C', dir, 'config', 'user.email', 'test@test'])
    gitExec(['-C', dir, 'config', 'user.name', 'test'])
    writeFileSync(join(dir, 'README.md'), 'x')
    gitExec(['-C', dir, 'add', '.'])
    gitExec(['-C', dir, 'commit', '-qm', 'init'])
    // AIDEV-NOTE: PMR-CM6D — the fixture commit must land in the temp repo,
    // never in an ambient repo reached by upward .git resolution.
    const toplevel = gitExec(['-C', dir, 'rev-parse', '--show-toplevel']).trim()
    assert.equal(realpathSync(toplevel), realpathSync(dir))
    return dir
  }

  it('slugifyWorktree lowercases, strips, and dashes', () => {
    assert.equal(
      slugifyWorktree('Fix PMR-11TD: Worktree Spawn!'),
      'fix-pmr-11td-worktree-spawn',
    )
    assert.equal(slugifyWorktree('  --weird__  name-- '), 'weird-name')
    assert.equal(slugifyWorktree('!!!'), '')
  })

  it('deriveWorktreeBranch is subagent/<slug>-<ts>-<id> and deterministic', () => {
    const now = new Date(Date.UTC(2026, 9, 15, 7, 14, 24))
    const branch = deriveWorktreeBranch('Echo Test', 'abc123', now)
    assert.equal(branch, 'subagent/echo-test-20261015-071424-abc123')
    assert.equal(deriveWorktreeBranch('Echo Test', 'abc123', now), branch)
    // childId disambiguates same-second same-name spawns
    assert.notEqual(deriveWorktreeBranch('Echo Test', 'def456', now), branch)
    // empty-slug fallback
    assert.ok(
      deriveWorktreeBranch('!!!', 'x1', now).startsWith('subagent/agent-'),
    )
    // long names are capped
    const long = deriveWorktreeBranch('a'.repeat(200), 'x1', now)
    assert.ok(long.length < 70, `branch too long: ${long.length}`)
  })

  it('worktreePathFor follows $HOME/.herdr/worktrees/<repo>/<branch-slug>', () => {
    const path = worktreePathFor('/repos/my-repo', 'subagent/echo-1-x')
    assert.equal(
      path,
      join(homedir(), '.herdr', 'worktrees', 'my-repo', 'subagent-echo-1-x'),
    )
  })

  it('findMainRepoRoot resolves the main checkout from repo and worktree', () => {
    const repo = gitInitRepo()
    try {
      assert.equal(findMainRepoRoot(repo), repo)
      const wt = join(repo, 'linked')
      gitExec(['-C', repo, 'worktree', 'add', '-q', '-b', 'linked', wt])
      assert.equal(findMainRepoRoot(wt), repo)
    } finally {
      gitExec(
        ['-C', repo, 'worktree', 'remove', '--force', join(repo, 'linked')],
        {
          stdio: 'ignore',
        },
      )
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('findMainRepoRoot fails closed outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-nogit-'))
    try {
      assert.throws(() => findMainRepoRoot(dir), WorktreeError)
      assert.throws(() => findMainRepoRoot(dir), /not a git repository/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // PMR-S6W3: git push hook env sets GIT_DIR etc.; repo resolution must
  // ignore them and rely on the explicit cwd only.
  it('findMainRepoRoot ignores GIT_DIR/GIT_WORK_TREE hook env (non-repo throws)', () => {
    const repo = gitInitRepo()
    const dir = mkdtempSync(join(tmpdir(), 'wt-nogit-'))
    const savedGitDir = process.env.GIT_DIR
    const savedGitWorkTree = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = join(repo, '.git')
    process.env.GIT_WORK_TREE = repo
    try {
      assert.throws(() => findMainRepoRoot(dir), WorktreeError)
      assert.throws(() => findMainRepoRoot(dir), /not a git repository/)
    } finally {
      restoreEnvVar('GIT_DIR', savedGitDir)
      restoreEnvVar('GIT_WORK_TREE', savedGitWorkTree)
      rmSync(repo, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('findMainRepoRoot still resolves the real repo under GIT_DIR hook env', () => {
    const repo = gitInitRepo()
    const savedGitDir = process.env.GIT_DIR
    const savedGitWorkTree = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = join(repo, '.git')
    process.env.GIT_WORK_TREE = repo
    try {
      assert.equal(findMainRepoRoot(repo), repo)
    } finally {
      restoreEnvVar('GIT_DIR', savedGitDir)
      restoreEnvVar('GIT_WORK_TREE', savedGitWorkTree)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('createSubagentWorktree creates worktree + branch off HEAD', () => {
    const repo = gitInitRepo()
    const branch = deriveWorktreeBranch(
      'unit echo',
      't1',
      new Date(Date.UTC(2026, 0, 1)),
    )
    let created: string | null = null
    try {
      const wt = createSubagentWorktree({ cwd: repo, branch })
      created = wt.path
      assert.equal(wt.branch, branch)
      assert.ok(existsSync(join(wt.path, 'README.md')))
      assert.ok(existsSync(join(wt.path, '.git')))
      const head = gitExec(['-C', wt.path, 'branch', '--show-current']).trim()
      assert.equal(head, branch)
      // base ref variant branches from that ref
      const wt2 = createSubagentWorktree({
        cwd: repo,
        branch: `${branch}-b`,
        base: 'HEAD',
      })
      assert.ok(existsSync(wt2.path))
      gitExec(['-C', repo, 'worktree', 'remove', '--force', wt2.path])
      gitExec(['-C', repo, 'branch', '-qD', `${branch}-b`])
    } finally {
      if (created) {
        gitExec(['-C', repo, 'worktree', 'remove', '--force', created], {
          stdio: 'ignore',
        })
        gitExec(['-C', repo, 'branch', '-qD', branch], {
          stdio: 'ignore',
        })
      }
      removeFixtureWorktreeDir(repo)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('createSubagentWorktree failure: clear WorktreeError, no partial state', () => {
    const repo = gitInitRepo()
    const branch = deriveWorktreeBranch(
      'bad base',
      't2',
      new Date(Date.UTC(2026, 0, 1)),
    )
    const path = worktreePathFor(repo, branch)
    try {
      assert.throws(
        () =>
          createSubagentWorktree({ cwd: repo, branch, base: 'no-such-ref' }),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeError)
          assert.match(err.message, /git worktree add failed/)
          assert.match(err.message, /no-such-ref/)
          return true
        },
      )
      // no worktree registered, no branch created
      assert.ok(!existsSync(path))
      const list = gitExec(['-C', repo, 'worktree', 'list', '--porcelain'])
      assert.ok(!list.includes(path))
      assert.throws(() =>
        gitExec(['-C', repo, 'rev-parse', '--verify', branch], {
          stdio: 'pipe',
        }),
      )
    } finally {
      removeFixtureWorktreeDir(repo)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  // AIDEV-NOTE: PMR-CM6D — proves the guarded cleanup leaves a foreign
  // same-slug worktree dir alone (a real repo with the same basename must
  // survive a test run).
  it('worktree cleanup spares foreign same-slug dir', () => {
    const repo = gitInitRepo()
    const foreignRepo = gitInitRepo()
    const slug = basename(repo)
    const slugDir = join(homedir(), '.herdr', 'worktrees', slug)
    const foreignDir = join(slugDir, 'foreign-wt')
    mkdirSync(foreignDir, { recursive: true })
    writeFileSync(
      join(foreignDir, '.git'),
      `gitdir: ${join(foreignRepo, '.git', 'worktrees', 'x')}\n`,
    )
    const branch = deriveWorktreeBranch(
      'spare foreign',
      't3',
      new Date(Date.UTC(2026, 0, 1)),
    )
    let created: string | null = null
    try {
      const wt = createSubagentWorktree({ cwd: repo, branch })
      created = wt.path
      assert.ok(existsSync(wt.path))
    } finally {
      if (created) {
        gitExec(['-C', repo, 'worktree', 'remove', '--force', created], {
          stdio: 'ignore',
        })
        gitExec(['-C', repo, 'branch', '-qD', branch], { stdio: 'ignore' })
      }
      removeFixtureWorktreeDir(repo)
      // foreign dir (owned by a different repo) must survive; slug dir stays
      assert.ok(existsSync(join(foreignDir, '.git')))
      rmSync(repo, { recursive: true, force: true })
      rmSync(foreignRepo, { recursive: true, force: true })
      rmSync(foreignDir, { recursive: true, force: true })
    }
  })
})

describe('assignments.ts durable branch-owned assignments (PMR-Z5KR)', () => {
  let root: string

  before(() => {
    root = join(mkTmpDir('assignments-'), 'pi-subagents')
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function draft(
    childId: string,
    overrides?: Partial<Parameters<typeof writeAssignment>[0]>,
  ) {
    return {
      childId,
      name: `agent-${childId}`,
      task: 'do the thing',
      sessionFile: `/tmp/${childId}.jsonl`,
      cwd: '/tmp',
      status: 'working' as const,
      claim: { pid: process.pid, id: 'parent-session-1' },
      ...overrides,
    }
  }

  it('writes a record atomically at the canonical path with timestamps', () => {
    const record = writeAssignment(draft('w-1'), root)
    const path = assignmentPath('w-1', root)
    assert.ok(existsSync(path))
    // no tmp sibling left behind
    assert.ok(!existsSync(`${path}.tmp`))
    assert.ok(record.createdAt)
    assert.equal(record.createdAt, record.updatedAt)

    const read = readAssignment('w-1', root)
    assert.deepEqual(read, record)
    assert.equal(read?.claim.pid, process.pid)
  })

  it('persists worktree + branch fields (PMR-11TD composition)', () => {
    writeAssignment(
      draft('w-2', { worktree: '/tmp/wt', branch: 'subagent/w-2' }),
      root,
    )
    const read = readAssignment('w-2', root)
    assert.equal(read?.worktree, '/tmp/wt')
    assert.equal(read?.branch, 'subagent/w-2')
  })

  it('updates status on transitions, bumping updatedAt and preserving fields', async () => {
    const before = writeAssignment(draft('u-1', { agent: 'worker' }), root)
    await new Promise((resolve) => setTimeout(resolve, 5))
    updateAssignmentStatus('u-1', 'blocked', root)
    const after = readAssignment('u-1', root)
    assert.equal(after?.status, 'blocked')
    assert.equal(after?.agent, 'worker')
    assert.equal(after?.createdAt, before.createdAt)
    assert.ok(after && after.updatedAt >= before.updatedAt)
  })

  it('update on a missing record is a no-op (fail closed, never resurrect)', () => {
    updateAssignmentStatus('gone', 'lost', root)
    assert.equal(readAssignment('gone', root), null)
  })

  it('removeAssignment deletes the record and tolerates repeats', () => {
    writeAssignment(draft('r-1'), root)
    removeAssignment('r-1', root)
    assert.equal(readAssignment('r-1', root), null)
    removeAssignment('r-1', root) // idempotent
  })

  it('listAssignments classifies owned (live claim pid) from files alone', () => {
    writeAssignment(draft('live-1'), root)
    const views = listAssignments(root)
    const view = views.find((v) => v.childId === 'live-1')
    assert.ok(view)
    assert.equal(view.state, 'owned')
    if (view.state === 'owned') {
      assert.equal(view.record.name, 'agent-live-1')
    }
  })

  it('hasLiveAssignmentForParent: true for a live claim pid with a working child', () => {
    const isolated = join(root, 'inflight-true')
    writeAssignment(draft('inflight-1'), isolated)
    assert.equal(hasLiveAssignmentForParent(process.pid, isolated), true)
  })

  it('hasLiveAssignmentForParent: false for another pid, dead pids, and lost children', () => {
    const isolated = join(root, 'inflight-false')
    writeAssignment(
      draft('other-1', { claim: { pid: 4194304, id: 'x' } }),
      isolated,
    )
    writeAssignment(draft('lost-1', { status: 'lost' }), isolated)
    assert.equal(hasLiveAssignmentForParent(process.pid, isolated), false)
    assert.equal(hasLiveAssignmentForParent(4194304, isolated), false)
  })

  it('listAssignments marks dead claim pids as orphaned with a resume hint', () => {
    // 4194304 is the default Linux pid_max — no live process can hold it.
    writeAssignment(draft('dead-1', { claim: { pid: 4194304, id: 'x' } }), root)
    const views = listAssignments(root)
    const view = views.find((v) => v.childId === 'dead-1')
    assert.ok(view)
    assert.equal(view.state, 'orphaned')
    if (view.state === 'orphaned') {
      assert.match(
        view.resumeHint ?? '',
        /subagent_resume\(\{ sessionPath: "\/tmp\/dead-1\.jsonl" \}\)/,
      )
    }
  })

  it('listAssignments fails closed to unknown on a malformed record (kept on disk)', () => {
    const path = assignmentPath('bad-1', root)
    writeFileSync(path, '{not json')
    const views = listAssignments(root)
    const view = views.find((v) => v.childId === 'bad-1')
    assert.ok(view)
    assert.equal(view.state, 'unknown')
    // fail closed = no destructive action — the record is still there
    assert.ok(existsSync(path))
  })

  it('findAssignmentByBranch: unique match returns the record', () => {
    const found = findAssignmentByBranch('subagent/w-2', root)
    assert.ok('record' in found)
    if ('record' in found) {
      assert.equal(found.record.childId, 'w-2')
    }
  })

  it('findAssignmentByBranch: missing branch is unknown, not invented', () => {
    const found = findAssignmentByBranch('no/such-branch', root)
    assert.ok('error' in found)
    if ('error' in found) {
      assert.match(found.error, /unknown/)
    }
  })

  it('findAssignmentByBranch: multiple matches are ambiguous (fail closed)', () => {
    writeAssignment(draft('amb-1', { branch: 'dup/branch' }), root)
    writeAssignment(draft('amb-2', { branch: 'dup/branch' }), root)
    const found = findAssignmentByBranch('dup/branch', root)
    assert.ok('error' in found)
    if ('error' in found) {
      assert.match(found.error, /[Aa]mbiguous/)
    }
  })
})

import {
  createSessionUsageTracker,
  formatUsageCompact,
  readSessionParentFile,
  readSessionUsage,
  rollupUsageByOwnership,
  summarizeEntriesUsage,
  type UsageOwnershipNode,
  type UsageSummary,
  updateSessionUsageTracker,
} from '../pi-extension/subagents/usage.ts'

function usageNode(
  childId: string,
  sessionFile: string,
  parentSessionFile: string | null,
  summary: UsageSummary | null,
): UsageOwnershipNode {
  return { childId, sessionFile, parentSessionFile, summary }
}

function summaryOf(input: number, output: number, cost: number): UsageSummary {
  return {
    totals: { input, output, cacheRead: 0, cacheWrite: 0, cost },
    sawUsage: true,
  }
}

describe('usage.ts (PMR-874G)', () => {
  let usageRoot: string

  before(() => {
    usageRoot = mkdtempSync(join(tmpdir(), 'usage-'))
  })
  after(() => {
    rmSync(usageRoot, { recursive: true, force: true })
  })

  const assistantEntry = (input: number, output: number, cost: number) => ({
    type: 'message',
    message: {
      role: 'assistant',
      content: [],
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  })

  describe('summarizeEntriesUsage', () => {
    it('sums assistant, toolResult, branch_summary and compaction usage', () => {
      const summary = summarizeEntriesUsage([
        { type: 'session', id: 's1' },
        assistantEntry(100, 50, 0.01),
        {
          type: 'message',
          message: {
            role: 'toolResult',
            usage: { input: 10, output: 5, cost: { total: 0.001 } },
          },
        },
        { type: 'message', message: { role: 'user', content: [] } },
        {
          type: 'branch_summary',
          usage: { input: 20, output: 10, cost: { total: 0.002 } },
        },
        {
          type: 'compaction',
          usage: { input: 30, output: 15, cost: { total: 0.003 } },
        },
        'garbage',
        null,
        { type: 'message' },
      ])
      assert.equal(summary.sawUsage, true)
      assert.equal(summary.totals.input, 160)
      assert.equal(summary.totals.output, 80)
      assert.ok(Math.abs(summary.totals.cost - 0.016) < 1e-9)
    })

    it('flags sawUsage=false when no entry carries usage (never a zero)', () => {
      const summary = summarizeEntriesUsage([
        { type: 'session', id: 's1' },
        { type: 'message', message: { role: 'user', content: [] } },
        { type: 'message', message: { role: 'assistant', content: [] } },
      ])
      assert.equal(summary.sawUsage, false)
      assert.equal(summary.totals.input, 0)
      assert.equal(summary.totals.cost, 0)
    })
  })

  describe('readSessionUsage', () => {
    it('reads usage from a session jsonl fixture', () => {
      const file = join(usageRoot, 'sess.jsonl')
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'session', id: 's1' }),
          JSON.stringify(assistantEntry(1000, 500, 0.05)),
          JSON.stringify(assistantEntry(2000, 1000, 0.1)),
        ].join('\n') + '\n',
      )
      const summary = readSessionUsage(file)
      assert.ok(summary)
      assert.equal(summary.sawUsage, true)
      assert.equal(summary.totals.input, 3000)
      assert.equal(summary.totals.output, 1500)
      assert.ok(Math.abs(summary.totals.cost - 0.15) < 1e-9)
    })

    it('returns null for an unreadable/missing file (coverage gap)', () => {
      assert.equal(readSessionUsage(join(usageRoot, 'nope.jsonl')), null)
    })
  })

  describe('updateSessionUsageTracker', () => {
    it('parses incrementally without double counting appended lines', () => {
      const file = join(usageRoot, 'incr.jsonl')
      writeFileSync(file, `${JSON.stringify(assistantEntry(100, 10, 0.01))}\n`)
      const tracker = createSessionUsageTracker()
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.totals.input, 100)

      appendFileSync(file, `${JSON.stringify(assistantEntry(200, 20, 0.02))}\n`)
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.totals.input, 300)
      assert.ok(Math.abs(tracker.summary.totals.cost - 0.03) < 1e-9)

      // no-op tick: same size, no reparse
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.totals.input, 300)
    })

    it('consumes only complete lines; a partial line waits for the next tick', () => {
      const file = join(usageRoot, 'partial.jsonl')
      const line = JSON.stringify(assistantEntry(50, 5, 0.005))
      writeFileSync(file, line) // no trailing newline — mid-write
      const tracker = createSessionUsageTracker()
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.sawUsage, false)

      appendFileSync(file, '\n')
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.sawUsage, true)
      assert.equal(tracker.summary.totals.input, 50)
    })

    it('resets when the file shrinks instead of double counting', () => {
      const file = join(usageRoot, 'shrink.jsonl')
      writeFileSync(file, `${JSON.stringify(assistantEntry(100, 10, 0.01))}\n`)
      const tracker = createSessionUsageTracker()
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.totals.input, 100)

      writeFileSync(file, `${JSON.stringify(assistantEntry(7, 1, 0.001))}\n`)
      updateSessionUsageTracker(tracker, file)
      assert.equal(tracker.summary.totals.input, 7)
    })
  })

  describe('readSessionParentFile', () => {
    it('reads parentSession from the session header', () => {
      const file = join(usageRoot, 'child.jsonl')
      writeFileSync(
        file,
        `${JSON.stringify({ type: 'session', id: 'c1', parentSession: '/tmp/parent.jsonl' })}\n${JSON.stringify(assistantEntry(1, 1, 0))}\n`,
      )
      assert.equal(readSessionParentFile(file), '/tmp/parent.jsonl')
    })

    it('returns null for roots, non-headers and missing files', () => {
      const root = join(usageRoot, 'root.jsonl')
      writeFileSync(root, `${JSON.stringify({ type: 'session', id: 'r1' })}\n`)
      assert.equal(readSessionParentFile(root), null)
      const bogus = join(usageRoot, 'bogus.jsonl')
      writeFileSync(bogus, 'not json\n')
      assert.equal(readSessionParentFile(bogus), null)
      assert.equal(readSessionParentFile(join(usageRoot, 'gone.jsonl')), null)
    })
  })

  describe('formatUsageCompact', () => {
    const totals = (tokens: number, cost: number) => ({
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
    })

    it('formats tokens with k/M suffixes and cost with precision', () => {
      assert.equal(formatUsageCompact(totals(420, 0)), '420 tok')
      assert.equal(
        formatUsageCompact(totals(12_300, 0.042)),
        '12.3k tok $0.0420',
      )
      assert.equal(
        formatUsageCompact(totals(1_500_000, 3.456)),
        '1.5M tok $3.46',
      )
    })

    it('omits cost when zero', () => {
      assert.equal(formatUsageCompact(totals(1000, 0)), '1.0k tok')
    })
  })

  describe('rollupUsageByOwnership', () => {
    it('sums self + transitive descendants per node', () => {
      const nodes = [
        usageNode('root', '/s/root.jsonl', null, summaryOf(100, 10, 0.01)),
        usageNode(
          'child',
          '/s/child.jsonl',
          '/s/root.jsonl',
          summaryOf(200, 20, 0.02),
        ),
        usageNode(
          'grand',
          '/s/grand.jsonl',
          '/s/child.jsonl',
          summaryOf(400, 40, 0.04),
        ),
      ]
      const rollups = rollupUsageByOwnership(nodes)
      const root = rollups.get('root')
      assert.ok(root)
      assert.equal(root.totals.input, 700)
      assert.equal(root.incomplete, false)
      assert.equal(rollups.get('child')?.totals.input, 600)
      assert.equal(rollups.get('grand')?.totals.input, 400)
    })

    it('flags coverage gaps and terminates on cycles', () => {
      const cyclic = rollupUsageByOwnership([
        usageNode('a', '/s/a.jsonl', '/s/b.jsonl', summaryOf(1, 1, 0)),
        usageNode('b', '/s/b.jsonl', '/s/a.jsonl', summaryOf(2, 2, 0)),
      ])
      assert.equal(cyclic.get('a')?.incomplete, true)
      assert.equal(cyclic.get('b')?.incomplete, true)

      const gapped = rollupUsageByOwnership([
        usageNode('root', '/s/root.jsonl', null, summaryOf(1, 1, 0)),
        usageNode('child', '/s/child.jsonl', '/s/root.jsonl', null),
      ])
      const root = gapped.get('root')
      assert.ok(root)
      assert.equal(root.incomplete, true)
      assert.equal(root.totals.input, 1)
      assert.equal(gapped.get('child')?.incomplete, true)
    })
  })

  describe('settle-time accounting', () => {
    it('recordAssignmentUsage persists totals onto the record; missing record is a no-op', () => {
      const root = join(mkTmpDir('usage-assign-'), 'pi-subagents')
      writeAssignment(
        {
          childId: 'u1',
          name: 'worker',
          task: 't',
          sessionFile: '/tmp/u1.jsonl',
          cwd: '/tmp',
          status: 'working',
          claim: { pid: process.pid, id: 'parent' },
        },
        root,
      )
      recordAssignmentUsage(
        'u1',
        { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: 0.5 },
        root,
      )
      const record = readAssignment('u1', root)
      assert.deepEqual(record?.usage, {
        input: 5,
        output: 6,
        cacheRead: 7,
        cacheWrite: 8,
        cost: 0.5,
      })
      recordAssignmentUsage(
        'gone',
        { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
        root,
      )
      assert.equal(readAssignment('gone', root), null)
      rmSync(root, { recursive: true, force: true })
    })

    it('writeResultRecord carries usage into the durable result record', () => {
      const root = join(mkTmpDir('usage-store-'), 'pi-subagents')
      const written = writeResultRecord(
        {
          childId: 'u2',
          name: 'worker',
          summary: 'done',
          sessionFile: '/tmp/u2.jsonl',
          usage: {
            input: 9,
            output: 9,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.09,
          },
        },
        root,
      )
      const record = readResultRecord(written.path)
      assert.deepEqual(record.usage, {
        input: 9,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.09,
      })
      rmSync(root, { recursive: true, force: true })
    })
  })

  describe('usageSuffixFor', () => {
    it('shows self totals, tree totals when descendants add more, coverage flags', () => {
      const nodes = [
        usageNode('root', '/s/root.jsonl', null, summaryOf(1000, 0, 0.01)),
        usageNode(
          'child',
          '/s/child.jsonl',
          '/s/root.jsonl',
          summaryOf(2000, 0, 0.02),
        ),
      ]
      const rollups = rollupUsageByOwnership(nodes)
      const rootSuffix = subagentsModule.usageSuffixFor(nodes[0], rollups)
      assert.match(rootSuffix, /· 1\.0k tok \$0\.0100/)
      assert.match(rootSuffix, /\(tree: 3\.0k tok \$0\.0300\)/)
      assert.ok(!rootSuffix.includes('coverage'))

      const leafSuffix = subagentsModule.usageSuffixFor(nodes[1], rollups)
      assert.match(leafSuffix, /· 2\.0k tok \$0\.0200/)
      assert.ok(!leafSuffix.includes('tree:'))
    })

    it('flags unavailable usage instead of inventing numbers', () => {
      const nodes = [usageNode('lone', '/s/lone.jsonl', null, null)]
      const rollups = rollupUsageByOwnership(nodes)
      const suffix = subagentsModule.usageSuffixFor(nodes[0], rollups)
      assert.match(suffix, /usage unavailable/)
    })

    it('flags incomplete coverage on a subtree gap', () => {
      const nodes = [
        usageNode('root', '/s/root.jsonl', null, summaryOf(100, 0, 0)),
        usageNode('child', '/s/child.jsonl', '/s/root.jsonl', null),
      ]
      const rollups = rollupUsageByOwnership(nodes)
      const suffix = subagentsModule.usageSuffixFor(nodes[0], rollups)
      assert.match(suffix, /coverage incomplete/)
    })
  })

  describe('widget usage display (PMR-874G)', () => {
    function usageAgent(id: string, name: string, tokens: number) {
      return {
        id,
        name,
        task: '',
        surface: `pane-${id}`,
        paneId: `w1:p${id}`,
        startTime: 900_000,
        sessionFile: `sess-${id}`,
        interactive: false,
        usage: {
          totals: {
            input: tokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.01,
          },
          sawUsage: true,
        },
        statusState: createStatusState({
          source: 'pi' as const,
          startTimeMs: 900_000,
        }),
      }
    }

    it('appends per-row usage and a header aggregate when available', () => {
      const { renderSupervisionRows } = subagentsModule
      const rendered = renderSupervisionRows(
        [usageAgent('a1', 'Worker', 1500), usageAgent('a2', 'Scout', 2500)],
        1_000_000,
      )
      assert.match(rendered.lines[0], /4\.0k tok \$0\.0200/)
      // PMR-X7BH (sanction E8NE9ZQ2EZTG0QRS): rows are SGR-styled now — strip
      // before matching so the regex keeps asserting per-row usage renders.
      assert.match(
        rendered.lines[1].replace(/\x1b\[[0-9;]*m/g, ''),
        /Worker · .* 1\.5k tok \$0\.0100/,
      )
      assert.match(
        rendered.lines[2].replace(/\x1b\[[0-9;]*m/g, ''),
        /Scout · .* 2\.5k tok \$0\.0100/,
      )
    })

    it('omits usage entirely when no child saw usage (no invented zeros)', () => {
      const { renderSupervisionRows } = subagentsModule
      const agent = usageAgent('a1', 'Worker', 0)
      agent.usage = { totals: agent.usage.totals, sawUsage: false }
      const rendered = renderSupervisionRows([agent], 1_000_000)
      assert.ok(!rendered.lines[0].includes('tok'))
      assert.ok(!rendered.lines[1].includes('tok'))
    })
  })
})

describe('retirement.ts (PMR-1EC3 context retirement)', () => {
  let retireRoot: string

  before(() => {
    retireRoot = join(mkTmpDir('retire-'), 'pi-subagents')
  })
  after(() => {
    rmSync(retireRoot, { recursive: true, force: true })
  })

  function customMsg(
    customType: string,
    content: unknown,
    details?: unknown,
  ): {
    role: string
    customType: string
    content: unknown
    details?: unknown
  } {
    const msg: {
      role: string
      customType: string
      content: unknown
      details?: unknown
    } = { role: 'custom', customType, content }
    if (details !== undefined) msg.details = details
    return msg
  }

  const big = 'x'.repeat(DEFAULT_RETIREMENT_MIN_BYTES + 1)

  describe('shouldArmRetirement', () => {
    it('arms on automatic pressure only when enabled', () => {
      assert.equal(shouldArmRetirement('threshold', true), true)
      assert.equal(shouldArmRetirement('overflow', true), true)
      assert.equal(shouldArmRetirement('manual', true), false)
      assert.equal(shouldArmRetirement('threshold', false), false)
      assert.equal(shouldArmRetirement('overflow', false), false)
      assert.equal(shouldArmRetirement('manual', false), false)
    })
  })

  describe('retireSettledSubagentPayloads', () => {
    it('returns the input untouched when nothing qualifies', () => {
      const messages = [
        customMsg('subagent_result', 'small'),
        customMsg('subagent_status', big),
        { role: 'user', content: big },
        customMsg('subagent_result', big), // single candidate <= keepRecent
      ]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
      })
      assert.equal(outcome.retired, 0)
      assert.equal(outcome.messages, messages)
      assert.equal(messages[3]?.content, big)
    })

    it('keeps the most recent keepRecent candidates inline', () => {
      const messages = [
        customMsg('subagent_result', `${big}-1`),
        customMsg('subagent_result', `${big}-2`),
        customMsg('subagent_result', `${big}-3`),
      ]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
      })
      assert.equal(outcome.retired, 2)
      const out = outcome.messages
      assert.ok(String(out[0]?.content).startsWith(RETIRED_STUB_PREFIX))
      assert.ok(String(out[1]?.content).startsWith(RETIRED_STUB_PREFIX))
      assert.equal(out[2]?.content, `${big}-3`)
      assert.equal(DEFAULT_RETIREMENT_KEEP_RECENT, 1)
    })

    it('honors an explicit keepRecent of 0', () => {
      const messages = [customMsg('subagent_ask', big)]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
        keepRecent: 0,
      })
      assert.equal(outcome.retired, 1)
      assert.ok(
        String(outcome.messages[0]?.content).startsWith(RETIRED_STUB_PREFIX),
      )
    })

    it('points subagent_result stubs at the existing result record', () => {
      // own root: the retired/ dir must not exist unless THIS test writes it
      const root = join(mkTmpDir('retire-ref-'), 'pi-subagents')
      const written = writeResultRecord(
        {
          childId: 'child-ret',
          name: 'scout',
          summary: 'big summary',
          sessionFile: null,
        },
        root,
      )
      const messages = [
        customMsg('subagent_result', `${big}-r1`, {
          name: 'scout',
          resultPath: written.path,
          resultRef: 'result:scout#1',
        }),
        customMsg('subagent_result', `${big}-r2`),
      ]
      const outcome = retireSettledSubagentPayloads(messages, {
        root,
      })
      assert.equal(outcome.retired, 1)
      const stub = String(outcome.messages[0]?.content)
      assert.ok(stub.includes(written.path))
      assert.ok(stub.includes('result:scout#1'))
      assert.ok(stub.includes('"scout"'))
      // no duplicate payload record written under retired/
      assert.ok(!existsSync(join(root, 'retired')))
      // details survive retirement (UI renderers read them)
      assert.deepEqual(outcome.messages[0]?.details, {
        name: 'scout',
        resultPath: written.path,
        resultRef: 'result:scout#1',
      })
    })

    it('writes a durable hash-named record when no resultPath exists', () => {
      // own root: idempotence assertion counts files under retired/
      const root = join(mkTmpDir('retire-hash-'), 'pi-subagents')
      const messages = [
        customMsg('subagent_ask', `${big}-q`, { name: 'worker' }),
        customMsg('subagent_result', `${big}-keep`),
      ]
      const first = retireSettledSubagentPayloads(messages, {
        root,
      })
      assert.equal(first.retired, 1)
      const stub = String(first.messages[0]?.content)
      assert.ok(stub.includes('subagent_ask "worker"'))
      const match = /retired to (\S+\.json)/.exec(stub)
      assert.ok(match, `stub names a record path: ${stub}`)
      const recordPath = match?.[1] ?? ''
      assert.ok(recordPath.startsWith(join(root, 'retired', '')))
      const record = JSON.parse(readFileSync(recordPath, 'utf8'))
      assert.equal(record.customType, 'subagent_ask')
      assert.equal(record.content, `${big}-q`)
      assert.equal(record.details.name, 'worker')
      assert.ok(record.retiredAt)

      // Idempotent: same payload retires to the same path, no second write.
      const second = retireSettledSubagentPayloads(messages, {
        root,
      })
      assert.equal(second.retired, 1)
      assert.equal(String(second.messages[0]?.content), stub)
      assert.equal(readdirSync(join(root, 'retired')).length, 1)
    })

    it('skips small, already-retired, and non-string payloads', () => {
      const messages = [
        customMsg('subagent_result', 'small'),
        customMsg('subagent_result', `${RETIRED_STUB_PREFIX} earlier`),
        customMsg('subagent_message', [{ type: 'text', text: big }]),
        customMsg('subagent_result', `${big}-a`),
        customMsg('subagent_result', `${big}-b`),
      ]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
      })
      assert.equal(outcome.retired, 1)
      assert.ok(
        String(outcome.messages[3]?.content).startsWith(RETIRED_STUB_PREFIX),
      )
      assert.equal(outcome.messages[4]?.content, `${big}-b`)
    })

    it('does not mutate the input array or message objects', () => {
      const original = customMsg('subagent_result', `${big}-m`)
      const messages = [original, customMsg('subagent_result', `${big}-k`)]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
      })
      assert.equal(outcome.retired, 1)
      assert.equal(original.content, `${big}-m`)
      assert.notEqual(outcome.messages, messages)
      assert.notEqual(outcome.messages[0], original)
    })

    it('retires below an explicit minBytes threshold', () => {
      const messages = [
        customMsg('subagent_message', 'moderately sized message payload'),
        customMsg('subagent_result', `${big}-keep`),
      ]
      const outcome = retireSettledSubagentPayloads(messages, {
        root: retireRoot,
        minBytes: 10,
      })
      assert.equal(outcome.retired, 1)
      assert.ok(
        String(outcome.messages[0]?.content).startsWith(RETIRED_STUB_PREFIX),
      )
    })
  })

  describe('buildRetirementStub', () => {
    it('includes the ref path and optional name/ref', () => {
      const stub = buildRetirementStub(
        'subagent_result',
        'scout',
        '/tmp/r.json',
        'result:scout#2',
      )
      assert.ok(stub.startsWith(RETIRED_STUB_PREFIX))
      assert.ok(stub.includes('"scout"'))
      assert.ok(stub.includes('/tmp/r.json (result:scout#2)'))
      const bare = buildRetirementStub(
        'subagent_ask',
        undefined,
        '/tmp/a.json',
        undefined,
      )
      assert.ok(bare.includes('subagent_ask —'))
      assert.ok(!bare.includes('('))
    })
  })
})

describe('config.ts contextRetirement (PMR-1EC3)', () => {
  it('defaults to disabled and round-trips an explicit setting', () => {
    assert.deepEqual(DEFAULT_SUBAGENTS_CONFIG.contextRetirement, {
      enabled: false,
    })
    assert.deepEqual(
      validateSubagentsConfig(
        {
          status: { enabled: true },
          contextRetirement: { enabled: true },
        },
        't',
      ),
      { status: { enabled: true }, contextRetirement: { enabled: true } },
    )
    // absent key stays absent (no invented state)
    assert.deepEqual(
      validateSubagentsConfig({ status: { enabled: true } }, 't'),
      { status: { enabled: true } },
    )
  })

  it('rejects malformed contextRetirement shapes', () => {
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true }, contextRetirement: { enabled: 'y' } },
          't',
        ),
      /Invalid subagents config in t/,
    )
    assert.throws(
      () =>
        validateSubagentsConfig(
          { status: { enabled: true }, contextRetirement: {} },
          't',
        ),
      /Invalid subagents config in t/,
    )
  })

  it('accepts reserved pi-durable compaction knob names (PMR-Y4PV)', () => {
    // Forward-compat only: reserveTokens / keepRecentTokens /
    // backgroundTokens are reserved (unimplemented) but validate, so tuning
    // configs written against pi-durable's vocabulary stay loadable.
    assert.deepEqual(
      validateSubagentsConfig(
        {
          status: { enabled: true },
          contextRetirement: { enabled: true, reserveTokens: 4096 },
        },
        't',
      ),
      {
        status: { enabled: true },
        contextRetirement: { enabled: true, reserveTokens: 4096 },
      },
    )
    // unknown knob names still rejected
    assert.throws(
      () =>
        validateSubagentsConfig(
          {
            status: { enabled: true },
            contextRetirement: { enabled: true, maxTokens: 1 },
          },
          't',
        ),
      /Invalid subagents config in t/,
    )
  })

  it('scaffolded global config carries the disabled default', () => {
    const agentDir = mkTmpDir('subagents-agentdir-')
    const path = scaffoldGlobalSubagentsConfig(agentDir)
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(onDisk.contextRetirement, { enabled: false })
  })
})

describe('subagent_resume reattach decision (PMR-N53A)', () => {
  function makeRecord(overrides: Record<string, unknown> = {}) {
    return {
      childId: 'child-1',
      name: 'Worker',
      task: 'do things',
      sessionFile: '/tmp/child-1.jsonl',
      paneId: 'pane-1',
      tabId: 'tab-1',
      workspaceId: 'ws-1',
      cwd: '/tmp',
      status: 'working' as const,
      claim: { pid: 4242, id: 'parent-session' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  const deadProbe = { pidAlive: false, agentAlive: false, steerCapable: true }

  it('spawns when no assignment record matches the session', () => {
    const decision = subagentsModule.decideResumeReattach({
      record: null,
      ...deadProbe,
    })
    assert.equal(decision.action, 'spawn')
  })

  it('spawns when the record predates pane tracking (no paneId)', () => {
    const decision = subagentsModule.decideResumeReattach({
      record: makeRecord({ paneId: undefined }),
      ...deadProbe,
    })
    assert.equal(decision.action, 'spawn')
  })

  it('spawns for claude-kind children (no inbox pump to steer)', () => {
    const decision = subagentsModule.decideResumeReattach({
      record: makeRecord(),
      pidAlive: true,
      agentAlive: true,
      steerCapable: false,
    })
    assert.equal(decision.action, 'spawn')
  })

  it('reattaches a live owned child', () => {
    const decision = subagentsModule.decideResumeReattach({
      record: makeRecord(),
      pidAlive: true,
      agentAlive: true,
      steerCapable: true,
    })
    assert.equal(decision.action, 'reattach')
    if (decision.action === 'reattach') {
      assert.equal(decision.record.childId, 'child-1')
      assert.ok(decision.why.includes('owned'))
    }
  })

  it('reattaches the ORPHANED child when its pane is still alive (core PMR-N53A case)', () => {
    const decision = subagentsModule.decideResumeReattach({
      record: makeRecord(),
      pidAlive: false,
      agentAlive: true,
      steerCapable: true,
    })
    assert.equal(decision.action, 'reattach')
    if (decision.action === 'reattach') {
      assert.ok(decision.why.includes('orphaned'))
    }
  })

  it('spawns when herdr reports no agent on the recorded pane (child gone)', () => {
    const ownedGone = subagentsModule.decideResumeReattach({
      record: makeRecord(),
      pidAlive: true,
      agentAlive: false,
      steerCapable: true,
    })
    assert.equal(ownedGone.action, 'spawn')

    const orphanGone = subagentsModule.decideResumeReattach({
      record: makeRecord(),
      pidAlive: false,
      agentAlive: false,
      steerCapable: true,
    })
    assert.equal(orphanGone.action, 'spawn')
  })

  it('picks the latest record for a session and ignores other sessions', () => {
    const records = [
      makeRecord({ childId: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeRecord({
        childId: 'other-session',
        sessionFile: '/tmp/other.jsonl',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
      makeRecord({
        childId: 'new',
        updatedAt: '2026-01-03T00:00:00.000Z',
      }),
    ]
    const latest = subagentsModule.latestAssignmentForSession(
      records,
      '/tmp/child-1.jsonl',
    )
    assert.equal(latest?.childId, 'new')
    assert.equal(
      subagentsModule.latestAssignmentForSession(records, '/tmp/none.jsonl'),
      null,
    )
    assert.equal(
      subagentsModule.latestAssignmentForSession([], '/tmp/child-1.jsonl'),
      null,
    )
  })

  it('round-trips activityFile on the record so reattach can observe activity', () => {
    withTempDir((dir) => {
      writeAssignment(
        {
          ...makeRecord({ activityFile: '/tmp/art/activity-child-1.json' }),
        },
        dir,
      )
      const record = readAssignment('child-1', dir)
      assert.equal(record?.activityFile, '/tmp/art/activity-child-1.json')
    })
  })
})

describe('rolePrefixWithoutAgent guardrail (PMR-J2V5)', () => {
  const rolePrefixWithoutAgent = subagentsModule.__test__.rolePrefixWithoutAgent

  it('matches a role prefix with colon separator', () => {
    assert.equal(
      rolePrefixWithoutAgent('worker: implement thing', undefined),
      'worker',
    )
  })

  it('matches a role prefix with em-dash separator', () => {
    assert.equal(rolePrefixWithoutAgent('scout — map repo', undefined), 'scout')
  })

  it('matches hyphen and colon-only separators', () => {
    assert.equal(rolePrefixWithoutAgent('planner: plan', undefined), 'planner')
    assert.equal(
      rolePrefixWithoutAgent('reviewer - review', undefined),
      'reviewer',
    )
  })

  it('returns null without a known separator', () => {
    assert.equal(
      rolePrefixWithoutAgent('worker implement thing', undefined),
      null,
    )
  })

  it('returns null when agent is set', () => {
    assert.equal(rolePrefixWithoutAgent('worker: X', 'worker'), null)
  })

  it('returns null for unknown role prefixes', () => {
    assert.equal(rolePrefixWithoutAgent('peon: dig', undefined), null)
  })

  it('returns null for undefined name', () => {
    assert.equal(rolePrefixWithoutAgent(undefined, undefined), null)
  })
})

describe('delivered.ts exactly-once dedup (PMR-KY0E)', () => {
  let root: string

  before(() => {
    root = join(mkTmpDir('delivered-'), 'pi-subagents')
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('delivers a duplicate requestId once, different requestIds both', () => {
    assert.equal(markDelivered('child-a', 'req-1', root), true)
    assert.equal(hasDelivered('child-a', 'req-1', root), true)
    // crash-and-redelivery of the same record: suppressed
    assert.equal(markDelivered('child-a', 'req-1', root), false)
    // a different requestId still delivers
    assert.equal(markDelivered('child-a', 'req-2', root), true)
  })

  it('scopes are isolated per child', () => {
    assert.equal(hasDelivered('child-b', 'req-1', root), false)
    assert.equal(markDelivered('child-b', 'req-1', root), true)
  })

  it('sanitizes hostile scope/requestId path components', () => {
    const marker = deliveredMarkerPath('../../etc', 'x/y', root)
    const rel = relative(join(root, 'delivered'), marker)
    assert.ok(!rel.split(sep).includes('..'))
    assert.equal(markDelivered('../../etc', 'x/y', root), true)
  })

  it('suppresses a redelivered owner-inbox record (drain pattern)', () => {
    const dir = ownerInboxDir('parent-s', root)
    const record = JSON.stringify({
      version: 1,
      messageId: 'dup-1',
      childId: 'child-a',
      message: 'hello',
      sentAt: new Date().toISOString(),
    })
    writeFileSync(join(dir, 'child-a-000001.json'), record)
    writeFileSync(join(dir, 'child-a-000002.json'), record) // same requestId
    const entries = readOwnerInbox('parent-s', root)
    const fresh: string[] = []
    for (const entry of entries) {
      if (!hasDelivered('parent-s', entry.message.messageId, root)) {
        fresh.push(entry.message.messageId)
        markDelivered('parent-s', entry.message.messageId, root)
      }
    }
    assert.equal(fresh.length, 1) // duplicate delivered once
    for (const entry of entries) removeOwnerMessage(entry.path)
    assert.equal(readOwnerInbox('parent-s', root).length, 0)
  })
})

describe('child tool-effect replay memo (PMR-ZJCP)', () => {
  let root: string

  before(() => {
    root = join(mkTmpDir('effectmemo-'), 'pi-subagents')
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function memo(overrides?: Partial<ChildToolEffectMemo>): ChildToolEffectMemo {
    return {
      version: 1,
      childId: 'child-a',
      tool: 'message_peer',
      fingerprint: effectFingerprint('message_peer', 'child-a', { to: 'b' }),
      createdAt: new Date().toISOString(),
      result: { ok: true, deliveredTo: 'b' },
      ...overrides,
    }
  }

  it('round-trips a write through readEffectMemo', () => {
    const written = memo()
    assert.equal(writeEffectMemo(written, root), true)
    const read = readEffectMemo(
      written.childId,
      written.tool,
      written.fingerprint,
      root,
    )
    assert.ok(read)
    assert.deepEqual(read, written)
  })

  it('writeEffectMemo is exclusive-create: second write returns false, file unchanged', () => {
    const first = memo({ childId: 'child-dup' })
    assert.equal(writeEffectMemo(first, root), true)
    const path = effectMemoPath(
      first.childId,
      first.tool,
      first.fingerprint,
      root,
    )
    const before = readFileSync(path, 'utf8')
    const second = memo({
      childId: 'child-dup',
      result: { ok: false, tampered: true },
    })
    assert.equal(writeEffectMemo(second, root), false)
    assert.equal(readFileSync(path, 'utf8'), before)
    const read = readEffectMemo(
      first.childId,
      first.tool,
      first.fingerprint,
      root,
    )
    assert.deepEqual(read?.result, { ok: true, deliveredTo: 'b' })
  })

  it('fails closed (null, no throw) on malformed JSON and missing/mistyped fields', () => {
    const fp = effectFingerprint('caller_ping', 'child-bad', {})
    const dir = effectMemoPath('child-bad', 'caller_ping', fp, root)
    const parent = dirname(dir)
    const cases: Record<string, unknown>[] = [
      {},
      { version: 2 },
      { version: 1 },
      { version: 1, childId: 7 },
      { version: 1, childId: 'c', tool: 'ask_owner' },
      {
        version: 1,
        childId: 'c',
        tool: 'not_a_tool',
        fingerprint: fp,
        createdAt: 'now',
        result: {},
      },
      {
        version: 1,
        childId: 'c',
        tool: 'ask_owner',
        fingerprint: 42,
        createdAt: 'now',
        result: {},
      },
      {
        version: 1,
        childId: 'c',
        tool: 'ask_owner',
        fingerprint: fp,
        createdAt: 1,
        result: {},
      },
      {
        version: 1,
        childId: 'c',
        tool: 'ask_owner',
        fingerprint: fp,
        createdAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        tool: 'ask_owner',
        fingerprint: fp,
        createdAt: 'now',
        result: [],
      },
      {
        version: 1,
        childId: 'c',
        tool: 'ask_owner',
        fingerprint: fp,
        createdAt: 'now',
        result: 'nope',
      },
    ]
    mkdirSync(parent, { recursive: true })
    writeFileSync(dir, '{nope', 'utf8')
    assert.equal(readEffectMemo('child-bad', 'caller_ping', fp, root), null)
    for (const [index, value] of cases.entries()) {
      writeFileSync(dir, JSON.stringify(value), 'utf8')
      assert.equal(
        readEffectMemo('child-bad', 'caller_ping', fp, root),
        null,
        `case ${index} should fail closed`,
      )
    }
  })

  it('fingerprints are stable across key order and undefined, and distinct for [] vs absent', () => {
    const a = effectFingerprint('ask_owner', 'c', { x: 1, y: 2 })
    const reordered = effectFingerprint('ask_owner', 'c', { y: 2, x: 1 })
    assert.equal(a, reordered)

    const withUndefined = effectFingerprint('ask_owner', 'c', {
      x: 1,
      extra: undefined,
    })
    assert.equal(withUndefined, effectFingerprint('ask_owner', 'c', { x: 1 }))

    const emptyArray = effectFingerprint('ask_owner', 'c', { list: [] })
    const absent = effectFingerprint('ask_owner', 'c', {})
    assert.notEqual(emptyArray, absent)
  })

  it('fingerprints differ across tool, childId, and params', () => {
    const base = effectFingerprint('ask_owner', 'child-1', { q: 'go?' })
    assert.notEqual(
      base,
      effectFingerprint('caller_ping', 'child-1', { q: 'go?' }),
    )
    assert.notEqual(
      base,
      effectFingerprint('ask_owner', 'child-2', { q: 'go?' }),
    )
    assert.notEqual(
      base,
      effectFingerprint('ask_owner', 'child-1', { q: 'stop?' }),
    )
  })

  it('sanitizes hostile childIds out of memo paths', () => {
    const hostile = '../../etc/passwd'
    const written = memo({ childId: hostile })
    assert.equal(writeEffectMemo(written, root), true)
    const path = effectMemoPath(
      written.childId,
      written.tool,
      written.fingerprint,
      root,
    )
    const rel = relative(join(root, 'tool-effects'), path)
    assert.ok(!rel.split(sep).includes('..'))
    assert.ok(
      readEffectMemo(written.childId, written.tool, written.fingerprint, root),
    )
  })

  it('rewriteEffectMemo replaces content atomically with no tmp residue', () => {
    const original = memo({ childId: 'child-rewrite' })
    writeEffectMemo(original, root)
    const replaced = memo({
      childId: 'child-rewrite',
      result: { ok: true, replaced: true },
    })
    rewriteEffectMemo(replaced, root)
    const path = effectMemoPath(
      replaced.childId,
      replaced.tool,
      replaced.fingerprint,
      root,
    )
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(replaced))
    const read = readEffectMemo(
      replaced.childId,
      replaced.tool,
      replaced.fingerprint,
      root,
    )
    assert.deepEqual(read?.result, { ok: true, replaced: true })
    const childDir = join(root, 'tool-effects', 'child-rewrite')
    const residue = readdirSync(childDir).filter((name) =>
      name.endsWith('.tmp'),
    )
    assert.deepEqual(residue, [])
  })
})

describe('peer-bindings.ts (PMR-77KT)', () => {
  let root: string

  before(() => {
    root = join(mkTmpDir('peerbindings-'), 'pi-subagents')
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function binding(
    overrides?: Partial<PeerRecipientBinding>,
  ): PeerRecipientBinding {
    return {
      version: 1,
      childId: 'child-a',
      fingerprint: 'fp-a',
      toChildId: 'child-b',
      toSessionFile: '/tmp/peer-b.session.json',
      toName: 'Peer B',
      request: { peer: 'Peer B', message: 'hello' },
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('round-trips a write through readPeerBinding', () => {
    const written = binding({ childId: 'child-round', fingerprint: 'fp-round' })
    assert.equal(writePeerBinding(written, root), true)
    const read = readPeerBinding(written.childId, written.fingerprint, root)
    assert.ok(read)
    assert.deepEqual(read, written)
  })

  it('writePeerBinding is exclusive-create: second write returns false, file unchanged', () => {
    const first = binding({ childId: 'child-dup', fingerprint: 'fp-dup' })
    assert.equal(writePeerBinding(first, root), true)
    const path = peerBindingPath(first.childId, first.fingerprint, root)
    const before = readFileSync(path, 'utf8')
    const second = binding({
      childId: 'child-dup',
      fingerprint: 'fp-dup',
      toChildId: 'child-hijack',
    })
    assert.equal(writePeerBinding(second, root), false)
    assert.equal(readFileSync(path, 'utf8'), before)
    const read = readPeerBinding(first.childId, first.fingerprint, root)
    assert.equal(read?.toChildId, 'child-b')
  })

  it('fails closed (null, no throw) on malformed JSON and missing/mistyped fields', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { version: 2 },
      { version: 1 },
      { version: 1, childId: 7 },
      { version: 1, childId: 'c', fingerprint: 'fp' },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 42,
        request: { peer: 'p', message: 'm' },
        createdAt: 'now',
        lastActivityAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: { peer: 'p' },
        createdAt: 'now',
        lastActivityAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: { peer: 'p', message: 'm', resultRef: 3 },
        createdAt: 'now',
        lastActivityAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: 'nope',
        createdAt: 'now',
        lastActivityAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: { peer: 'p', message: 'm' },
        lastActivityAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: { peer: 'p', message: 'm' },
        createdAt: 'now',
      },
      {
        version: 1,
        childId: 'c',
        fingerprint: 'fp',
        toChildId: 'b',
        toSessionFile: 's',
        toName: 'n',
        request: { peer: 'p', message: 'm' },
        createdAt: 1,
        lastActivityAt: 'now',
      },
    ]
    for (const [index, value] of cases.entries()) {
      assert.equal(
        isPeerRecipientBinding(value),
        false,
        `case ${index} should fail closed`,
      )
    }
    const dir = dirname(peerBindingPath('child-bad', 'fp-bad', root))
    mkdirSync(dir, { recursive: true })
    const path = peerBindingPath('child-bad', 'fp-bad', root)
    writeFileSync(path, '{nope', 'utf8')
    assert.equal(readPeerBinding('child-bad', 'fp-bad', root), null)
  })

  it('touchPeerBinding advances lastActivityAt atomically with no tmp residue', () => {
    const original = binding({
      childId: 'child-touch',
      fingerprint: 'fp-touch',
    })
    writePeerBinding(original, root)
    touchPeerBinding(original, root)
    const path = peerBindingPath(original.childId, original.fingerprint, root)
    const read = readPeerBinding(original.childId, original.fingerprint, root)
    assert.ok(read)
    assert.notEqual(read.lastActivityAt, original.lastActivityAt)
    assert.equal(read.createdAt, original.createdAt)
    assert.deepEqual(read.request, original.request)
    assert.equal(read.toChildId, original.toChildId)
    for (const entry of readdirSync(dirname(path))) {
      assert.ok(!entry.endsWith('.tmp'), `tmp residue: ${entry}`)
    }
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1)
  })

  it('touchPeerBinding is best-effort: an unwritable binding file does not throw', (t) => {
    if (skipIfRoot(t)) return
    // AIDEV-NOTE (PMR-77KT): touch runs AFTER writeEffectMemo in the handler,
    // so a throwing touch would fail an already-completed send. Lock the
    // best-effort contract: EACCES on the record must be swallowed and the
    // record left byte-identical.
    const original = binding({
      childId: 'child-touch-eacces',
      fingerprint: 'fp-touch-eacces',
    })
    writePeerBinding(original, root)
    const path = peerBindingPath(original.childId, original.fingerprint, root)
    const before = readFileSync(path, 'utf8')
    const dir = dirname(path)
    chmodSync(dir, 0o500)
    try {
      touchPeerBinding(original, root)
      assert.equal(readFileSync(path, 'utf8'), before)
      for (const entry of readdirSync(dir)) {
        assert.ok(!entry.endsWith('.tmp'), `tmp residue: ${entry}`)
      }
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('sanitizes hostile childIds out of binding paths', () => {
    const hostile = '../../etc/passwd'
    const written = binding({ childId: hostile, fingerprint: 'fp-hostile' })
    assert.equal(writePeerBinding(written, root), true)
    const path = peerBindingPath(written.childId, written.fingerprint, root)
    const rel = relative(join(root, 'peer-bindings'), path)
    assert.ok(!rel.split(sep).includes('..'))
    assert.ok(readPeerBinding(written.childId, written.fingerprint, root))
  })
})

describe('replay-safe spawn identity (PMR-YKAC)', () => {
  let root: string

  before(() => {
    root = join(mkTmpDir('spawnseq-'), 'pi-subagents')
  })
  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('allocates durable, strictly increasing seqs per parent', () => {
    assert.equal(nextSpawnSeq('parent-a', root), 1)
    assert.equal(nextSpawnSeq('parent-a', root), 2)
    assert.equal(nextSpawnSeq('parent-a', root), 3)
  })

  it('isolates seqs per parent session (no cross-parent collision)', () => {
    assert.equal(nextSpawnSeq('parent-b', root), 1)
    const a = deriveChildId('parent-a', 1)
    const b = deriveChildId('parent-b', 1)
    assert.notEqual(a, b)
  })

  it('derives deterministic 8-hex childIds from (parent, seq)', () => {
    const id = deriveChildId('parent-a', 2)
    assert.match(id, /^[0-9a-f]{8}$/)
    assert.equal(id, deriveChildId('parent-a', 2))
    assert.notEqual(id, deriveChildId('parent-a', 3))
  })

  function startingDraft(
    childId: string,
    overrides?: Partial<Parameters<typeof writeAssignment>[0]>,
  ) {
    return {
      childId,
      name: 'worker: x',
      task: 'do the thing',
      sessionFile: `/tmp/${childId}.jsonl`,
      cwd: '/tmp',
      status: 'starting' as const,
      claim: { pid: 4194304, id: 'parent-a' }, // dead pid: a crashed parent
      ...overrides,
    }
  }

  it('findStartingAssignment matches only same parent + name + task + starting', () => {
    writeAssignment(startingDraft('st-1'), root)
    const hit = findStartingAssignment(
      { parentSessionId: 'parent-a', name: 'worker: x', task: 'do the thing' },
      root,
    )
    assert.equal(hit?.childId, 'st-1')
    // different task: no match
    assert.equal(
      findStartingAssignment(
        { parentSessionId: 'parent-a', name: 'worker: x', task: 'other' },
        root,
      ),
      null,
    )
    // different parent: no match
    assert.equal(
      findStartingAssignment(
        {
          parentSessionId: 'parent-b',
          name: 'worker: x',
          task: 'do the thing',
        },
        root,
      ),
      null,
    )
    // already-spawned (working) record: no match
    writeAssignment(startingDraft('st-2', { status: 'working' }), root)
    assert.equal(
      findStartingAssignment(
        {
          parentSessionId: 'parent-a',
          name: 'worker: x',
          task: 'do the thing',
        },
        root,
      )?.childId,
      'st-1',
    )
  })

  it('allocateSpawnIdentity replays a crashed spawn instead of duplicating', () => {
    // crash AFTER the 'starting' record write, BEFORE tab create: st-1 above
    const first = allocateSpawnIdentity(
      { parentSessionId: 'parent-a', name: 'worker: x', task: 'do the thing' },
      root,
    )
    assert.equal(first.replay?.childId, 'st-1')
    assert.equal(first.childId, 'st-1') // same child reused, no new seq burned
    assert.equal(nextSpawnSeq('parent-c', root), 1) // untouched parent unaffected
  })

  it('allocateSpawnIdentity allocates deterministically when no replay exists', () => {
    const fresh = allocateSpawnIdentity(
      { parentSessionId: 'parent-d', name: 'worker: y', task: 't' },
      root,
    )
    assert.equal(fresh.replay, null)
    assert.equal(fresh.childId, deriveChildId('parent-d', 1))
    const second = allocateSpawnIdentity(
      { parentSessionId: 'parent-d', name: 'worker: z', task: 't2' },
      root,
    )
    assert.equal(second.childId, deriveChildId('parent-d', 2))
  })

  it('falls back to a random id without a parent session id', () => {
    const anon = allocateSpawnIdentity(
      { parentSessionId: null, name: 'n', task: 't' },
      root,
    )
    assert.equal(anon.replay, null)
    assert.match(anon.childId, /^[0-9a-f]{8}$/)
  })
})

describe('snapshot.ts (PMR-YJC5 aggregate snapshot)', () => {
  const root = mkTmpDir('subagents-snapshot-')
  const owner = 'parent-snap-1'
  const childA = deriveChildId(owner, 1)
  const childB = deriveChildId(owner, 2)
  const childC = deriveChildId(owner, 3)

  // Counting reader — injectable SnapshotReadIo proves per-tick read counts.
  const countingIo = () => {
    let reads = 0
    const count = <T>(fn: () => T): T => {
      reads += 1
      return fn()
    }
    return {
      io: {
        readdir: (path: string) => count(() => readdirSync(path)),
        readFile: (path: string) => count(() => readFileSync(path, 'utf8')),
      },
      get reads() {
        return reads
      },
    }
  }

  it('folds asks + owner inbox into one childId-keyed snapshot in a single pass', () => {
    const ask: AskRecord = {
      askId: 'ask-1',
      childId: childA,
      question: 'proceed?',
      sessionFile: '/tmp/a.jsonl',
      createdAt: new Date().toISOString(),
    }
    writeAskRecord(ask, root)
    sendOwnerMessage({
      parentSessionId: owner,
      childId: childA,
      message: 'from A',
      root,
    })
    sendOwnerMessage({
      parentSessionId: owner,
      childId: childB,
      message: 'from B',
      root,
    })

    const counter = countingIo()
    const snap = buildAggregateSnapshot({
      ownerSessionId: owner,
      childIds: [childA, childB, childC],
      root,
      io: counter.io,
      includeAsks: true,
    })

    const a = snap.children.get(childA)
    const b = snap.children.get(childB)
    const c = snap.children.get(childC)
    assert.ok(a && b && c)
    assert.equal(a.owner, owner)
    assert.equal(a.askPending?.askId, 'ask-1')
    assert.equal(a.inboxPending, 1)
    assert.equal(b.askPending, null)
    assert.equal(b.inboxPending, 1)
    assert.equal(c.askPending, null)
    assert.equal(c.inboxPending, 0)

    // Drain input: both entries (readOwnerInbox parity — filename order).
    assert.deepEqual(
      snap.inboxEntries.map((entry) => entry.message.message).sort(),
      ['from A', 'from B'],
    )

    // 3-child fan-out read count: 1 asks readdir + 1 ask read + 1 inbox
    // readdir + 2 inbox reads = 5. Scattered per-child reads would be
    // 3 readAskRecord + readOwnerInbox(1 + 2) = 6 — and scale worse: each
    // new record type plugs in as one fold step, not a per-child read loop.
    assert.equal(snap.reads, 5)
    assert.equal(counter.reads, 5)
  })

  it('fails closed on malformed records and missing dirs', () => {
    removeAskRecord(childA, root) // first test's ask record shares the root
    writeFileSync(join(asksDir(root), 'bogus.json'), '{nope', 'utf8')
    sendOwnerMessage({
      parentSessionId: 'parent-snap-2',
      childId: childA,
      message: 'ok',
      root,
    })
    writeFileSync(
      join(ownerInboxDir('parent-snap-2', root), 'x-childA-999999.json'),
      '{broken',
      'utf8',
    )

    const snap = buildAggregateSnapshot({
      ownerSessionId: 'parent-snap-2',
      childIds: [childA],
      root,
      io: defaultSnapshotReadIo,
      includeAsks: true,
    })
    assert.equal(snap.children.get(childA)?.askPending, null)
    assert.equal(snap.children.get(childA)?.inboxPending, 1)
    assert.equal(snap.inboxEntries.length, 1)

    // Unknown owner: empty snapshot, no throw.
    const empty = buildAggregateSnapshot({
      ownerSessionId: 'parent-never-existed',
      childIds: [childA],
      root,
      io: defaultSnapshotReadIo,
    })
    assert.equal(empty.inboxEntries.length, 0)
    assert.equal(empty.children.get(childA)?.inboxPending, 0)
  })

  it('skips the asks fold unless a consumer opts in', () => {
    const ask: AskRecord = {
      askId: 'ask-opt-out',
      childId: childB,
      question: 'unconsumed',
      sessionFile: '/tmp/b.jsonl',
      createdAt: new Date().toISOString(),
    }
    writeAskRecord(ask, root)
    const counter = countingIo()
    const snap = buildAggregateSnapshot({
      ownerSessionId: owner,
      childIds: [childB],
      root,
      io: counter.io,
    })
    // No consumer → no asks readdir, askPending stays null even though the
    // record exists on disk.
    assert.equal(snap.children.get(childB)?.askPending, null)
    // Only the inbox fold ran: 1 readdir (+ reads for leftover inbox
    // records from earlier tests in this shared root).
    assert.equal(snap.reads, 1 + snap.inboxEntries.length)
    removeAskRecord(childB, root)
  })
})

// --- Handler-level tests: ask_owner replay windows (aven PMR-1006, PMR-ZJCP) ---
// AIDEV-NOTE (PMR-1006): first suite to load the CHILD extension's default
// export. Env is set per-test AFTER module load (the module-load scrub near
// the top of this file stays intact) and restored in finally. The mock
// extension api needs no extra surface: the child extension only registers
// tools/handlers plus unref'd 500ms pump intervals that no-op once env is
// restored (childId/sessionFile unset).

describe('subagent-done.ts ask_owner replay windows (PMR-1006 / PMR-ZJCP)', () => {
  const CHILD_ENV_NAMES = [
    'PI_SUBAGENT_ID',
    'PI_SUBAGENT_SESSION',
    'PI_SUBAGENT_NAME',
    'PI_SUBAGENT_PARENT_SESSION',
    'PI_SUBAGENT_ACTIVITY_FILE',
    'PI_CODING_AGENT_DIR',
  ] as const

  interface AskReplayHarness {
    childId: string
    root: string
    sessionFile: string
    askTool: {
      execute: (
        toolCallId: string,
        params: any,
        signal: any,
        onUpdate: any,
        ctx: any,
      ) => Promise<any>
    }
  }

  async function withChildExtensionEnv<T>(
    dir: string,
    run: (harness: AskReplayHarness) => Promise<T>,
  ): Promise<T> {
    const previous = new Map(
      CHILD_ENV_NAMES.map((name) => [name, process.env[name]] as const),
    )
    const childId = 'ask-replay-child'
    const agentDir = join(dir, 'agent')
    const root = subagentsDataRoot(agentDir)
    const sessionFile = join(dir, 'child-session.jsonl')
    process.env.PI_SUBAGENT_ID = childId
    process.env.PI_SUBAGENT_SESSION = sessionFile
    process.env.PI_SUBAGENT_NAME = 'ask-replay-child'
    process.env.PI_SUBAGENT_PARENT_SESSION = join(dir, 'parent-session.jsonl')
    process.env.PI_SUBAGENT_ACTIVITY_FILE = join(dir, 'activity.json')
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const mock = createMockExtensionApi()
      subagentDoneExtension(mock.api)
      const askTool = mock.registeredTools.find((t) => t.name === 'ask_owner')
      assert.ok(askTool, 'child extension must register ask_owner')
      return await run({ childId, root, sessionFile, askTool })
    } finally {
      for (const [name, value] of previous) {
        restoreEnvVar(name, value)
      }
    }
  }

  const QUESTION = 'What should the timeout be for the deploy step?'
  const OTHER_QUESTION = 'A completely different question?'

  function askFingerprint(childId: string, question: string): string {
    return effectFingerprint('ask_owner', childId, {
      question,
      files: undefined,
    })
  }

  function askRecordNames(root: string): string[] {
    return readdirSync(join(root, 'asks')).filter(
      (name) => name.endsWith('.json') && !name.endsWith('.reply.json'),
    )
  }

  function callAsk(
    askTool: AskReplayHarness['askTool'],
    question: string,
  ): Promise<any> {
    // Per-call ctx mock (later phases reuse this harness).
    const ctx = { shutdown() {} }
    return askTool.execute('call-1', { question }, undefined, undefined, ctx)
  }

  it('(a) identical interrupted call replays: same askId, one ask record, memo present', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(
        dir,
        async ({ childId, root, sessionFile, askTool }) => {
          const first = await callAsk(askTool, QUESTION)
          const firstAskId = first.details.askId
          assert.equal(typeof firstAskId, 'string')

          const replay = await callAsk(askTool, QUESTION)
          assert.equal(replay.details.askId, firstAskId)
          assert.match(replay.content[0].text, /Replay of an interrupted call/)

          const record = readAskRecord(childId, root)
          assert.ok(record)
          assert.equal(record.askId, firstAskId)
          assert.equal(askRecordNames(root).length, 1)

          const memo = readEffectMemo(
            childId,
            'ask_owner',
            askFingerprint(childId, QUESTION),
            root,
          )
          assert.ok(memo)
          assert.equal(memo.result.askId, firstAskId)

          assert.equal(readAskSidecar(sessionFile)?.askId, firstAskId)
        },
      ),
    )
  })

  it('(b) missing .ask sidecar is healed on replay with the record askId', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(
        dir,
        async ({ childId, root, sessionFile, askTool }) => {
          const first = await callAsk(askTool, QUESTION)
          const firstAskId = first.details.askId

          rmSync(`${sessionFile}.ask`)

          const replay = await callAsk(askTool, QUESTION)
          assert.equal(replay.details.askId, firstAskId)
          const healed = readAskSidecar(sessionFile)
          assert.ok(healed, 'sidecar must be healed')
          assert.equal(healed.askId, firstAskId)
          const record = readAskRecord(childId, root)
          assert.equal(record?.askId, firstAskId)
        },
      ),
    )
  })

  it('(c) formal resume wipe + orphan memo yields a fresh askId and names the dead one', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(
        dir,
        async ({ childId, root, sessionFile, askTool }) => {
          const first = await callAsk(askTool, QUESTION)
          const deadAskId = first.details.askId

          // Simulated formal resume (index.ts cleanup path).
          removeAskRecordsForSession(sessionFile, root)
          rmSync(`${sessionFile}.ask`)

          const fresh = await callAsk(askTool, QUESTION)
          const freshAskId = fresh.details.askId
          assert.equal(typeof freshAskId, 'string')
          assert.notEqual(freshAskId, deadAskId)
          assert.ok(
            fresh.content[0].text.includes(deadAskId),
            'result text must name the dead askId',
          )
          assert.match(fresh.content[0].text, /no longer live/)
          // PMR-TC54: the notice must be cause-neutral (the orphan branch
          // also fires for a byte-identical re-ask after an acked answer).
          assert.match(fresh.content[0].text, /records are gone/)

          const record = readAskRecord(childId, root)
          assert.equal(record?.askId, freshAskId)
          // Memo is rewritten to point at the fresh ask.
          const memo = readEffectMemo(
            childId,
            'ask_owner',
            askFingerprint(childId, QUESTION),
            root,
          )
          assert.ok(memo)
          assert.equal(memo.result.askId, freshAskId)
        },
      ),
    )
  })

  it('(d) a different question while an ask is live throws outstanding-ask', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(dir, async ({ askTool }) => {
        await callAsk(askTool, QUESTION)
        await assert.rejects(
          callAsk(askTool, OTHER_QUESTION),
          /outstanding ask/,
        )
      }),
    )
  })

  it('(e) hand-written live ask record (W1: no memo) is replayed with its askId', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(
        dir,
        async ({ childId, root, sessionFile, askTool }) => {
          const handAskId = 'hand-written-ask-id'
          writeAskRecord(
            {
              askId: handAskId,
              childId,
              name: 'hand',
              question: QUESTION,
              files: undefined,
              sessionFile,
              createdAt: new Date().toISOString(),
            },
            root,
          )

          const result = await callAsk(askTool, QUESTION)
          assert.equal(result.details.askId, handAskId)
          assert.match(result.content[0].text, /Replay of an interrupted call/)
        },
      ),
    )
  })

  it('(f) corrupted memo behaves as fresh: no crash, new ask, no orphan notice', async () => {
    await withTempDirAsync((dir) =>
      withChildExtensionEnv(
        dir,
        async ({ childId, root, sessionFile, askTool }) => {
          const first = await callAsk(askTool, QUESTION)
          const firstAskId = first.details.askId
          const memoPath = effectMemoPath(
            childId,
            'ask_owner',
            askFingerprint(childId, QUESTION),
            root,
          )
          writeFileSync(memoPath, 'definitely not valid json')

          // Wipe live records so the next call must take the fresh-ask path.
          removeAskRecordsForSession(sessionFile, root)
          rmSync(`${sessionFile}.ask`)

          const fresh = await callAsk(askTool, QUESTION)
          const freshAskId = fresh.details.askId
          assert.equal(typeof freshAskId, 'string')
          assert.notEqual(freshAskId, firstAskId)
          assert.ok(
            !fresh.content[0].text.includes('earlier ask_owner'),
            'corrupt memo must not trigger the orphan notice',
          )
          assert.equal(readAskRecord(childId, root)?.askId, freshAskId)
        },
      ),
    )
  })
})

// --- Handler-level tests: message_owner / message_peer replay windows (PMR-JBEX / PMR-ZJCP) ---
// AIDEV-NOTE (PMR-ZJCP): sibling of the ask_owner replay suite above; reuses
// the same per-test env harness pattern. The fake peer presence is published
// through the real publishPresence/lock helpers so resolvePeer sees it as
// live, and released in finally on every case.

describe('subagent-done.ts message tools replay windows (PMR-JBEX / PMR-ZJCP)', () => {
  const MESSAGE_ENV_NAMES = [
    'PI_SUBAGENT_ID',
    'PI_SUBAGENT_SESSION',
    'PI_SUBAGENT_NAME',
    'PI_SUBAGENT_PARENT_SESSION',
    'PI_SUBAGENT_ACTIVITY_FILE',
    'PI_CODING_AGENT_DIR',
  ] as const

  const OWNER_TEXT = 'Progress update: phase one finished cleanly.'
  const OTHER_OWNER_TEXT = 'Progress update: phase two finished cleanly.'
  const PEER_TEXT = 'Handing you the fixture notes for review.'
  const PEER_ID = 'peer-b'

  interface MessageTool {
    execute: (
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
      ctx: any,
    ) => Promise<any>
  }

  interface MessageHarness {
    childId: string
    root: string
    sessionFile: string
    parentSessionId: string
    messageOwnerTool: MessageTool
    messagePeerTool: MessageTool
  }

  async function withMessageToolsEnv<T>(
    dir: string,
    run: (harness: MessageHarness) => Promise<T>,
  ): Promise<T> {
    const previous = new Map(
      MESSAGE_ENV_NAMES.map((name) => [name, process.env[name]] as const),
    )
    const childId = 'msg-replay-child'
    const agentDir = join(dir, 'agent')
    const root = subagentsDataRoot(agentDir)
    const sessionFile = join(dir, 'child-session.jsonl')
    const parentSessionId = join(dir, 'parent-session.jsonl')
    process.env.PI_SUBAGENT_ID = childId
    process.env.PI_SUBAGENT_SESSION = sessionFile
    process.env.PI_SUBAGENT_NAME = 'msg-replay-child'
    process.env.PI_SUBAGENT_PARENT_SESSION = parentSessionId
    process.env.PI_SUBAGENT_ACTIVITY_FILE = join(dir, 'activity.json')
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const mock = createMockExtensionApi()
      subagentDoneExtension(mock.api)
      const messageOwnerTool = mock.registeredTools.find(
        (t) => t.name === 'message_owner',
      )
      const messagePeerTool = mock.registeredTools.find(
        (t) => t.name === 'message_peer',
      )
      assert.ok(messageOwnerTool, 'child extension must register message_owner')
      assert.ok(messagePeerTool, 'child extension must register message_peer')
      return await run({
        childId,
        root,
        sessionFile,
        parentSessionId,
        messageOwnerTool,
        messagePeerTool,
      })
    } finally {
      for (const [name, value] of previous) {
        restoreEnvVar(name, value)
      }
    }
  }

  function callMessage(
    tool: MessageTool,
    params: Record<string, unknown>,
  ): Promise<any> {
    const ctx = { shutdown() {} }
    return tool.execute('call-1', params, undefined, undefined, ctx)
  }

  function ownerFingerprint(childId: string, message: string): string {
    return effectFingerprint('message_owner', childId, { message })
  }

  function peerFingerprint(childId: string, message: string): string {
    return effectFingerprint('message_peer', childId, {
      peer: PEER_ID,
      message,
      resultRef: undefined,
    })
  }

  // Name-based variant: the binding/replay defect is about name re-resolution,
  // so these fingerprints key on the display name, not the childId.
  function peerFingerprintByName(
    childId: string,
    message: string,
    peerName: string,
  ): string {
    return effectFingerprint('message_peer', childId, {
      peer: peerName,
      message,
      resultRef: undefined,
    })
  }

  function removeMemo(
    childId: string,
    tool: 'message_owner' | 'message_peer',
    fingerprint: string,
    root: string,
  ): void {
    rmSync(effectMemoPath(childId, tool, fingerprint, root))
  }

  it('(a) message_owner identical interrupted call replays: one inbox entry, same messageId, replay-prefixed text', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(
        dir,
        async ({ childId, root, parentSessionId, messageOwnerTool }) => {
          const first = await callMessage(messageOwnerTool, {
            message: OWNER_TEXT,
          })
          assert.equal(typeof first.details.messageId, 'string')
          assert.ok(
            first.content[0].text.includes('Message delivered to the owner'),
          )

          const replay = await callMessage(messageOwnerTool, {
            message: OWNER_TEXT,
          })
          assert.equal(replay.details.messageId, first.details.messageId)
          assert.match(
            replay.content[0].text,
            /^\[Replay of an interrupted call\]/,
          )

          const inbox = readOwnerInbox(parentSessionId, root)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].message.messageId, first.details.messageId)
          assert.equal(inbox[0].message.message, OWNER_TEXT)

          const memo = readEffectMemo(
            childId,
            'message_owner',
            ownerFingerprint(childId, OWNER_TEXT),
            root,
          )
          assert.ok(memo)
          assert.equal(memo.result.messageId, first.details.messageId)
        },
      ),
    )
  })

  it('(b) message_owner with memo deleted replays from the inbox scan: still one entry, memo re-memoized', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(
        dir,
        async ({ childId, root, parentSessionId, messageOwnerTool }) => {
          const first = await callMessage(messageOwnerTool, {
            message: OWNER_TEXT,
          })
          const fingerprint = ownerFingerprint(childId, OWNER_TEXT)
          assert.ok(readEffectMemo(childId, 'message_owner', fingerprint, root))
          removeMemo(childId, 'message_owner', fingerprint, root)

          const replay = await callMessage(messageOwnerTool, {
            message: OWNER_TEXT,
          })
          assert.equal(replay.details.messageId, first.details.messageId)
          assert.ok(
            replay.content[0].text.includes('already delivered earlier'),
            'scan-path result must name the earlier delivery',
          )

          const inbox = readOwnerInbox(parentSessionId, root)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].message.messageId, first.details.messageId)

          const reMemo = readEffectMemo(
            childId,
            'message_owner',
            fingerprint,
            root,
          )
          assert.ok(reMemo, 'scan path must re-write the memo')
          assert.equal(reMemo.result.messageId, first.details.messageId)
        },
      ),
    )
  })

  it('(c) message_owner different texts deliver twice: two inbox entries', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(
        dir,
        async ({ root, parentSessionId, messageOwnerTool }) => {
          const first = await callMessage(messageOwnerTool, {
            message: OWNER_TEXT,
          })
          const second = await callMessage(messageOwnerTool, {
            message: OTHER_OWNER_TEXT,
          })
          assert.notEqual(second.details.messageId, first.details.messageId)

          const inbox = readOwnerInbox(parentSessionId, root)
          assert.equal(inbox.length, 2)
          const texts = inbox.map((entry) => entry.message.message).sort()
          assert.deepEqual(texts, [OWNER_TEXT, OTHER_OWNER_TEXT])
        },
      ),
    )
  })

  it('(d) message_owner without subagent env throws', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ messageOwnerTool }) => {
        delete process.env.PI_SUBAGENT_ID
        delete process.env.PI_SUBAGENT_PARENT_SESSION
        await assert.rejects(
          callMessage(messageOwnerTool, { message: OWNER_TEXT }),
          /only available in subagent contexts/,
        )
      }),
    )
  })

  it('(e) message_peer identical interrupted call replays: one inbox entry for the peer, same messageId', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const release = publishPresence(
          {
            childId: PEER_ID,
            sessionFile: join(dir, 'peer-b-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        try {
          const first = await callMessage(messagePeerTool, {
            peer: PEER_ID,
            message: PEER_TEXT,
          })
          assert.equal(typeof first.details.messageId, 'string')

          const replay = await callMessage(messagePeerTool, {
            peer: PEER_ID,
            message: PEER_TEXT,
          })
          assert.equal(replay.details.messageId, first.details.messageId)
          assert.match(
            replay.content[0].text,
            /^\[Replay of an interrupted call\]/,
          )

          const inbox = readInbox(PEER_ID, root)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].message.messageId, first.details.messageId)
          assert.equal(inbox[0].message.message, PEER_TEXT)
          assert.equal(inbox[0].message.from.childId, childId)

          const memo = readEffectMemo(
            childId,
            'message_peer',
            peerFingerprint(childId, PEER_TEXT),
            root,
          )
          assert.ok(memo)
          assert.equal(memo.result.messageId, first.details.messageId)
        } finally {
          release()
        }
      }),
    )
  })

  it('(f) message_peer with memo deleted replays from the inbox scan: still one entry', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const release = publishPresence(
          {
            childId: PEER_ID,
            sessionFile: join(dir, 'peer-b-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        try {
          const first = await callMessage(messagePeerTool, {
            peer: PEER_ID,
            message: PEER_TEXT,
          })
          const fingerprint = peerFingerprint(childId, PEER_TEXT)
          removeMemo(childId, 'message_peer', fingerprint, root)

          const replay = await callMessage(messagePeerTool, {
            peer: PEER_ID,
            message: PEER_TEXT,
          })
          assert.equal(replay.details.messageId, first.details.messageId)
          assert.ok(
            replay.content[0].text.includes('already delivered'),
            'scan-path result must name the earlier delivery',
          )

          const inbox = readInbox(PEER_ID, root)
          assert.equal(inbox.length, 1)
          assert.equal(inbox[0].message.messageId, first.details.messageId)
        } finally {
          release()
        }
      }),
    )
  })

  it('(g) message_peer memo hit works after peer presence is gone: memoized result, no throw', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const release = publishPresence(
          {
            childId: PEER_ID,
            sessionFile: join(dir, 'peer-b-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        let first: any
        try {
          first = await callMessage(messagePeerTool, {
            peer: PEER_ID,
            message: PEER_TEXT,
          })
        } finally {
          release()
        }
        assert.ok(first)

        // Peer is offline now; the memo-hit path must not call resolvePeer.
        const replay = await callMessage(messagePeerTool, {
          peer: PEER_ID,
          message: PEER_TEXT,
        })
        assert.equal(replay.details.messageId, first.details.messageId)
        assert.match(
          replay.content[0].text,
          /^\[Replay of an interrupted call\]/,
        )
        assert.equal(readInbox(PEER_ID, root).length, 1)
      }),
    )
  })

  it('(h) message_peer to self throws cannot-message-yourself', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(
        dir,
        async ({ childId, root, sessionFile, messagePeerTool }) => {
          // The child's own presence must be live for self to resolve.
          const release = publishPresence(
            { childId, sessionFile, name: 'msg-replay-child', cwd: dir },
            root,
          )
          try {
            await assert.rejects(
              callMessage(messagePeerTool, {
                peer: childId,
                message: PEER_TEXT,
              }),
              /Cannot message yourself/,
            )
            assert.equal(readInbox(childId, root).length, 0)
          } finally {
            release()
          }
        },
      ),
    )
  })

  it('(i) name replay across generations binds to gen-1: already-delivered from bound inbox, gen-2 untouched', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const releaseGen1 = publishPresence(
          {
            childId: 'peer-b-1',
            sessionFile: join(dir, 'peer-b-1-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        let first: any
        try {
          first = await callMessage(messagePeerTool, {
            peer: 'Peer B',
            message: PEER_TEXT,
          })
        } finally {
          releaseGen1()
        }
        assert.equal(typeof first.details.messageId, 'string')

        // Erase the memo so the replay must take the binding + evidence-scan
        // path, NOT the memo-hit path.
        removeMemo(
          childId,
          'message_peer',
          peerFingerprintByName(childId, PEER_TEXT, 'Peer B'),
          root,
        )

        // A newer generation under the same name appears before the replay.
        const releaseGen2 = publishPresence(
          {
            childId: 'peer-b-2',
            sessionFile: join(dir, 'peer-b-2-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        try {
          const replay = await callMessage(messagePeerTool, {
            peer: 'Peer B',
            message: PEER_TEXT,
          })
          assert.equal(replay.details.messageId, first.details.messageId)
          assert.ok(
            replay.content[0].text.includes('already delivered'),
            'replay must name the earlier delivery to the bound recipient',
          )

          // The bound (gen-1) inbox holds the original delivery; gen-2 got nothing.
          const gen1Inbox = readInbox('peer-b-1', root)
          assert.equal(gen1Inbox.length, 1)
          assert.equal(gen1Inbox[0].message.messageId, first.details.messageId)
          assert.equal(readInbox('peer-b-2', root).length, 0)

          // The scan path re-memoizes the original messageId.
          const memo = readEffectMemo(
            childId,
            'message_peer',
            peerFingerprintByName(childId, PEER_TEXT, 'Peer B'),
            root,
          )
          assert.ok(memo)
          assert.equal(memo.result.messageId, first.details.messageId)
        } finally {
          releaseGen2()
        }
      }),
    )
  })

  it('(j) first-write failure then replay delivers to bound gen-1 despite same-name gen-2', async (t) => {
    if (skipIfRoot(t)) return
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const releaseGen1 = publishPresence(
          {
            childId: 'peer-b-1',
            sessionFile: join(dir, 'peer-b-1-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        try {
          chmodSync(inboxDir('peer-b-1', root), 0o500)
          let firstError: unknown
          try {
            await callMessage(messagePeerTool, {
              peer: 'Peer B',
              message: PEER_TEXT,
            })
          } catch (error) {
            firstError = error
          }
          assert.ok(firstError, 'first execute must reject (EACCES on inbox)')

          // A newer same-name generation appears while the first send failed.
          const releaseGen2 = publishPresence(
            {
              childId: 'peer-b-2',
              sessionFile: join(dir, 'peer-b-2-session.jsonl'),
              name: 'Peer B',
              cwd: dir,
            },
            root,
          )
          try {
            chmodSync(inboxDir('peer-b-1', root), 0o700)

            const replay = await callMessage(messagePeerTool, {
              peer: 'Peer B',
              message: PEER_TEXT,
            })
            assert.equal(typeof replay.details.messageId, 'string')
            assert.ok(
              replay.content[0].text.includes('Message delivered to Peer B'),
            )

            // Delivered exactly once, to the BOUND generation, not gen-2.
            const gen1Inbox = readInbox('peer-b-1', root)
            assert.equal(gen1Inbox.length, 1)
            assert.equal(
              gen1Inbox[0].message.messageId,
              replay.details.messageId,
            )
            assert.equal(gen1Inbox[0].message.message, PEER_TEXT)
            assert.equal(readInbox('peer-b-2', root).length, 0)

            // Memo written and binding lastActivityAt advanced by the touch.
            const memo = readEffectMemo(
              childId,
              'message_peer',
              peerFingerprintByName(childId, PEER_TEXT, 'Peer B'),
              root,
            )
            assert.ok(memo)
            assert.equal(memo.result.messageId, replay.details.messageId)
            const binding = readPeerBinding(
              childId,
              peerFingerprintByName(childId, PEER_TEXT, 'Peer B'),
              root,
            )
            assert.ok(binding)
            assert.equal(binding.toChildId, 'peer-b-1')
            assert.ok(
              binding.lastActivityAt >= binding.createdAt,
              'binding lastActivityAt must have been touched',
            )
          } finally {
            releaseGen2()
          }
        } finally {
          // Always restore so temp-dir cleanup works even on failure.
          try {
            chmodSync(inboxDir('peer-b-1', root), 0o700)
          } catch {}
          releaseGen1()
        }
      }),
    )
  })

  it('(k) dead bound recipient fails closed: replay throws, no retarget to same-name gen-2', async (t) => {
    if (skipIfRoot(t)) return
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const releaseGen1 = publishPresence(
          {
            childId: 'peer-b-1',
            sessionFile: join(dir, 'peer-b-1-session.jsonl'),
            name: 'Peer B',
            cwd: dir,
          },
          root,
        )
        try {
          chmodSync(inboxDir('peer-b-1', root), 0o500)
          let firstError: unknown
          try {
            await callMessage(messagePeerTool, {
              peer: 'Peer B',
              message: PEER_TEXT,
            })
          } catch (error) {
            firstError = error
          }
          assert.ok(firstError, 'first execute must reject (EACCES on inbox)')

          // Release gen-1 BEFORE restoring perms: the bound recipient is now
          // dead, and a same-name gen-2 is live — the replay must NOT retarget.
          releaseGen1()
          const releaseGen2 = publishPresence(
            {
              childId: 'peer-b-2',
              sessionFile: join(dir, 'peer-b-2-session.jsonl'),
              name: 'Peer B',
              cwd: dir,
            },
            root,
          )
          try {
            await assert.rejects(
              callMessage(messagePeerTool, {
                peer: 'Peer B',
                message: PEER_TEXT,
              }),
              /no longer live.*no retarget/s,
            )

            // No delivery anywhere: bound inbox stays empty, gen-2 gets nothing,
            // and no memo was written for the failed logical send.
            assert.equal(readInbox('peer-b-1', root).length, 0)
            assert.equal(readInbox('peer-b-2', root).length, 0)
            assert.equal(
              readEffectMemo(
                childId,
                'message_peer',
                peerFingerprintByName(childId, PEER_TEXT, 'Peer B'),
                root,
              ),
              null,
            )
          } finally {
            releaseGen2()
          }
        } finally {
          try {
            chmodSync(inboxDir('peer-b-1', root), 0o700)
          } catch {}
          // releaseGen1 already called above; presence may be gone — unlink in
          // release() is best-effort, so a second call here is safe to skip.
        }
      }),
    )
  })

  it('(l) hand-written binding with mismatched request throws binding-conflict, no delivery', async () => {
    await withTempDirAsync((dir) =>
      withMessageToolsEnv(dir, async ({ childId, root, messagePeerTool }) => {
        const fingerprint = peerFingerprintByName(childId, PEER_TEXT, 'Peer B')
        writePeerBinding(
          {
            version: 1,
            childId,
            fingerprint,
            toChildId: 'peer-b-1',
            toSessionFile: join(dir, 'peer-b-1-session.jsonl'),
            toName: 'Peer B',
            request: {
              peer: 'Peer B',
              message: 'A DIFFERENT earlier message body',
              resultRef: undefined,
            },
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          },
          root,
        )

        await assert.rejects(
          callMessage(messagePeerTool, {
            peer: 'Peer B',
            message: PEER_TEXT,
          }),
          /Peer binding conflict/,
        )

        // No delivery, no memo: the conflict fails closed before any send.
        assert.equal(readInbox('peer-b-1', root).length, 0)
        assert.equal(
          readEffectMemo(childId, 'message_peer', fingerprint, root),
          null,
        )
      }),
    )
  })
})

// --- Handler-level tests: exit tools replay windows (aven PMR-G9J4 / PMR-ZJCP) ---
// AIDEV-NOTE (PMR-G9J4): sibling of the ask_owner/message replay suites above;
// same per-test env harness pattern. The `.exit` sidecar is the durable record
// for caller_ping and subagent_done, so cases hand-write payloads directly and
// assert the never-overwrite behavior. The ctx mock counts shutdown calls per
// execute invocation, as exit tools always terminate the session.
describe('subagent-done.ts exit tools replay windows (PMR-G9J4 / PMR-ZJCP)', () => {
  const EXIT_ENV_NAMES = [
    'PI_SUBAGENT_ID',
    'PI_SUBAGENT_SESSION',
    'PI_SUBAGENT_NAME',
    'PI_SUBAGENT_PARENT_SESSION',
    'PI_SUBAGENT_ACTIVITY_FILE',
    'PI_CODING_AGENT_DIR',
  ] as const

  interface ExitToolHarness {
    exitFile: string
    pingTool: {
      execute: (
        toolCallId: string,
        params: any,
        signal: any,
        onUpdate: any,
        ctx: any,
      ) => Promise<any>
    }
    doneTool: {
      execute: (
        toolCallId: string,
        params: any,
        signal: any,
        onUpdate: any,
        ctx: any,
      ) => Promise<any>
    }
  }

  interface ShutdownCtx {
    calls: number
    shutdown(): void
  }

  function makeShutdownCtx(): ShutdownCtx {
    const ctx: ShutdownCtx = {
      calls: 0,
      shutdown() {
        ctx.calls += 1
      },
    }
    return ctx
  }

  async function withExitToolsEnv<T>(
    dir: string,
    run: (harness: ExitToolHarness) => Promise<T>,
  ): Promise<T> {
    const previous = new Map(
      EXIT_ENV_NAMES.map((name) => [name, process.env[name]] as const),
    )
    const sessionFile = join(dir, 'child-session.jsonl')
    process.env.PI_SUBAGENT_ID = 'exit-tools-child'
    process.env.PI_SUBAGENT_SESSION = sessionFile
    process.env.PI_SUBAGENT_NAME = 'exit-tools-child'
    process.env.PI_SUBAGENT_PARENT_SESSION = join(dir, 'parent-session.jsonl')
    process.env.PI_SUBAGENT_ACTIVITY_FILE = join(dir, 'activity.json')
    process.env.PI_CODING_AGENT_DIR = join(dir, 'agent')
    try {
      const mock = createMockExtensionApi()
      subagentDoneExtension(mock.api)
      const pingTool = mock.registeredTools.find(
        (t) => t.name === 'caller_ping',
      )
      const doneTool = mock.registeredTools.find(
        (t) => t.name === 'subagent_done',
      )
      assert.ok(pingTool, 'child extension must register caller_ping')
      assert.ok(doneTool, 'child extension must register subagent_done')
      return await run({ exitFile: `${sessionFile}.exit`, pingTool, doneTool })
    } finally {
      for (const [name, value] of previous) {
        restoreEnvVar(name, value)
      }
    }
  }

  function callPing(pingTool: ExitToolHarness['pingTool'], message: string) {
    const ctx = makeShutdownCtx()
    const result = pingTool.execute(
      'call-1',
      { message },
      undefined,
      undefined,
      ctx,
    )
    return { ctx, result }
  }

  function callDone(doneTool: ExitToolHarness['doneTool']) {
    const ctx = makeShutdownCtx()
    const result = doneTool.execute('call-1', {}, undefined, undefined, ctx)
    return { ctx, result }
  }

  it('(a) caller_ping execute → identical execute: .exit unchanged, shutdown twice, replay text', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, pingTool }) => {
        const first = await callPing(pingTool, 'need help with X')
        const firstResult = await first.result
        assert.equal(first.ctx.calls, 1)
        assert.equal(
          firstResult.content[0].text,
          'Ping sent. Session will exit and parent will be notified.',
        )
        const original = readFileSync(exitFile, 'utf8')
        const parsedOriginal = JSON.parse(original)
        assert.equal(parsedOriginal.type, 'ping')
        assert.equal(parsedOriginal.message, 'need help with X')

        const second = await callPing(pingTool, 'need help with X')
        const secondResult = await second.result
        assert.equal(second.ctx.calls, 1)
        assert.match(
          secondResult.content[0].text,
          /Replay of an interrupted call/,
        )
        assert.match(
          secondResult.content[0].text,
          /Ping already recorded from the previous run/,
        )
        assert.equal(readFileSync(exitFile, 'utf8'), original)
      }),
    )
  })

  it('(b) caller_ping with pre-existing ping payload: preserved, conflict named, shutdown', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, pingTool }) => {
        const preExisting = { type: 'ping', name: 'x', message: 'other' }
        writeFileSync(exitFile, JSON.stringify(preExisting))

        const call = await callPing(pingTool, 'help')
        const result = await call.result
        assert.equal(call.ctx.calls, 1)
        assert.match(result.content[0].text, /.exit sidecar already records/)
        assert.match(result.content[0].text, /'ping'/)
        assert.match(result.content[0].text, /preserved/)
        assert.deepEqual(
          JSON.parse(readFileSync(exitFile, 'utf8')),
          preExisting,
        )
      }),
    )
  })

  it('(c) caller_ping with pre-existing error payload: preserved, conflict named, shutdown', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, pingTool }) => {
        const preExisting = {
          type: 'error',
          errorMessage: 'provider overload',
          stopReason: 'error',
        }
        writeFileSync(exitFile, JSON.stringify(preExisting))

        const call = await callPing(pingTool, 'help')
        const result = await call.result
        assert.equal(call.ctx.calls, 1)
        assert.match(result.content[0].text, /.exit sidecar already records/)
        assert.match(result.content[0].text, /'error'/)
        assert.deepEqual(
          JSON.parse(readFileSync(exitFile, 'utf8')),
          preExisting,
        )
      }),
    )
  })

  it('(d) caller_ping with invalid JSON .exit: overwritten with fresh ping payload', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, pingTool }) => {
        writeFileSync(exitFile, 'definitely not valid json')

        const call = await callPing(pingTool, 'help me recover')
        const result = await call.result
        assert.equal(call.ctx.calls, 1)
        assert.equal(
          result.content[0].text,
          'Ping sent. Session will exit and parent will be notified.',
        )
        const parsed = JSON.parse(readFileSync(exitFile, 'utf8'))
        assert.equal(parsed.type, 'ping')
        assert.equal(parsed.message, 'help me recover')
      }),
    )
  })

  it('(e) caller_ping without PI_SUBAGENT_SESSION throws', async () => {
    const previous = process.env.PI_SUBAGENT_SESSION
    delete process.env.PI_SUBAGENT_SESSION
    try {
      const mock = createMockExtensionApi()
      subagentDoneExtension(mock.api)
      const pingTool = mock.registeredTools.find(
        (t) => t.name === 'caller_ping',
      )
      assert.ok(pingTool)
      const ctx = makeShutdownCtx()
      await assert.rejects(
        pingTool.execute(
          'call-1',
          { message: 'help' },
          undefined,
          undefined,
          ctx,
        ),
        /PI_SUBAGENT_SESSION environment variable is not set/,
      )
      assert.equal(ctx.calls, 0)
    } finally {
      restoreEnvVar('PI_SUBAGENT_SESSION', previous)
    }
  })

  it('(f) subagent_done execute → execute: {type:done} payload stable, no throw', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, doneTool }) => {
        const first = await callDone(doneTool)
        const firstResult = await first.result
        assert.equal(first.ctx.calls, 1)
        assert.equal(
          firstResult.content[0].text,
          'Shutting down subagent session.',
        )
        const original = readFileSync(exitFile, 'utf8')
        assert.equal(JSON.parse(original).type, 'done')

        const second = await callDone(doneTool)
        const secondResult = await second.result
        assert.equal(second.ctx.calls, 1)
        assert.match(
          secondResult.content[0].text,
          /Replay of an interrupted call/,
        )
        assert.match(
          secondResult.content[0].text,
          /Done already recorded from the previous run/,
        )
        assert.equal(readFileSync(exitFile, 'utf8'), original)
      }),
    )
  })

  it('(g) subagent_done with pre-existing ping payload: preserved, reported, shutdown', async () => {
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, doneTool }) => {
        const preExisting = {
          type: 'ping',
          name: 'exit-tools-child',
          message: 'waiting on parent',
        }
        writeFileSync(exitFile, JSON.stringify(preExisting))

        const call = await callDone(doneTool)
        const result = await call.result
        assert.equal(call.ctx.calls, 1)
        assert.match(result.content[0].text, /.exit sidecar already records/)
        assert.match(result.content[0].text, /'ping'/)
        assert.match(result.content[0].text, /preserved/)
        assert.deepEqual(
          JSON.parse(readFileSync(exitFile, 'utf8')),
          preExisting,
        )
      }),
    )
  })

  it('(h) subagent_done without PI_SUBAGENT_SESSION: recorder runs, no .exit write', async () => {
    const previous = process.env.PI_SUBAGENT_SESSION
    delete process.env.PI_SUBAGENT_SESSION
    try {
      const mock = createMockExtensionApi()
      subagentDoneExtension(mock.api)
      const doneTool = mock.registeredTools.find(
        (t) => t.name === 'subagent_done',
      )
      assert.ok(doneTool)
      const ctx = makeShutdownCtx()
      const result = await doneTool.execute(
        'call-1',
        {},
        undefined,
        undefined,
        ctx,
      )
      assert.equal(ctx.calls, 1)
      assert.equal(result.content[0].text, 'Shutting down subagent session.')
    } finally {
      restoreEnvVar('PI_SUBAGENT_SESSION', previous)
    }
    // No session env means no session file path, so no `.exit` sibling was
    // ever written — verified indirectly: with a restored env, a fresh execute
    // takes the fresh path and writes its own payload.
    await withTempDirAsync((dir) =>
      withExitToolsEnv(dir, async ({ exitFile, doneTool: freshTool }) => {
        assert.ok(!existsSync(exitFile))
        await callDone(freshTool)
        assert.equal(JSON.parse(readFileSync(exitFile, 'utf8')).type, 'done')
      }),
    )
  })
})

// --- retention.ts (PMR-KT90) ---

describe('retention.ts (PMR-KT90 prune sweep)', () => {
  const DEAD_PID = 0x400000
  const RETENTION_NOW = new Date('2026-06-01T00:00:00.000Z')
  // Cutoff with retentionDays: 7 is 2026-05-25. OLD is well before it,
  // RECENT is after it but before NOW.
  const OLD_ISO = '2020-01-01T00:00:00.000Z'
  const RECENT_ISO = '2026-05-31T00:00:00.000Z'
  const OLD_MS = Date.parse(OLD_ISO)

  let root: string
  let agentDir: string
  let sessionsDir: string

  function freshFixture(): void {
    agentDir = mkdtempSync(join(tmpdir(), 'retention-agentdir-'))
    root = join(agentDir, 'pi-subagents')
    sessionsDir = join(agentDir, 'sessions')
  }

  function prune(): PruneReport {
    return pruneSubagentsData({
      retentionDays: 7,
      now: (): Date => RETENTION_NOW,
      root,
      agentDir,
    })
  }

  function sessionFileInAgentDir(name: string): string {
    // A real .jsonl under the injected agentDir's sessions tree; prune's
    // owner-inbox scan and existsSync-based resumability both see it.
    const path = join(sessionsDir, name.slice(0, 2), name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
    return path
  }

  function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  }

  function writeRaw(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }

  interface FixtureAssignment {
    childId: string
    sessionFile: string
    pid: number
    updatedAt: string
  }

  function assignmentFixture(
    params: FixtureAssignment,
  ): Record<string, unknown> {
    return {
      version: 1,
      childId: params.childId,
      name: params.childId,
      task: 'test task',
      sessionFile: params.sessionFile,
      cwd: '/tmp',
      status: 'lost',
      claim: { pid: params.pid, id: randomUUID() },
      createdAt: params.updatedAt,
      updatedAt: params.updatedAt,
    }
  }

  function writeAssignmentFixture(params: FixtureAssignment): void {
    writeJson(
      join(root, 'assignments', `${params.childId}.json`),
      assignmentFixture(params),
    )
  }

  interface FixturePresence {
    childId: string
    sessionFile: string
    pid: number
    updatedAt: string
  }

  function presenceFixture(params: FixturePresence): Record<string, unknown> {
    return {
      version: 1,
      childId: params.childId,
      sessionId: params.childId,
      sessionFile: params.sessionFile,
      name: params.childId,
      cwd: '/tmp',
      claim: { pid: params.pid, id: randomUUID() },
      updatedAt: params.updatedAt,
    }
  }

  /**
   * Publish a presence lock whose claim pid is provably dead (no PID can
   * ever be 2^22+), so readProcessLockStatus reports live:false instead of
   * throwing "Unable to verify". Returns a cleanup function — the lock dir
   * lives in the shared keyed temp root.
   */
  function publishDeadPresenceLock(sessionFile: string): () => void {
    const lockPath = peerLockPath(sessionFile)
    const claim = { pid: DEAD_PID, id: randomUUID() }
    mkdirSync(lockPath, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(lockPath, `${claim.pid}-${claim.id}`),
      JSON.stringify(claim),
    )
    return () => rmSync(lockPath, { recursive: true, force: true })
  }

  function effectMemoFixture(params: {
    childId: string
    createdAt: string
  }): Record<string, unknown> {
    return {
      version: 1,
      childId: params.childId,
      tool: 'message_peer',
      fingerprint: `fp-${params.childId}`,
      createdAt: params.createdAt,
      result: {},
    }
  }

  function peerBindingFixture(params: {
    childId: string
    activityAt: string
  }): Record<string, unknown> {
    return {
      version: 1,
      childId: params.childId,
      fingerprint: `fp-${params.childId}`,
      toChildId: `${params.childId}-peer`,
      toSessionFile: '/nonexistent/peer.jsonl',
      toName: 'peer',
      request: { peer: 'peer', message: 'hello' },
      createdAt: params.activityAt,
      lastActivityAt: params.activityAt,
    }
  }

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('prunes old results and retired payloads, keeps recent ones', () => {
    freshFixture()
    writeJson(join(root, 'results', 'old.json'), { createdAt: OLD_ISO })
    writeJson(join(root, 'results', 'recent.json'), { createdAt: RECENT_ISO })
    writeRaw(join(root, 'results', 'garbage.json'), 'not-json')
    writeJson(join(root, 'results', 'notimestamp.json'), { childId: 'x' })
    writeJson(join(root, 'retired', 'aaa.json'), { retiredAt: OLD_ISO })
    writeJson(join(root, 'retired', 'bbb.json'), { retiredAt: RECENT_ISO })

    const report = prune()

    assert.ok(!existsSync(join(root, 'results', 'old.json')))
    assert.ok(existsSync(join(root, 'results', 'recent.json')))
    assert.ok(existsSync(join(root, 'results', 'garbage.json')))
    assert.ok(existsSync(join(root, 'results', 'notimestamp.json')))
    assert.ok(!existsSync(join(root, 'retired', 'aaa.json')))
    assert.ok(existsSync(join(root, 'retired', 'bbb.json')))
    assert.equal(report.removed.results, 1)
    assert.equal(report.removed.retired, 1)
    assert.equal(report.skipped.results, 3)
    assert.equal(report.skipped.retired, 1)
  })

  it('prunes old interrupts only when the replay session file is gone', () => {
    freshFixture()
    const live = sessionFileInAgentDir('live.jsonl')
    writeJson(join(root, 'interrupts', 'replayable.json'), {
      toolCallId: 'replayable',
      childId: 'a',
      sessionFile: live,
      requestId: 'r1',
      sentAt: OLD_ISO,
    })
    writeJson(join(root, 'interrupts', 'orphaned.json'), {
      toolCallId: 'orphaned',
      childId: 'b',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      requestId: 'r2',
      sentAt: OLD_ISO,
    })
    writeJson(join(root, 'interrupts', 'fresh.json'), {
      toolCallId: 'fresh',
      childId: 'c',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      requestId: 'r3',
      sentAt: RECENT_ISO,
    })

    const report = prune()

    assert.ok(existsSync(join(root, 'interrupts', 'replayable.json')))
    assert.ok(!existsSync(join(root, 'interrupts', 'orphaned.json')))
    assert.ok(existsSync(join(root, 'interrupts', 'fresh.json')))
    assert.equal(report.removed.interrupts, 1)
    assert.equal(report.skipped.interrupts, 2)
  })

  it('keeps delivered markers whose source record still exists', () => {
    freshFixture()
    // Old marker with a live owner-inbox source record → keep.
    writeJson(join(root, 'inbox', 'parent-1', 'msg.json'), {
      version: 1,
      messageId: 'req-1',
      from: { childId: 'c1' },
      message: 'hi',
      sentAt: RECENT_ISO,
    })
    const keptMarker = join(root, 'delivered', 'parent-1', 'req-1')
    writeRaw(keptMarker, '')
    utimesSync(keptMarker, new Date(OLD_MS), new Date(OLD_MS))
    // Old marker with no source anywhere → prunable.
    const goneMarker = join(root, 'delivered', 'parent-2', 'req-2')
    writeRaw(goneMarker, '')
    utimesSync(goneMarker, new Date(OLD_MS), new Date(OLD_MS))
    // Fresh marker → keep regardless of source.
    const freshMarker = join(root, 'delivered', 'parent-3', 'req-3')
    writeRaw(freshMarker, '')

    const report = prune()

    assert.ok(existsSync(keptMarker))
    assert.ok(!existsSync(goneMarker))
    assert.ok(existsSync(freshMarker))
    assert.equal(report.removed.delivered, 1)
    assert.equal(report.skipped.delivered, 2)
    // Negative space: the source mailbox record is untouched.
    assert.ok(existsSync(join(root, 'inbox', 'parent-1', 'msg.json')))
  })

  it('keeps a control delivered marker while its control source record exists', () => {
    freshFixture()
    // AIDEV-NOTE (PMR-KT90): the marker dir uses the ON-DISK sanitized scope
    // (sanitizeScope maps ':' → '_'), matching how markDelivered writes
    // `control:<childId>` markers — the prune scan only ever sees the
    // sanitized shape.
    writeJson(join(root, 'asks', 'kid.control.json'), {
      requestId: 'req-ctl',
      kind: 'interrupt',
    })
    const keptMarker = join(root, 'delivered', 'control_kid', 'req-ctl')
    writeRaw(keptMarker, '')
    utimesSync(keptMarker, new Date(OLD_MS), new Date(OLD_MS))
    // Same sanitized control scope but no source record → prunable.
    const goneMarker = join(root, 'delivered', 'control_gone', 'req-ctl')
    writeRaw(goneMarker, '')
    utimesSync(goneMarker, new Date(OLD_MS), new Date(OLD_MS))

    const report = prune()

    assert.ok(existsSync(keptMarker))
    assert.ok(!existsSync(goneMarker))
    assert.equal(report.removed.delivered, 1)
    assert.equal(report.skipped.delivered, 1)
    const reasons = report.skipReasons.join('\n')
    assert.match(reasons, /delivered: source record still exists/)
    // Negative space: the control source record itself is untouched (the
    // asks class only touches it as a sibling of a prunable ask record).
    assert.ok(existsSync(join(root, 'asks', 'kid.control.json')))
  })

  it('keeps a delivered marker when its ask-reply source is unreadable (fail closed)', () => {
    // AIDEV-NOTE (PMR-KT90): a reply record that EXISTS but is malformed
    // (readJson → null) is not "no source" — the marker's source cannot be
    // disproven, so the sweep must keep the marker (duplicate-delivery
    // window stays closed). Deviation-gate fix round 2.
    freshFixture()
    writeRaw(join(root, 'asks', 'kid-reply.reply.json'), '{nope')
    const marker = join(root, 'delivered', 'kid-reply', 'req-x')
    writeRaw(marker, '')
    utimesSync(marker, new Date(OLD_MS), new Date(OLD_MS))

    const report = prune()

    assert.ok(existsSync(marker))
    assert.equal(report.removed.delivered, undefined)
    assert.equal(report.skipped.delivered, 1)
    assert.match(report.skipReasons.join('\n'), /delivered: source scan failed/)
  })

  it('keeps a peer whose inbox dir is unreadable (fail closed)', () => {
    // AIDEV-NOTE (PMR-KT90): chmod 0o000 makes readdirSync fail EACCES —
    // an inbox that EXISTS but cannot be listed is not an empty inbox; the
    // whole candidate must be kept, never force-removed. Root ignores
    // permission bits, so the injection is a no-op there and the test skips
    // itself. Deviation-gate fix round 2.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    freshFixture()
    const goneSession = join(agentDir, 'sessions', 'stuck.jsonl')
    writeJson(
      join(root, 'peers', 'stuck.json'),
      presenceFixture({
        childId: 'stuck',
        sessionFile: goneSession,
        pid: DEAD_PID,
        updatedAt: OLD_ISO,
      }),
    )
    const deadCleanup = publishDeadPresenceLock(goneSession)
    const inboxDir = join(root, 'peers', 'stuck', 'inbox')
    writeJson(join(inboxDir, 'm1.json'), {
      version: 1,
      messageId: 'm1',
      from: { childId: 'someone' },
      message: 'hello',
      sentAt: OLD_ISO,
    })
    chmodSync(inboxDir, 0o000)
    let report: PruneReport
    try {
      report = prune()
    } finally {
      chmodSync(inboxDir, 0o700)
      deadCleanup()
    }

    assert.ok(existsSync(join(root, 'peers', 'stuck.json')))
    assert.ok(existsSync(join(inboxDir, 'm1.json')))
    assert.equal(report.removed.peers, undefined)
    assert.equal(report.skipped.peers, 1)
    assert.match(report.skipReasons.join('\n'), /peers: inbox unreadable/)
  })

  it('prunes tool-effects only when the child session file is gone', () => {
    freshFixture()
    const resumableSession = sessionFileInAgentDir('resumable.jsonl')
    // Old memo, child session file still on disk → keep.
    writeAssignmentFixture({
      childId: 'alive',
      sessionFile: resumableSession,
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    writeJson(
      join(root, 'tool-effects', 'alive', 'message_peer-fp.json'),
      effectMemoFixture({ childId: 'alive', createdAt: OLD_ISO }),
    )
    // Old memo, session file gone → prunable.
    writeAssignmentFixture({
      childId: 'gone',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    writeJson(
      join(root, 'tool-effects', 'gone', 'message_peer-fp.json'),
      effectMemoFixture({ childId: 'gone', createdAt: OLD_ISO }),
    )
    // Old memo, no identity record at all → unresolvable, keep.
    writeJson(
      join(root, 'tool-effects', 'orphan', 'message_peer-fp.json'),
      effectMemoFixture({ childId: 'orphan', createdAt: OLD_ISO }),
    )
    // Recent memo, session file gone → age keeps it.
    writeJson(
      join(root, 'tool-effects', 'fresh', 'message_peer-fp.json'),
      effectMemoFixture({ childId: 'fresh', createdAt: RECENT_ISO }),
    )

    const report = prune()

    assert.ok(existsSync(join(root, 'tool-effects', 'alive')))
    assert.ok(!existsSync(join(root, 'tool-effects', 'gone')))
    assert.ok(existsSync(join(root, 'tool-effects', 'orphan')))
    assert.ok(existsSync(join(root, 'tool-effects', 'fresh')))
    assert.equal(report.removed['tool-effects'], 1)
    assert.equal(report.skipped['tool-effects'], 3)
    // Negative space: the assignments feeding the resolution are untouched
    // (assignments prune runs after tool-effects and their session files /
    // pids keep them prunable-proof).
    assert.ok(existsSync(join(root, 'assignments', 'alive.json')))
  })

  it('prunes peer-bindings only when the child session file is gone', () => {
    freshFixture()
    const resumableSession = sessionFileInAgentDir('resumable.jsonl')
    writeAssignmentFixture({
      childId: 'alive',
      sessionFile: resumableSession,
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    writeJson(
      join(root, 'peer-bindings', 'alive', 'fp.json'),
      peerBindingFixture({ childId: 'alive', activityAt: OLD_ISO }),
    )
    writeAssignmentFixture({
      childId: 'gone',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    writeJson(
      join(root, 'peer-bindings', 'gone', 'fp.json'),
      peerBindingFixture({ childId: 'gone', activityAt: OLD_ISO }),
    )
    writeJson(
      join(root, 'peer-bindings', 'fresh', 'fp.json'),
      peerBindingFixture({ childId: 'fresh', activityAt: RECENT_ISO }),
    )

    const report = prune()

    assert.ok(existsSync(join(root, 'peer-bindings', 'alive')))
    assert.ok(!existsSync(join(root, 'peer-bindings', 'gone')))
    assert.ok(existsSync(join(root, 'peer-bindings', 'fresh')))
    assert.equal(report.removed['peer-bindings'], 1)
    assert.equal(report.skipped['peer-bindings'], 2)
  })

  it('keeps live-claim assignments and resumable ones, prunes dead+aged', () => {
    freshFixture()
    // Live claim pid → keep even though ancient.
    writeAssignmentFixture({
      childId: 'live',
      sessionFile: join(agentDir, 'sessions', 'live.jsonl'),
      pid: process.pid,
      updatedAt: OLD_ISO,
    })
    // Dead pid but session file on disk (resumable) → keep.
    const resumable = sessionFileInAgentDir('resumable.jsonl')
    writeAssignmentFixture({
      childId: 'resumable',
      sessionFile: resumable,
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    // Dead pid, session file gone, aged → prune.
    writeAssignmentFixture({
      childId: 'gone',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      pid: DEAD_PID,
      updatedAt: OLD_ISO,
    })
    // Dead pid, session file gone, but recent → age keeps it.
    writeAssignmentFixture({
      childId: 'fresh',
      sessionFile: join(agentDir, 'sessions', 'gone.jsonl'),
      pid: DEAD_PID,
      updatedAt: RECENT_ISO,
    })
    // Malformed JSON → keep, count as skipped.
    writeRaw(join(root, 'assignments', 'garbage.json'), 'not-json')
    // Missing updatedAt → keep, count as skipped.
    writeJson(join(root, 'assignments', 'notimestamp.json'), {
      childId: 'notimestamp',
      sessionFile: '/nonexistent.jsonl',
      claim: { pid: DEAD_PID, id: randomUUID() },
    })

    const report = prune()

    assert.ok(existsSync(join(root, 'assignments', 'live.json')))
    assert.ok(existsSync(join(root, 'assignments', 'resumable.json')))
    assert.ok(!existsSync(join(root, 'assignments', 'gone.json')))
    assert.ok(existsSync(join(root, 'assignments', 'fresh.json')))
    assert.ok(existsSync(join(root, 'assignments', 'garbage.json')))
    assert.ok(existsSync(join(root, 'assignments', 'notimestamp.json')))
    assert.equal(report.removed.assignments, 1)
    assert.equal(report.skipped.assignments, 5)
    const reasons = report.skipReasons.join('\n')
    assert.match(reasons, /assignments: live claim pid/)
    assert.match(
      reasons,
      /assignments: session file still exists \(resumable\)/,
    )
    assert.match(reasons, /assignments: malformed record/)
    assert.match(reasons, /assignments: missing\/unparseable updatedAt/)
  })

  it('keeps live/resumable/undrained peers, prunes dead+aged ones', () => {
    freshFixture()
    // Live presence lock → keep.
    const liveSession = join(agentDir, 'sessions', 'live.jsonl')
    const liveLease = acquireProcessLock(peerLockPath(liveSession))
    writeJson(join(root, 'peers', 'live.json'), {
      ...presenceFixture({
        childId: 'live',
        sessionFile: liveSession,
        pid: liveLease.claim.pid,
        updatedAt: OLD_ISO,
      }),
      claim: liveLease.claim,
    })
    try {
      // Dead pid, session file on disk (resumable) → keep.
      const resumable = sessionFileInAgentDir('resumable.jsonl')
      writeJson(
        join(root, 'peers', 'resumable.json'),
        presenceFixture({
          childId: 'resumable',
          sessionFile: resumable,
          pid: DEAD_PID,
          updatedAt: OLD_ISO,
        }),
      )
      const deadCleanup = publishDeadPresenceLock(resumable)
      try {
        // Dead pid, session file gone, aged, with an inbox → prune all of it.
        const goneSession = join(agentDir, 'sessions', 'gone.jsonl')
        writeJson(
          join(root, 'peers', 'gone.json'),
          presenceFixture({
            childId: 'gone',
            sessionFile: goneSession,
            pid: DEAD_PID,
            updatedAt: OLD_ISO,
          }),
        )
        const deadGoneCleanup = publishDeadPresenceLock(goneSession)
        try {
          writeJson(join(root, 'peers', 'gone', 'inbox', 'm1.json'), {
            version: 1,
            messageId: 'm1',
            from: { childId: 'someone' },
            message: 'hello',
            sentAt: OLD_ISO,
          })
          // Recent inbox message → newest activity keeps the whole peer.
          writeJson(
            join(root, 'peers', 'fresh.json'),
            presenceFixture({
              childId: 'fresh',
              sessionFile: join(agentDir, 'sessions', 'fresh-gone.jsonl'),
              pid: DEAD_PID,
              updatedAt: OLD_ISO,
            }),
          )
          writeJson(join(root, 'peers', 'fresh', 'inbox', 'm2.json'), {
            version: 1,
            messageId: 'm2',
            from: { childId: 'someone' },
            message: 'hello',
            sentAt: RECENT_ISO,
          })
          // Dead pid but no lock dir at all → liveness unverifiable → keep.
          writeJson(
            join(root, 'peers', 'nolock.json'),
            presenceFixture({
              childId: 'nolock',
              sessionFile: join(agentDir, 'sessions', 'nolock.jsonl'),
              pid: DEAD_PID,
              updatedAt: OLD_ISO,
            }),
          )

          const report = prune()

          assert.ok(existsSync(join(root, 'peers', 'live.json')))
          assert.ok(existsSync(join(root, 'peers', 'resumable.json')))
          assert.ok(!existsSync(join(root, 'peers', 'gone.json')))
          assert.ok(!existsSync(join(root, 'peers', 'gone')))
          assert.ok(existsSync(join(root, 'peers', 'fresh.json')))
          assert.ok(
            existsSync(join(root, 'peers', 'fresh', 'inbox', 'm2.json')),
          )
          assert.ok(existsSync(join(root, 'peers', 'nolock.json')))
          assert.equal(report.removed.peers, 1)
          assert.equal(report.skipped.peers, 4)
          const reasons = report.skipReasons.join('\n')
          assert.match(reasons, /peers: live presence lock/)
          assert.match(
            reasons,
            /peers: session file still exists \(resumable\)/,
          )
          assert.match(reasons, /peers: liveness inspection failed/)
        } finally {
          deadGoneCleanup()
        }
      } finally {
        deadCleanup()
      }
    } finally {
      liveLease.release()
    }
  })

  it('keeps asks of live/blocked children, prunes dead+aged candidates', () => {
    freshFixture()
    // Live claim pid behind the ask → keep.
    writeAssignmentFixture({
      childId: 'livechild',
      sessionFile: join(agentDir, 'sessions', 'live.jsonl'),
      pid: process.pid,
      updatedAt: OLD_ISO,
    })
    writeJson(join(root, 'asks', 'livechild.json'), {
      askId: 'ask-live',
      childId: 'livechild',
      question: 'q',
      sessionFile: join(agentDir, 'sessions', 'live.jsonl'),
      createdAt: OLD_ISO,
    })
    // Session file on disk (blocked child waiting) → keep.
    const blocked = sessionFileInAgentDir('blocked.jsonl')
    writeJson(join(root, 'asks', 'blocked.json'), {
      askId: 'ask-blocked',
      childId: 'blocked',
      question: 'q',
      sessionFile: blocked,
      createdAt: OLD_ISO,
    })
    // Dead child, session file gone, aged → prune ask + reply + control.
    const goneSession = join(agentDir, 'sessions', 'gone.jsonl')
    writeJson(join(root, 'asks', 'gone.json'), {
      askId: 'ask-gone',
      childId: 'gone',
      question: 'q',
      sessionFile: goneSession,
      createdAt: OLD_ISO,
    })
    writeJson(join(root, 'asks', 'gone.reply.json'), {
      askId: 'ask-gone',
      message: 'answer',
      repliedAt: OLD_ISO,
    })
    writeJson(join(root, 'asks', 'gone.control.json'), {
      requestId: 'ctl-gone',
      kind: 'interrupt',
    })
    // Old ask but recent reply → newest activity keeps it.
    writeJson(join(root, 'asks', 'recentreply.json'), {
      askId: 'ask-recent',
      childId: 'recentreply',
      question: 'q',
      sessionFile: join(agentDir, 'sessions', 'recent-gone.jsonl'),
      createdAt: OLD_ISO,
    })
    writeJson(join(root, 'asks', 'recentreply.reply.json'), {
      askId: 'ask-recent',
      message: 'answer',
      repliedAt: RECENT_ISO,
    })

    const report = prune()

    assert.ok(existsSync(join(root, 'asks', 'livechild.json')))
    assert.ok(existsSync(join(root, 'asks', 'blocked.json')))
    assert.ok(!existsSync(join(root, 'asks', 'gone.json')))
    assert.ok(!existsSync(join(root, 'asks', 'gone.reply.json')))
    assert.ok(!existsSync(join(root, 'asks', 'gone.control.json')))
    assert.ok(existsSync(join(root, 'asks', 'recentreply.json')))
    assert.ok(existsSync(join(root, 'asks', 'recentreply.reply.json')))
    assert.equal(report.removed.asks, 1)
    assert.equal(report.skipped.asks, 3)
    const reasons = report.skipReasons.join('\n')
    assert.match(reasons, /asks: live claim pid/)
    assert.match(reasons, /asks: session file still exists \(resumable\)/)
  })

  it('reports a real unlink failure as delete failed, not removed', () => {
    // AIDEV-NOTE (PMR-KT90): chmod injection (0o500 = readable, not
    // writable) makes unlinkSync fail EACCES — a REAL failure, distinct from
    // the expected ENOENT missing-sibling case. Root ignores permission
    // bits, so the injection is a no-op there and the test skips itself.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    freshFixture()
    const goneSession = join(agentDir, 'sessions', 'gone.jsonl')
    writeJson(join(root, 'asks', 'gone.json'), {
      askId: 'ask-gone',
      childId: 'gone',
      question: 'q',
      sessionFile: goneSession,
      createdAt: OLD_ISO,
    })
    const asksDir = join(root, 'asks')
    chmodSync(asksDir, 0o500)
    let report: PruneReport
    try {
      report = prune()
    } finally {
      chmodSync(asksDir, 0o700)
    }

    assert.ok(existsSync(join(root, 'asks', 'gone.json')))
    assert.equal(report.removed.asks, undefined)
    assert.equal(report.skipped.asks, 1)
    assert.match(report.skipReasons.join('\n'), /asks: delete failed/)
  })

  it('prunes owner inbox only when the parent session file is gone', () => {
    freshFixture()
    // Parent session file exists under agentDir/sessions → keep. The name
    // uses the REAL pi session-file shape <ISO-ts>_<sessionId>.jsonl (built
    // in index.ts spawn) — a bare <id>.jsonl fixture would leave the
    // resumability guard uncovered.
    sessionFileInAgentDir('2026-01-01T00-00-00-000Z_parent-live.jsonl')
    writeJson(join(root, 'inbox', 'parent-live', 'm1.json'), {
      version: 1,
      messageId: 'm1',
      from: { childId: 'c1' },
      message: 'hi',
      sentAt: OLD_ISO,
    })
    // Parent session file gone, aged → prune.
    writeJson(join(root, 'inbox', 'parent-gone', 'm2.json'), {
      version: 1,
      messageId: 'm2',
      from: { childId: 'c2' },
      message: 'hi',
      sentAt: OLD_ISO,
    })
    // Recent message → keep.
    writeJson(join(root, 'inbox', 'parent-fresh', 'm3.json'), {
      version: 1,
      messageId: 'm3',
      from: { childId: 'c3' },
      message: 'hi',
      sentAt: RECENT_ISO,
    })

    const report = prune()

    assert.ok(existsSync(join(root, 'inbox', 'parent-live', 'm1.json')))
    assert.ok(!existsSync(join(root, 'inbox', 'parent-gone')))
    assert.ok(existsSync(join(root, 'inbox', 'parent-fresh', 'm3.json')))
    assert.equal(report.removed.inbox, 1)
    assert.equal(report.skipped.inbox, 2)
  })

  it('never touches result-ref-reservations or spawn-seq, even ancient', () => {
    freshFixture()
    const reservation = join(root, 'result-ref-reservations', 'review', '1')
    writeRaw(reservation, 'canonical-1')
    utimesSync(reservation, new Date(OLD_MS), new Date(OLD_MS))
    const spawnSeq = join(root, 'spawn-seq', 'parent-session', '1')
    writeRaw(spawnSeq, '')
    utimesSync(spawnSeq, new Date(OLD_MS), new Date(OLD_MS))

    const report = pruneSubagentsData({
      retentionDays: 1,
      now: (): Date => RETENTION_NOW,
      root,
      agentDir,
    })

    assert.equal(readFileSync(reservation, 'utf8'), 'canonical-1')
    assert.ok(existsSync(spawnSeq))
    assert.equal(report.removed['result-ref-reservations'], undefined)
    assert.equal(report.removed['spawn-seq'], undefined)
    assert.equal(report.skipped['result-ref-reservations'], undefined)
    assert.equal(report.skipped['spawn-seq'], undefined)
  })
})

// AIDEV-NOTE (PMR-KT90): session_start auto-prune wiring — real config file +
// real data root (withIsolatedAgentEnv isolates PI_CODING_AGENT_DIR), so the
// sweep runs its default path exactly like production startup does.
describe('session_start retention auto-prune (PMR-KT90)', () => {
  interface NotifyCall {
    message: string
    level: string
  }

  function notifyingCtx() {
    const notifications: NotifyCall[] = []
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level })
        },
        setWidget() {},
        setStatus() {},
      },
    }
    return { ctx, notifications }
  }

  function seedRetiredRecord(
    agentDir: string,
    name: string,
    retiredAt: string,
  ) {
    const dir = join(agentDir, 'pi-subagents', 'retired')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify({ retiredAt }))
    return join(dir, name)
  }

  function writeRetentionConfig(projectDir: string, retentionDays: number) {
    const configDir = join(projectDir, '.pi', 'pi-subagents')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        status: { enabled: true, hideWhenIdle: true },
        retentionDays,
      }),
    )
  }

  function fireSessionStart(
    api: any,
    eventHandlers: Map<string, Array<(event: any, ctx: any) => void>>,
    ctx: Record<string, unknown>,
    projectDir: string,
  ) {
    const handlers = eventHandlers.get('session_start') ?? []
    assert.equal(handlers.length, 1)
    handlers[0](
      {},
      {
        ...ctx,
        cwd: projectDir,
        sessionManager: { getSessionId: () => 'retention-session' },
      },
    )
  }

  it('absent config: no sweep, no notify (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      const oldRecord = seedRetiredRecord(
        globalDir,
        'old.json',
        '2020-01-01T00:00:00.000Z',
      )
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()
      fireSessionStart(api, eventHandlers, ctx, projectDir)

      assert.equal(existsSync(oldRecord), true)
      assert.equal(notifications.length, 0)
    })
  })

  it('configured: sweep removes aged record, fresh record kept, ONE summary notify (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      writeRetentionConfig(projectDir, 7)
      const oldRecord = seedRetiredRecord(
        globalDir,
        'old.json',
        '2020-01-01T00:00:00.000Z',
      )
      const freshRecord = seedRetiredRecord(
        globalDir,
        'fresh.json',
        new Date().toISOString(),
      )
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()
      fireSessionStart(api, eventHandlers, ctx, projectDir)

      assert.equal(existsSync(oldRecord), false)
      assert.equal(existsSync(freshRecord), true)
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0].level, 'info')
      assert.match(notifications[0].message, /removed 1/)
    })
  })

  it('configured but nothing removed: silent (skipped-only is steady state) (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      writeRetentionConfig(projectDir, 7)
      const freshRecord = seedRetiredRecord(
        globalDir,
        'fresh.json',
        new Date().toISOString(),
      )
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()
      fireSessionStart(api, eventHandlers, ctx, projectDir)

      assert.equal(existsSync(freshRecord), true)
      assert.equal(notifications.length, 0)
    })
  })

  it('child session: no sweep at all, record kept, no notify (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      writeRetentionConfig(projectDir, 7)
      const oldRecord = seedRetiredRecord(
        globalDir,
        'old.json',
        '2020-01-01T00:00:00.000Z',
      )
      const { api, eventHandlers } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()
      // AIDEV-NOTE (PMR-KT90): simulate a subagent session — the sweep must
      // not run in children (PI_SUBAGENT_ID/SESSION child-detection
      // contract). Restore in finally: the module-level env scrub only ran
      // once at import time.
      process.env.PI_SUBAGENT_ID = 'retention-child-test'
      try {
        fireSessionStart(api, eventHandlers, ctx, projectDir)
      } finally {
        delete process.env.PI_SUBAGENT_ID
      }

      assert.equal(existsSync(oldRecord), true)
      assert.equal(notifications.length, 0)
    })
  })
})

// AIDEV-NOTE (PMR-KT90): `/subagent prune` reserved-word subcommand — fires
// the same maintenance sweep as session_start, on demand. Reserved BEFORE
// agent-name resolution, so an agent named "prune" is unreachable here.
describe('/subagent prune command (PMR-KT90)', () => {
  interface NotifyCall {
    message: string
    level: string
  }

  function notifyingCtx() {
    const notifications: NotifyCall[] = []
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level })
        },
        setWidget() {},
        setStatus() {},
      },
    }
    return { ctx, notifications }
  }

  function seedRetiredRecord(
    agentDir: string,
    name: string,
    retiredAt: string,
  ) {
    const dir = join(agentDir, 'pi-subagents', 'retired')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), JSON.stringify({ retiredAt }))
    return join(dir, name)
  }

  function writeRetentionConfig(projectDir: string, retentionDays: number) {
    const configDir = join(projectDir, '.pi', 'pi-subagents')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        status: { enabled: true, hideWhenIdle: true },
        retentionDays,
      }),
    )
  }

  function getSubagentCommand(registeredCommands: Array<any>): any {
    const command = registeredCommands.find(
      (entry: any) => entry.name === 'subagent',
    )
    assert.ok(command, '/subagent command registered')
    return command
  }

  function writeSpawnableAgent(projectAgentsDir: string, name: string) {
    writeFileSync(
      join(projectAgentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: test agent\n---\n\nDo the task.\n`,
    )
  }

  it('without config: warning notify, nothing removed from disk (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      // AIDEV-NOTE (PMR-KT90): getRetentionDays() rides a globalThis Symbol
      // cache — clear any retentionDays leaked by earlier suites.
      delete (globalThis as Record<symbol, unknown>)[
        Symbol.for('pi-subagents/retention-days')
      ]
      const oldRecord = seedRetiredRecord(
        globalDir,
        'old.json',
        '2020-01-01T00:00:00.000Z',
      )
      const { api, registeredCommands } = createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()

      await getSubagentCommand(registeredCommands).handler('prune', ctx)

      assert.equal(existsSync(oldRecord), true)
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0].level, 'warning')
      assert.equal(
        notifications[0].message,
        'retentionDays not configured; nothing to prune',
      )
    })
  })

  it('with config: sweep runs, removed/skipped summary notify (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, globalDir }) => {
      writeRetentionConfig(projectDir, 7)
      const { api, registeredCommands, eventHandlers } =
        createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()
      // AIDEV-NOTE (PMR-KT90): the prune command reads the cached config, so
      // seed it the same way production does — fire session_start first (with
      // no records present, so it prunes nothing and stays silent), then seed
      // the records the command's own sweep should act on.
      const handlers = eventHandlers.get('session_start') ?? []
      assert.equal(handlers.length, 1)
      handlers[0](
        {},
        {
          ...ctx,
          cwd: projectDir,
          sessionManager: { getSessionId: () => 'prune-command-session' },
        },
      )

      const oldRecord = seedRetiredRecord(
        globalDir,
        'old.json',
        '2020-01-01T00:00:00.000Z',
      )
      const freshRecord = seedRetiredRecord(
        globalDir,
        'fresh.json',
        new Date().toISOString(),
      )

      await getSubagentCommand(registeredCommands).handler('prune', ctx)

      assert.equal(existsSync(oldRecord), false)
      // AIDEV-NOTE (PMR-KT90): session_start's own sweep stays silent here
      // (nothing removed at that point, and skipped-only sweeps never
      // notify); the COMMAND's notify is the last one and reports the
      // removed record.
      const last = notifications[notifications.length - 1]
      assert.equal(last.level, 'info')
      assert.match(last.message, /removed 1/)
    })
  })

  it('normal spawn path unchanged: prune word-check runs BEFORE agent resolution (PMR-KT90)', async () => {
    await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
      writeSpawnableAgent(projectAgentsDir, 'worker')
      const { api, registeredCommands, sentUserMessages } =
        createMockExtensionApi()
      ;(subagentsModule as any).default(api)
      const { ctx, notifications } = notifyingCtx()

      await getSubagentCommand(registeredCommands).handler(
        'worker fix the bug',
        ctx,
      )

      assert.equal(notifications.length, 0)
      assert.equal(sentUserMessages.length, 1)
      assert.match(sentUserMessages[0], /agent: "worker"/)
      assert.match(sentUserMessages[0], /fix the bug/)

      // Unknown agent still errors the same way (resolution untouched).
      const {
        api: api2,
        registeredCommands: cmds2,
        sentUserMessages: sent2,
      } = createMockExtensionApi()
      ;(subagentsModule as any).default(api2)
      const { ctx: ctx2, notifications: notes2 } = notifyingCtx()
      await getSubagentCommand(cmds2).handler('ghost do it', ctx2)
      assert.equal(sent2.length, 0)
      assert.equal(notes2.length, 1)
      assert.equal(notes2[0].level, 'error')
      assert.match(notes2[0].message, /not found/)
      assert.ok(projectDir)
    })
  })
})
