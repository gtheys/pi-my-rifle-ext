import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { recoveryCommand } from '../flow/binding-heal.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import flowExtension, { type DurableRebindDeps } from '../index.ts'

// AIDEV-NOTE: PMR-DRKH — session_start durable rebind tests (plan 3.1).
// The derive/heal IO is injected through the DurableRebindDeps seam on the
// extension factory, mirroring how consumer deps are stubbed in flow.test.ts.

interface Notify {
  message: string
  level: string
}

type CapturedEventHandler = (event: unknown, ctx: unknown) => unknown

interface Harness {
  sent: string[]
  fireSessionStart: (ctx: {
    cwd: string
    ui: { notify: (message: string, level: string) => void }
    sessionManager: {
      getSessionFile: () => string | null
      getBranch: () => Array<{
        type: string
        customType?: string
        data?: unknown
      }>
    }
  }) => void
}

function captureExtension(durable: DurableRebindDeps): Harness {
  const events = new Map<string, CapturedEventHandler[]>()
  const sent: string[] = []
  const base = {
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: () => {},
    sendUserMessage: (message: string) => {
      sent.push(message)
    },
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    on: (event: string, handler: CapturedEventHandler) => {
      const existing = events.get(event)
      if (existing === undefined) {
        events.set(event, [handler])
      } else {
        existing.push(handler)
      }
    },
    appendEntry: () => {},
  }
  const pi = new Proxy(base, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target]
      }
      return () => {}
    },
  }) as unknown as ExtensionAPI
  flowExtension(pi, durable)
  const handlers = events.get('session_start')
  if (handlers === undefined) {
    throw new Error('session_start handler was not registered')
  }
  return {
    sent,
    fireSessionStart: (ctx) => {
      for (const handler of handlers) {
        try {
          handler(undefined, ctx)
        } catch {
          // best-effort fan-out, mirrors production capture in flow.test.ts
        }
      }
    },
  }
}

async function drainUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('drainUntil: condition not met within the 5s drain budget')
}

function sessionStartCtx(
  cwd: string,
  notifications: Notify[],
): Parameters<Harness['fireSessionStart']>[0] {
  return {
    cwd,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
    sessionManager: {
      getSessionFile: () => null,
      getBranch: () => [],
    },
  }
}

describe('session_start durable rebind (PMR-DRKH)', () => {
  let root: string
  let agentDir: string
  let previousAgentDir: string | undefined

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-flow-rebind-'))
    agentDir = join(root, 'agent')
    mkdtempSync(agentDir)
    previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
  })

  after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('single candidate restores the binding, heals, and notifies with the recovery command', async () => {
    setActiveFlowRef(null)
    let healCalls = 0
    const harness = captureExtension({
      deriveRefs: async () => ['PMR-AAAA'],
      heal: async (ref) => {
        healCalls += 1
        assert.equal(ref, 'PMR-AAAA')
        // AIDEV-NOTE: emulate the real heal mutation (setActiveFlowRef +
        // setFlowWorktree inside flow/binding-heal.ts) so the binding-change
        // persistence path is exercised.
        setActiveFlowRef(ref)
        setFlowWorktree('/tmp/wt', 'flow/PMR-AAAA')
        return {
          ok: true,
          worktree: {
            ref,
            path: '/tmp/wt',
            branch: 'flow/PMR-AAAA',
            source: 'note',
          },
          healed: true,
        }
      },
    })
    const notifications: Notify[] = []
    harness.fireSessionStart(sessionStartCtx(root, notifications))
    await drainUntil(() => healCalls > 0)
    await drainUntil(() => notifications.length > 0)
    assert.equal(getActiveFlowRef(), 'PMR-AAAA')
    const binding = getFlowWorktree()
    assert.notEqual(binding, null)
    assert.equal(binding?.ref, 'PMR-AAAA')
    const text = notifications.map((n) => n.message).join('\n')
    assert.ok(
      text.includes('/flow PMR-AAAA'),
      `expected recovery command in notify, got: ${text}`,
    )
    assert.equal(recoveryCommand('PMR-AAAA'), '/flow PMR-AAAA')
  })

  it('zero candidates does nothing: no notify, no binding change, heal never called', async () => {
    setActiveFlowRef(null)
    let healCalls = 0
    const harness = captureExtension({
      deriveRefs: async () => [],
      heal: async () => {
        healCalls += 1
        return {
          ok: true,
          worktree: { path: '/tmp/wt', branch: 'b', source: 'note' },
          healed: true,
        }
      },
    })
    const notifications: Notify[] = []
    harness.fireSessionStart(sessionStartCtx(root, notifications))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(healCalls, 0)
    // AIDEV-NOTE: only rebind-path notifications are in scope here — other
    // session_start handlers (e.g. ensureLabels) legitimately notify in
    // aven-less environments (CI), and those warnings are not this feature's
    // output. Assert the durable rebind itself stayed silent.
    const rebindNotifications = notifications.filter((n) => {
      return (
        n.message.includes('flow binding') ||
        n.message.includes('candidate flow refs') ||
        n.message.includes('/flow ')
      )
    })
    assert.deepEqual(rebindNotifications, [])
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
  })

  it('multiple candidates is notify-only listing each recovery command, no binding change', async () => {
    setActiveFlowRef(null)
    let healCalls = 0
    const harness = captureExtension({
      deriveRefs: async () => ['PMR-B1', 'PMR-B2'],
      heal: async () => {
        healCalls += 1
        return {
          ok: true,
          worktree: { path: '/tmp/wt', branch: 'b', source: 'note' },
          healed: true,
        }
      },
    })
    const notifications: Notify[] = []
    harness.fireSessionStart(sessionStartCtx(root, notifications))
    await drainUntil(() => notifications.length > 0)
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
    const text = notifications.map((n) => n.message).join('\n')
    assert.ok(text.includes('/flow PMR-B1'), text)
    assert.ok(text.includes('/flow PMR-B2'), text)
    assert.deepEqual(harness.sent, [])
  })
})
