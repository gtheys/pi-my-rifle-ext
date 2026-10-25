// Peer-to-peer messaging round trip (PMR-98S6) — file-based, NO herdr spawns.
// Two "children" are simulated: child A is the extension under test (real
// subagent-done.ts loaded with a mock pi, real presence record + inbox pump);
// child B is a fake peer with a hand-published presence record. Assertions are
// file-based (presence records, inbox files) plus the captured sendMessage.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  type ChildIdentity,
  inboxDir,
  peerLockPath,
  publishPresence,
  sendPeerMessage,
} from '../../pi-extension/subagents/peers.ts'
import subagentDone from '../../pi-extension/subagents/subagent-done.ts'

type Handler = (event: unknown, ctx: unknown) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('peer messaging round trip [file-based, no spawns]', {
  timeout: 30_000,
}, () => {
  let agentDir: string
  let sent: Array<{ message: unknown; options: unknown }> = []
  let handlers: Record<string, Handler[]> = {}
  const peer: ChildIdentity = {
    childId: 'peer-b',
    sessionFile: '/tmp/peers-it-peer-b.jsonl',
    name: 'beta',
    cwd: '/tmp',
  }
  let releasePeer: (() => void) | null = null
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // AIDEV-NOTE: structural mock of the ExtensionAPI surface subagent-done.ts
  // touches; the double assertion keeps tsc happy without maintaining the
  // full interface (which grows with pi releases).
  function makeMockPi() {
    return {
      on(name: string, handler: Handler) {
        handlers[name] = handlers[name] ?? []
        handlers[name].push(handler)
      },
      registerTool(_tool: unknown) {},
      registerShortcut(_shortcut: unknown) {},
      getAllTools() {
        return []
      },
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options })
      },
      ui: { setWidget() {}, notify() {} },
    }
  }

  before(async () => {
    agentDir = mkdtempSync(join(tmpdir(), 'peers-it-'))
    // Route the data root (getAgentDir) into the temp dir BEFORE load.
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_SUBAGENT_ID = 'peer-a'
    process.env.PI_SUBAGENT_SESSION = join(agentDir, 'peer-a.jsonl')
    process.env.PI_SUBAGENT_NAME = 'alpha'
    delete process.env.PI_SUBAGENT_AGENT
    mkdirSync(join(agentDir, 'sessions'), { recursive: true })
    releasePeer = publishPresence(peer)
    subagentDone(makeMockPi() as never)
    // session_start publishes peer A's presence and starts the pump.
    for (const handler of handlers['session_start'] ?? []) {
      handler({}, { ui: { setWidget() {} } })
    }
  })

  after(() => {
    for (const handler of handlers['session_shutdown'] ?? []) {
      handler({}, {})
    }
    if (releasePeer) releasePeer()
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
    delete process.env.PI_SUBAGENT_ID
    delete process.env.PI_SUBAGENT_SESSION
    delete process.env.PI_SUBAGENT_NAME
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('discovers the peer via presence records and drains the inbox as a turn', async () => {
    // Both presence records on disk, both backed by live process locks.
    assert.ok(existsSync(join(agentDir, 'pi-subagents/peers/peer-a.json')))
    assert.ok(existsSync(join(agentDir, 'pi-subagents/peers/peer-b.json')))
    assert.ok(existsSync(peerLockPath(peer.sessionFile)))

    // B sends to A's durable inbox.
    sendPeerMessage({
      toChildId: 'peer-a',
      from: peer,
      message: 'hello alpha',
      resultRef: 'result:findings#1',
    })
    const inbox = inboxDir('peer-a')
    assert.ok(existsSync(join(inbox, '000001.json')))

    // Pump (fs.watch or 500ms cadence) delivers WITHOUT any spawn.
    const deadline = Date.now() + 10_000
    while (sent.length === 0 && Date.now() < deadline) {
      await sleep(100)
    }
    assert.equal(sent.length, 1)
    const delivered = sent[0].message as {
      customType: string
      content: string
      details: Record<string, unknown>
    }
    assert.equal(delivered.customType, 'subagent-peer-message')
    assert.match(delivered.content, /hello alpha/)
    assert.match(delivered.content, /beta/)
    assert.equal(delivered.details.resultRef, 'result:findings#1')
    assert.equal(
      (sent[0].options as { triggerTurn: boolean }).triggerTurn,
      true,
    )

    // Inbox drained — exactly-once after successful delivery (best effort).
    assert.ok(!existsSync(join(inbox, '000001.json')))
  })
})
