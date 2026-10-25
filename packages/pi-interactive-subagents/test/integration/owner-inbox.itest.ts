// Owner messaging round trip (PMR-QCVA) — file-based, NO herdr spawns.
// A "child" runs the real subagent-done.ts under a mock pi; message_owner
// writes a durable record into the parent's inbox and returns immediately.
// The parent side (drain + coalesce + exactly-once delete) is exercised via
// the same inbox module the 1s status loop calls. Mirrors peers.test.ts.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  coalesceOwnerMessages,
  OWNER_MESSAGE_MAX_BYTES,
  readOwnerInbox,
  removeOwnerMessage,
} from '../../pi-extension/subagents/inbox.ts'
import subagentDone from '../../pi-extension/subagents/subagent-done.ts'

type Handler = (event: unknown, ctx: unknown) => void

describe('owner messaging round trip [file-based, no spawns]', {
  timeout: 30_000,
}, () => {
  const PARENT_SESSION = 'it-parent-session'
  let agentDir: string
  let handlers: Record<string, Handler[]> = {}
  let messageOwnerTool: {
    execute: (
      id: string,
      params: { message: string },
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details: unknown }>
  } | null = null
  const prev: Record<string, string | undefined> = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENT_ID: process.env.PI_SUBAGENT_ID,
    PI_SUBAGENT_SESSION: process.env.PI_SUBAGENT_SESSION,
    PI_SUBAGENT_NAME: process.env.PI_SUBAGENT_NAME,
    PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
  }

  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'owner-inbox-it-'))
    // Route the data root (getAgentDir) into the temp dir BEFORE load.
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_SUBAGENT_ID = 'owner-child'
    process.env.PI_SUBAGENT_SESSION = join(agentDir, 'owner-child.jsonl')
    process.env.PI_SUBAGENT_NAME = 'sender'
    process.env.PI_SUBAGENT_PARENT_SESSION = PARENT_SESSION
    const tools: Record<string, unknown> = {}
    // AIDEV-NOTE: peers.test.ts makes the same trade — a structural mock cast
    // to the ExtensionAPI surface; only the members subagent-done.ts uses exist.
    const mockPi = {
      on(name: string, handler: Handler) {
        handlers[name] = handlers[name] ?? []
        handlers[name].push(handler)
      },
      registerTool(tool: { name: string }) {
        tools[tool.name] = tool
      },
      registerShortcut(_shortcut: unknown) {},
      getAllTools() {
        return []
      },
      sendMessage(_message: unknown, _options: unknown) {},
      ui: { setWidget() {}, notify() {} },
    } as unknown as Parameters<typeof subagentDone>[0]
    subagentDone(mockPi)
    for (const handler of handlers['session_start'] ?? []) {
      handler({}, { ui: { setWidget() {} } })
    }
    messageOwnerTool = tools['message_owner'] as typeof messageOwnerTool
  })

  after(() => {
    for (const handler of handlers['session_shutdown'] ?? []) {
      handler({}, {})
    }
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('tool is registered, writes a durable record and returns immediately', async () => {
    assert.ok(messageOwnerTool)
    const result = await messageOwnerTool.execute(
      'call-1',
      { message: 'progress: found the bug\ninvestigating further' },
      undefined,
      undefined,
      {},
    )
    // Immediate return: no shutdown, no exit marker — the child keeps working.
    assert.match(result.content[0].text, /Keep working/)
    const entries = readOwnerInbox(PARENT_SESSION)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].message.childId, 'owner-child')
    assert.equal(entries[0].message.name, 'sender')
    assert.match(entries[0].message.message, /found the bug/)
  })

  it('parent drain coalesces and deletes each record exactly once', async () => {
    await messageOwnerTool?.execute(
      'call-2',
      { message: 'second update' },
      undefined,
      undefined,
      {},
    )
    const entries = readOwnerInbox(PARENT_SESSION)
    assert.equal(entries.length, 2)
    const coalesced = coalesceOwnerMessages(entries, 4)
    assert.equal(coalesced.lines.length, 2)
    assert.deepEqual(coalesced.visibleLines, [
      'sender: progress: found the bug',
      'sender: second update',
    ])
    assert.equal(coalesced.overflow, 0)
    // Drain exactly once — second drain reads empty.
    for (const entry of entries) removeOwnerMessage(entry.path)
    assert.equal(readOwnerInbox(PARENT_SESSION).length, 0)
  })

  it('enforces the 8 KiB cap', async () => {
    const tool = messageOwnerTool as NonNullable<typeof messageOwnerTool>
    await assert.rejects(
      tool.execute(
        'call-3',
        { message: 'x'.repeat(OWNER_MESSAGE_MAX_BYTES) },
        undefined,
        undefined,
        {},
      ),
      /cap/,
    )
    assert.ok(!existsSync(join(agentDir, 'pi-subagents/inbox/nope')))
  })
})
