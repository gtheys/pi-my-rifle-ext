// AIDEV-NOTE: PMR-2FJ1 — session_start's stale-daemon probe is gated on the
// runServer.enabled kill switch. Before the gate a session with
// {"runServer":{"enabled":false}} never spawns or uses the daemon yet was told
// to restart it at every session start, because a same-repo-spawned daemon was
// alive with an old SHA. These pins drive the REAL session_start handler against
// a live pidfile (pid = this process, current protocol version) plus a stubbed
// git that reports a NEWER main HEAD, so the only variable is the config bit.
// Other session_start hooks (ensureLabels, aven prefix discovery, the durable
// rebind scan) legitimately notify in an aven-less CI environment, so the
// assertions filter on the staleness message text only — the same posture as
// rebindNotifications() in test/session-start-durable-rebind.test.ts.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import flowExtension from '../index.ts'
import { SERVER_PROTOCOL_VERSION } from '../server/daemon.ts'
import { pidFilePath } from '../server/lifecycle.ts'

// 40-hex SHAs (the resolver rejects anything else). The pidfile carries the
// OLD one, the stubbed git reports NEW_MAIN as the main checkout HEAD, so the
// verdict is 'stale' — the only shape that warns with a repo-identical daemon.
const DAEMON_SHA = 'a'.repeat(40)
const NEW_MAIN_SHA = 'b'.repeat(40)

const STALENESS_MESSAGES = [
  'daemon is running stale code',
  'daemon predates staleness tracking',
]

type CapturedEventHandler = (event: unknown, ctx: unknown) => unknown

/** Fire session_start through the extension's own registration. Every other
 *  pi surface is a no-op, like the harness in session-start-durable-rebind. */
function captureSessionStart(
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string },
  ) => Promise<{ stdout: string; stderr: string; code: number }>,
): (ctx: unknown) => void {
  const handlers: CapturedEventHandler[] = []
  const base = {
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: () => {},
    sendUserMessage: () => {},
    exec,
    on: (event: string, handler: CapturedEventHandler) => {
      if (event === 'session_start') {
        handlers.push(handler)
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
  flowExtension(pi)
  return (ctx) => {
    for (const handler of handlers) {
      try {
        handler(undefined, ctx)
      } catch {
        // best-effort fan-out, mirrors production
      }
    }
  }
}

describe('session_start stale-daemon gate (PMR-2FJ1)', () => {
  let root: string
  let agentDir: string
  let previousAgentDir: string | undefined

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-flow-stalgate-'))
    agentDir = join(root, 'agent')
    mkdirSync(join(agentDir, 'pi-flow'), { recursive: true })
    previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    // A live daemon (this very process) spawned from an OLD main HEAD.
    writeFileSync(
      pidFilePath(agentDir),
      JSON.stringify({
        pid: process.pid,
        version: SERVER_PROTOCOL_VERSION,
        gitSha: DAEMON_SHA,
        gitRoot: root,
      }),
    )
  })

  after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** A session whose main checkout is `root` at NEW_MAIN_SHA: the pidfile's
   *  repo identity matches, its SHA does not → stale. */
  const execStub = async (
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    const argv = args.join(' ')
    if (command === 'git' && argv === 'worktree list --porcelain') {
      return {
        stdout: `worktree ${root}\nHEAD ${NEW_MAIN_SHA}\n\n`,
        stderr: '',
        code: 0,
      }
    }
    return { stdout: `${root}\n`, stderr: '', code: 0 }
  }

  function stalenessNotifications(messages: string[]): string[] {
    return messages.filter((message) => {
      return STALENESS_MESSAGES.some((needle) => message.includes(needle))
    })
  }

  /** Drive one session_start against a project config carrying the kill switch. */
  async function run(enabled: boolean | undefined): Promise<string[]> {
    const ws = mkdtempSync(join(root, 'ws-'))
    mkdirSync(join(ws, '.pi', 'pi-flow'), { recursive: true })
    const config: Record<string, unknown> = { workRoots: [] }
    if (enabled !== undefined) {
      config.runServer = { enabled }
    }
    writeFileSync(
      join(ws, '.pi', 'pi-flow', 'config.json'),
      JSON.stringify(config),
    )
    const messages: string[] = []
    const fire = captureSessionStart(execStub)
    fire({
      cwd: ws,
      hasUI: true,
      ui: {
        notify: (message: string) => {
          messages.push(message)
        },
        select: async () => undefined,
      },
      sessionManager: {
        getSessionFile: () => null,
        getBranch: () => [],
      },
    })
    // The gate awaits loadConfig before the probe, so the warning lands one
    // (async) hop later than the ungated version — drain for it.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (stalenessNotifications(messages).length > 0) {
        break
      }
    }
    // Give a would-be duplicate a chance to show up before asserting once.
    await new Promise((resolve) => setTimeout(resolve, 150))
    rmSync(ws, { recursive: true, force: true })
    return stalenessNotifications(messages)
  }

  it('runServer.enabled=false: the stale-daemon probe stays silent', async () => {
    const warned = await run(false)
    assert.deepEqual(
      warned,
      [],
      'a repo that disabled the run server must not be told to restart its daemon',
    )
  })

  it('runServer.enabled=true: the probe still warns (the gate does not swallow it)', async () => {
    const warned = await run(true)
    assert.equal(
      warned.length,
      1,
      `expected exactly one staleness warning, got: ${String(warned)}`,
    )
    assert.ok(
      warned[0]?.includes('daemon is running stale code'),
      String(warned[0]),
    )
  })

  it('no kill switch in the config (enabled default): the probe warns', async () => {
    const warned = await run(undefined)
    assert.equal(
      warned.length,
      1,
      `expected exactly one staleness warning, got: ${String(warned)}`,
    )
  })
})
