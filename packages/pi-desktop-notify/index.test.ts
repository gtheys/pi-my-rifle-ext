import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildNtfyRequest,
  channelEnabled,
  type DesktopNotifyConfig,
  mergeConfig,
  notifyOnPromptEnabled,
  readConfigFile,
} from './config.ts'

describe('buildNtfyRequest', () => {
  const base = { serverUrl: 'https://ntfy.homelab.local', topic: 'pi' }

  it('posts to <serverUrl>/<topic> with title and default priority', () => {
    const req = buildNtfyRequest(base, 'pi finished — repo', 'done', {})
    expect(req.url).toBe('https://ntfy.homelab.local/pi')
    expect(req.headers.Title).toBe('pi finished — repo')
    expect(req.headers.Priority).toBe('3')
    expect(req.body).toBe('done')
    expect(req.timeoutMs).toBe(5000)
  })

  it('strips trailing slashes from serverUrl', () => {
    const cfg = { ...base, serverUrl: 'http://localhost:8099///' }
    const req = buildNtfyRequest(cfg, 't', 'b', {})
    expect(req.url).toBe('http://localhost:8099/pi')
  })

  it('maps priority, tags, and clickUrl to ntfy headers', () => {
    const cfg = {
      ...base,
      priority: 5,
      tags: ['robot', 'white_check_mark'],
      clickUrl: 'https://example.com',
      timeoutMs: 1500,
    }
    const req = buildNtfyRequest(cfg, 't', 'b', {})
    expect(req.headers.Priority).toBe('5')
    expect(req.headers.Tags).toBe('robot,white_check_mark')
    expect(req.headers.Click).toBe('https://example.com')
    expect(req.timeoutMs).toBe(1500)
  })

  it('omits Tags header for an empty tag list', () => {
    const req = buildNtfyRequest({ ...base, tags: [] }, 't', 'b', {})
    expect(req.headers.Tags).toBeUndefined()
  })

  it('sends the config token as a bearer Authorization header', () => {
    const cfg = { ...base, token: 'cfg-token' }
    const req = buildNtfyRequest(cfg, 't', 'b', {})
    expect(req.headers.Authorization).toBe('Bearer cfg-token')
  })

  it('PI_NTFY_TOKEN env wins over the config token', () => {
    const cfg = { ...base, token: 'cfg-token' }
    const req = buildNtfyRequest(cfg, 't', 'b', { PI_NTFY_TOKEN: 'env-token' })
    expect(req.headers.Authorization).toBe('Bearer env-token')
  })

  it('omits Authorization when no token is configured', () => {
    const req = buildNtfyRequest(base, 't', 'b', {})
    expect(req.headers.Authorization).toBeUndefined()
  })
})

describe('mergeConfig', () => {
  it('merges ntfy section without dropping global desktop settings', () => {
    const global: DesktopNotifyConfig = {
      desktop: { enabled: false },
      ntfy: { serverUrl: 'https://a', topic: 't', priority: 4 },
    }
    const project: DesktopNotifyConfig = {
      ntfy: { serverUrl: 'https://b', topic: 't' },
    }
    const merged = mergeConfig(global, project)
    expect(merged.desktop).toEqual({ enabled: false })
    expect(merged.ntfy?.serverUrl).toBe('https://b')
    // project layer does not set priority — global value survives the merge
    expect(merged.ntfy?.priority).toBe(4)
  })

  it('keeps top-level scalars from the override', () => {
    const merged = mergeConfig(
      { notifyOnPrompt: true },
      { notifyOnPrompt: false },
    )
    expect(merged.notifyOnPrompt).toBe(false)
  })
})

describe('channelEnabled', () => {
  it('desktop and herdr default to enabled', () => {
    expect(channelEnabled({}, 'desktop')).toBe(true)
    expect(channelEnabled({}, 'herdr')).toBe(true)
  })

  it('ntfy requires the section to be present', () => {
    expect(channelEnabled({}, 'ntfy')).toBe(false)
  })

  it('ntfy section enables the channel; enabled:false disables it', () => {
    const on: DesktopNotifyConfig = {
      ntfy: { serverUrl: 'https://a', topic: 't' },
    }
    expect(channelEnabled(on, 'ntfy')).toBe(true)
    const off: DesktopNotifyConfig = {
      ntfy: { serverUrl: 'https://a', topic: 't', enabled: false },
    }
    expect(channelEnabled(off, 'ntfy')).toBe(false)
  })

  it('notifyOnPromptEnabled defaults to true', () => {
    expect(notifyOnPromptEnabled({})).toBe(true)
    expect(notifyOnPromptEnabled({ notifyOnPrompt: false })).toBe(false)
  })
})

describe('readConfigFile', () => {
  it('returns {} for a missing file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pdn-cfg-'))
    try {
      expect(await readConfigFile(path.join(dir, 'nope.json'))).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parses a valid config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pdn-cfg-'))
    try {
      const file = path.join(dir, 'config.json')
      await writeFile(
        file,
        JSON.stringify({
          ntfy: {
            serverUrl: 'https://ntfy.local',
            topic: 'pi',
            priority: 4,
            tags: ['robot'],
          },
        }),
      )
      const cfg = await readConfigFile(file)
      expect(cfg.ntfy?.topic).toBe('pi')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws a clear error on an invalid config (never silent defaults)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pdn-cfg-'))
    try {
      const file = path.join(dir, 'config.json')
      await writeFile(
        file,
        JSON.stringify({
          ntfy: { serverUrl: 'https://ntfy.local', priority: 9 },
        }),
      )
      await expect(readConfigFile(file)).rejects.toThrow(/invalid/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws on malformed JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pdn-cfg-'))
    try {
      const file = path.join(dir, 'config.json')
      await writeFile(file, '{ not json')
      await expect(readConfigFile(file)).rejects.toThrow(/not valid JSON/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
