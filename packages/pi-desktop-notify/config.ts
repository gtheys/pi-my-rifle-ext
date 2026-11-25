// AIDEV-NOTE: TypeBox schema is the source of truth for config shape;
// config.schema.json (checked in) mirrors it. Boundary parsing: JSON.parse ->
// unknown -> Value.Check -> typed. A present-but-malformed config throws a
// clear error — never silent defaults (AGENTS.md rule).
// Global path: getAgentDir()/pi-desktop-notify/config.json.
// Project override: <cwd>/CONFIG_DIR_NAME/pi-desktop-notify/config.json wins.
// The ntfy token may also come from the PI_NTFY_TOKEN env var, which wins
// over the config value (secrets belong in env).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

export const DesktopNotifyConfigSchema = Type.Object({
  desktop: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            'Send notify-send desktop notifications. Default true (master /notify toggle still applies on top)',
        }),
      ),
    }),
  ),
  herdr: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            'Mirror notifications into herdr when running inside a herdr session (HERDR_ENV=1). Default true',
        }),
      ),
      sound: Type.Optional(
        Type.String({
          description: 'herdr notification sound name (default "done")',
        }),
      ),
    }),
  ),
  ntfy: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            'Send ntfy push notifications to your homelab server. Default true when this section is present',
        }),
      ),
      serverUrl: Type.String({
        description:
          'Base URL of the ntfy server, e.g. https://ntfy.homelab.local (no trailing slash needed)',
      }),
      topic: Type.String({
        description:
          'ntfy topic to publish to, e.g. "pi-notifications" (secret topics are fine)',
      }),
      token: Type.Optional(
        Type.String({
          description:
            'Bearer token for ntfy access control. Prefer the PI_NTFY_TOKEN env var for secrets — the env var wins when both are set',
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 5,
          description:
            'ntfy message priority 1-5 (default 3 = high; 5 = max priority with persistent notification)',
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Emoji tags for the message, e.g. ["robot", "white_check_mark"] (names or raw emoji)',
        }),
      ),
      clickUrl: Type.Optional(
        Type.String({
          description: 'URL opened when the notification is tapped (optional)',
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 250,
          maximum: 30_000,
          description:
            'HTTP timeout for the ntfy publish request (default 5000 ms)',
        }),
      ),
    }),
  ),
  notifyOnPrompt: Type.Optional(
    Type.Boolean({
      description:
        'Also notify (all enabled channels, ignoring the idle threshold) when Pi shows a blocking user prompt — select/confirm/input/editor/custom via ui_prompt_start. Default true',
    }),
  ),
})

export type DesktopNotifyConfig = Static<typeof DesktopNotifyConfigSchema>
export type NtfyConfig = NonNullable<DesktopNotifyConfig['ntfy']>

export const DEFAULT_NTFY_PRIORITY = 3
export const DEFAULT_NTFY_TIMEOUT_MS = 5000
export const DEFAULT_HERDR_SOUND = 'done'

export async function readConfigFile(
  file: string,
): Promise<DesktopNotifyConfig> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-desktop-notify config ${file}: ${msg}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(
      `pi-desktop-notify config ${file} is not valid JSON: ${msg}`,
    )
  }
  if (!Value.Check(DesktopNotifyConfigSchema, parsed)) {
    const errors = Value.Errors(DesktopNotifyConfigSchema, parsed)
      .map((e) => {
        let text = e.message
        if (e.instancePath !== '/') text = `${e.instancePath}: ${text}`
        return text
      })
      .join('; ')
    throw new Error(`pi-desktop-notify config ${file} is invalid: ${errors}`)
  }
  return parsed as DesktopNotifyConfig
}

/**
 * Shallow merge of two configs with per-section merging so a project override
 * that only sets `ntfy` does not drop the global `desktop`/`herdr` sections.
 */
export function mergeConfig(
  base: DesktopNotifyConfig,
  override: DesktopNotifyConfig,
): DesktopNotifyConfig {
  const merged: DesktopNotifyConfig = { ...base, ...override }
  if (base.desktop || override.desktop) {
    merged.desktop = { ...base.desktop, ...override.desktop }
  }
  if (base.herdr || override.herdr) {
    merged.herdr = { ...base.herdr, ...override.herdr }
  }
  if (base.ntfy !== undefined && override.ntfy !== undefined) {
    // Both layers carry the required serverUrl/topic, so the spread keeps the
    // required keys typed.
    merged.ntfy = { ...base.ntfy, ...override.ntfy }
  } else if (override.ntfy !== undefined) {
    merged.ntfy = override.ntfy
  } else if (base.ntfy !== undefined) {
    merged.ntfy = base.ntfy
  }
  return merged
}

export async function loadConfig(cwd: string): Promise<DesktopNotifyConfig> {
  const globalPath = path.join(
    getAgentDir(),
    'pi-desktop-notify',
    'config.json',
  )
  const projectPath = path.join(
    cwd,
    CONFIG_DIR_NAME,
    'pi-desktop-notify',
    'config.json',
  )
  const global = await readConfigFile(globalPath)
  const project = await readConfigFile(projectPath)
  return mergeConfig(global, project)
}

export function channelEnabled(
  config: DesktopNotifyConfig,
  channel: 'desktop' | 'herdr' | 'ntfy',
): boolean {
  if (channel === 'desktop') return config.desktop?.enabled !== false
  if (channel === 'herdr') return config.herdr?.enabled !== false
  if (config.ntfy === undefined) return false
  if (config.ntfy.enabled === false) return false
  return true
}

export function ntfyActive(config: DesktopNotifyConfig): boolean {
  return channelEnabled(config, 'ntfy')
}

export function notifyOnPromptEnabled(config: DesktopNotifyConfig): boolean {
  return config.notifyOnPrompt !== false
}

export interface NtfyRequest {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
}

/**
 * Build the ntfy publish request (pure, tested): POST <serverUrl>/<topic>
 * with Title/Priority/Tags/Click headers and the message as plain-text body.
 */
export function buildNtfyRequest(
  ntfy: NtfyConfig,
  title: string,
  message: string,
  env: Record<string, string | undefined> = process.env,
): NtfyRequest {
  const server = ntfy.serverUrl.replace(/\/+$/, '')
  const url = `${server}/${ntfy.topic}`

  let priority = DEFAULT_NTFY_PRIORITY
  if (ntfy.priority !== undefined) priority = ntfy.priority

  let timeoutMs = DEFAULT_NTFY_TIMEOUT_MS
  if (ntfy.timeoutMs !== undefined) timeoutMs = ntfy.timeoutMs

  const headers: Record<string, string> = {
    Title: title,
    Priority: String(priority),
  }
  if (ntfy.tags && ntfy.tags.length > 0) {
    headers.Tags = ntfy.tags.join(',')
  }
  if (ntfy.clickUrl !== undefined) {
    headers.Click = ntfy.clickUrl
  }
  // PI_NTFY_TOKEN env wins over the config token (secrets belong in env).
  let token = env.PI_NTFY_TOKEN
  if (token === undefined) token = ntfy.token
  if (token !== undefined && token !== '') {
    headers.Authorization = `Bearer ${token}`
  }

  return { url, headers, body: message, timeoutMs }
}
