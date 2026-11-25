// AIDEV-NOTE: PMR-ZV9Y 5.1 — tests for the extracted dispatch surface
// (notify.ts). Mirrors index.test.ts (bun:test, co-located at package root).
// The channel transports are faked, never run for real:
//  - `node:child_process` is replaced with mock.module BEFORE notify.ts is
//    imported (notify.ts binds promisify(execFile) at module load, so the
//    mock must be in place first — hence the dynamic import below).
//  - `globalThis.fetch` is swapped per test (repo precedent:
//    pi-flow/test/pr-quality.test.ts, sonarqube.test.ts).
//  - HERDR_ENV is saved/restored around each herdr-gating case because the
//    herdr channel is gated on the environment, not only on config.
import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopNotifyConfig } from './config.ts'

interface ExecCall {
  cmd: string
  args: string[]
}

const execCalls: ExecCall[] = []
let failingCommands = new Set<string>()

mock.module('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    execCalls.push({ cmd, args })
    if (failingCommands.has(cmd)) {
      callback(new Error(`mock failure: ${cmd}`))
      return
    }
    callback(null, '', '')
  },
}))

const notify = await import('./notify.ts')
const { dispatchNotification, loadConfig } = notify

interface FetchCall {
  url: string
  init: RequestInit
}

const fetchCalls: FetchCall[] = []
let fetchShouldFail = false

function withFetch(run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    if (fetchShouldFail) throw new Error('mock ntfy unreachable')
    return new Response('ok', { status: 200 })
  }) as typeof fetch
  return run().finally(() => {
    globalThis.fetch = original
  })
}

function withHerdrEnv(value: string | undefined, run: () => Promise<void>) {
  const original = process.env.HERDR_ENV
  if (value === undefined) delete process.env.HERDR_ENV
  else process.env.HERDR_ENV = value
  return run().finally(() => {
    if (original === undefined) delete process.env.HERDR_ENV
    else process.env.HERDR_ENV = original
  })
}

const NTFY: NonNullable<DesktopNotifyConfig['ntfy']> = {
  serverUrl: 'https://ntfy.homelab.local',
  topic: 'pi-flow',
}

function reset() {
  execCalls.length = 0
  fetchCalls.length = 0
  failingCommands = new Set<string>()
  fetchShouldFail = false
}

function commandsRun(): string[] {
  return execCalls.map((c) => c.cmd)
}

/** Fetch calls are always asserted inside the stub, so an index must exist. */
function ntfyCall(index: number): FetchCall {
  const call = fetchCalls[index]
  if (call === undefined) throw new Error(`no fetch call recorded at ${index}`)
  return call
}

describe('dispatchNotification — channel toggles', () => {
  it('empty config runs desktop only (herdr needs HERDR_ENV, ntfy needs a section)', async () => {
    reset()
    await withHerdrEnv(undefined, async () => {
      await withFetch(async () => {
        await dispatchNotification({}, 'summary', 'body')
      })
    })
    expect(commandsRun()).toEqual(['notify-send'])
    expect(fetchCalls).toHaveLength(0)
  })

  it('desktop: false skips notify-send', async () => {
    reset()
    await withHerdrEnv(undefined, async () => {
      await dispatchNotification({ desktop: { enabled: false } }, 's', 'b')
    })
    expect(commandsRun()).toEqual([])
  })

  it('herdr: inside a herdr session (HERDR_ENV=1) it mirrors the desktop call', async () => {
    reset()
    await withHerdrEnv('1', async () => {
      await dispatchNotification({}, 'pi finished — repo', 'the body')
    })
    expect(commandsRun()).toEqual(['notify-send', 'herdr'])
    expect(execCalls[1]?.args).toEqual([
      'notification',
      'show',
      'pi finished — repo',
      '--body',
      'the body',
      '--sound',
      'done',
    ])
  })

  it('herdr: config sound wins over the default', async () => {
    reset()
    await withHerdrEnv('1', async () => {
      await dispatchNotification({ herdr: { sound: 'ping' } }, 's', 'b')
    })
    expect(execCalls[1]?.args).toContain('ping')
  })

  it('herdr: false disables the channel even inside a herdr session', async () => {
    reset()
    await withHerdrEnv('1', async () => {
      await dispatchNotification({ herdr: { enabled: false } }, 's', 'b')
    })
    expect(commandsRun()).toEqual(['notify-send'])
  })

  it('ntfy: present section publishes; enabled: false does not', async () => {
    // Both halves run inside the fetch stub: a regression that wrongly enables
    // the channel can never reach the network from a test.
    reset()
    await withHerdrEnv(undefined, async () => {
      await withFetch(async () => {
        await dispatchNotification({ ntfy: NTFY }, 'title', 'message')
        expect(fetchCalls).toHaveLength(1)
        const first = ntfyCall(0)
        expect(first.url).toBe('https://ntfy.homelab.local/pi-flow')
        expect(first.init.method).toBe('POST')
        expect(first.init.body).toBe('message')
        const headers = first.init.headers as Record<string, string>
        expect(headers.Title).toBe('title')
        expect(headers.Priority).toBe('3')

        reset()
        await dispatchNotification(
          { ntfy: { ...NTFY, enabled: false } },
          't',
          'm',
        )
      })
    })
    expect(fetchCalls).toHaveLength(0)
  })

  it('all channels off produces no transport calls at all', async () => {
    reset()
    await withHerdrEnv('1', async () => {
      await withFetch(async () => {
        await dispatchNotification(
          {
            desktop: { enabled: false },
            herdr: { enabled: false },
            ntfy: { ...NTFY, enabled: false },
          },
          's',
          'b',
        )
      })
    })
    expect(execCalls).toHaveLength(0)
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('dispatchNotification — best-effort per channel', () => {
  it('a failing notify-send does not prevent herdr and ntfy attempts', async () => {
    reset()
    failingCommands = new Set(['notify-send'])
    await withHerdrEnv('1', async () => {
      await withFetch(async () => {
        await dispatchNotification({ ntfy: NTFY }, 's', 'b')
      })
    })
    expect(commandsRun()).toEqual(['notify-send', 'herdr'])
    expect(fetchCalls).toHaveLength(1)
  })

  it('a failing herdr call does not prevent the ntfy attempt', async () => {
    reset()
    failingCommands = new Set(['herdr'])
    await withHerdrEnv('1', async () => {
      await withFetch(async () => {
        await dispatchNotification({ ntfy: NTFY }, 's', 'b')
      })
    })
    expect(commandsRun()).toEqual(['notify-send', 'herdr'])
    expect(fetchCalls).toHaveLength(1)
  })

  it('an unreachable ntfy server never rejects the call', async () => {
    reset()
    fetchShouldFail = true
    await withHerdrEnv(undefined, async () => {
      await withFetch(async () => {
        await dispatchNotification({ ntfy: NTFY }, 's', 'b')
      })
    })
    expect(fetchCalls).toHaveLength(1)
  })
})

describe('notify.ts exported surface (what PMR-ZV9Y 5.2 consumes)', () => {
  it('exposes dispatchNotification and the config loader', () => {
    expect(typeof dispatchNotification).toBe('function')
    expect(typeof loadConfig).toBe('function')
    expect(dispatchNotification.length).toBe(3)
  })

  // AIDEV-NOTE: the bar here is the relaxed PMR-ZV9Y 5.1 criterion (i):
  // notify.ts must not DIRECTLY import the pi runtime. loadConfig lives in
  // config.ts, which value-imports @earendil-works/pi-coding-agent for
  // getAgentDir/CONFIG_DIR_NAME, so the subpath pulls it transitively — the
  // only consumer (pi-flow) runs inside a pi session, so that is accepted.
  // The daemon-style closure rule of PMR-8MQH does NOT apply to this path;
  // this guard only stops a regression that adds a direct pi import.
  it('does not directly import the pi runtime or the extension index', () => {
    const here = resolve(dirname(fileURLToPath(import.meta.url)))
    const source = readFileSync(join(here, 'notify.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const specifiers: string[] = []
    for (const pattern of [
      /from\s*['"]([^'"]+)['"]/g,
      /^\s*import\s+['"]([^'"]+)['"]/gm,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ]) {
      let match = pattern.exec(source)
      while (match) {
        specifiers.push(match[1])
        match = pattern.exec(source)
      }
    }
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith('node:') || specifier === './config.ts'
      expect({ specifier, allowed }).toEqual({ specifier, allowed: true })
    }
  })
})
