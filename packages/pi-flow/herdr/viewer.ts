// AIDEV-NOTE: Herdr adapter for the flow run-state viewer (ported from
// pi-workflows' herdr-viewer design). Uses ONLY public herdr CLI verbs
// through pi.exec with bounded timeouts and bounded JSON parsing. No polling,
// no daemon, no state file — dedupe keys off the pane LABEL ("flow · <ref>"),
// which survives Pi reloads because it lives in herdr's own snapshot.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { runStatePath } from '../run-state.ts'

export const HERDR_PLUGIN_ID = 'gtheys.pi-my-rifle-ext'
export const HERDR_PLUGIN_ENTRYPOINT = 'flow'
export const VIEWER_LABEL_PREFIX = 'flow · '

const COMMAND_TIMEOUT_MS = 5_000
const MAX_JSON_CHARS = 1_000_000

export const VIEWER_PLACEMENTS = [
  'right',
  'below',
  'left',
  'above',
  'tab',
] as const

export type ViewerPlacement = (typeof VIEWER_PLACEMENTS)[number]

export type HerdrCapability =
  | { available: true }
  | { available: false; reason: string }

export type ViewerOpenResult = { paneId: string; reused: boolean }

type Exec = ExtensionAPI['exec']

type HerdrPane = {
  paneId: string
  tabId: string
  workspaceId: string
  label?: string
}

export function parseViewerPlacement(
  value: string,
): ViewerPlacement | undefined {
  return VIEWER_PLACEMENTS.find((placement) => placement === value)
}

export function viewerPaneLabel(ref: string): string {
  return `${VIEWER_LABEL_PREFIX}${ref}`
}

/** Strict ref charset — the same rule as runFileName, enforced at the boundary. */
export function isValidRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ref)
}

export class FlowHerdrViewer {
  private readonly knownPanes = new Map<string, string>()
  private readonly opening = new Map<string, Promise<ViewerOpenResult>>()
  private readonly exec: Exec
  private readonly env: NodeJS.ProcessEnv

  // AIDEV-NOTE: no constructor parameter properties — Node's strip-only TS
  // mode (the repo test runner) rejects them.
  constructor(exec: Exec, env: NodeJS.ProcessEnv = process.env) {
    this.exec = exec
    this.env = env
  }

  async probe(): Promise<HerdrCapability> {
    if (this.env.HERDR_ENV !== '1') {
      return { available: false, reason: 'Pi is not running in Herdr.' }
    }
    try {
      await this.currentPane()
    } catch (error) {
      return { available: false, reason: errorMessage(error) }
    }
    return { available: true }
  }

  async open(
    ref: string,
    placement: ViewerPlacement,
  ): Promise<ViewerOpenResult> {
    const pending = this.opening.get(ref)
    if (pending !== undefined) return await pending

    const opening = this.openOnce(ref, placement).finally(() => {
      if (this.opening.get(ref) === opening) this.opening.delete(ref)
    })
    this.opening.set(ref, opening)
    return await opening
  }

  private async openOnce(
    ref: string,
    placement: ViewerPlacement,
  ): Promise<ViewerOpenResult> {
    const existing = await this.findAndFocus(ref)
    if (existing !== undefined) {
      return { paneId: existing, reused: true }
    }
    const caller = await this.currentPane()
    const runFile = runStatePath(getAgentDir(), ref)
    if (runFile === null) {
      throw new Error(`Invalid flow ref: ${ref}`)
    }
    const args = [
      'plugin',
      'pane',
      'open',
      '--plugin',
      HERDR_PLUGIN_ID,
      '--entrypoint',
      HERDR_PLUGIN_ENTRYPOINT,
      '--env',
      `PI_FLOW_REF=${ref}`,
      '--env',
      `PI_FLOW_RUN_FILE=${runFile}`,
      '--focus',
    ]
    if (placement === 'tab') {
      args.push('--placement', 'tab', '--workspace', caller.workspaceId)
    } else {
      args.push(
        '--placement',
        'split',
        '--target-pane',
        caller.paneId,
        '--direction',
        placement === 'below' || placement === 'above' ? 'down' : 'right',
      )
    }
    const opened = parseOpenedPane(await this.runJson('herdr', args))
    if (placement === 'left' || placement === 'above') {
      try {
        await this.run('herdr', [
          'pane',
          'swap',
          '--source-pane',
          opened.paneId,
          '--target-pane',
          caller.paneId,
        ])
      } catch (error) {
        await this.run('herdr', [
          'plugin',
          'pane',
          'close',
          opened.paneId,
        ]).catch(() => undefined)
        throw error
      }
    }
    this.knownPanes.set(ref, opened.paneId)
    return { paneId: opened.paneId, reused: false }
  }

  private async findAndFocus(ref: string): Promise<string | undefined> {
    const knownPaneId = this.knownPanes.get(ref)
    if (knownPaneId !== undefined) {
      try {
        await this.run('herdr', ['plugin', 'pane', 'focus', knownPaneId])
        return knownPaneId
      } catch {
        this.knownPanes.delete(ref)
      }
    }
    const existing = await this.find(ref)
    if (existing === undefined) return undefined
    try {
      await this.run('herdr', ['plugin', 'pane', 'focus', existing.paneId])
      this.knownPanes.set(ref, existing.paneId)
      return existing.paneId
    } catch {
      // The pane can close between the snapshot and the focus request.
      return undefined
    }
  }

  async find(ref: string): Promise<HerdrPane | undefined> {
    const snapshot = await this.runJson('herdr', ['api', 'snapshot'])
    return snapshotPanes(snapshot).find(
      (pane) => pane.label === viewerPaneLabel(ref),
    )
  }

  private async currentPane(): Promise<HerdrPane> {
    return parseCurrentPane(
      await this.runJson('herdr', ['pane', 'current', '--current']),
    )
  }

  private async run(command: string, args: string[]): Promise<string> {
    const result = await this.exec(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      const message =
        result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      throw new Error(`${command} failed: ${boundedText(message)}`)
    }
    return result.stdout
  }

  private async runJson(command: string, args: string[]): Promise<unknown> {
    const stdout = await this.run(command, args)
    if (stdout.length > MAX_JSON_CHARS) {
      throw new Error(`${command} returned too much data.`)
    }
    try {
      return JSON.parse(stdout) as unknown
    } catch {
      throw new Error(`${command} returned invalid JSON.`)
    }
  }
}

// ── pure parsers, exported for tests ──

export function parseCurrentPane(value: unknown): HerdrPane {
  const result = requiredRecord(value, 'result', 'Herdr pane response')
  return paneFromValue(requiredRecord(result, 'pane', 'Herdr pane response'))
}

export function parseOpenedPane(value: unknown): { paneId: string } {
  const result = requiredRecord(value, 'result', 'Herdr plugin pane response')
  const pluginPane = requiredRecord(
    result,
    'plugin_pane',
    'Herdr plugin pane response',
  )
  const pane = paneFromValue(
    requiredRecord(pluginPane, 'pane', 'Herdr plugin pane response'),
  )
  return { paneId: pane.paneId }
}

export function snapshotPanes(value: unknown): HerdrPane[] {
  const result = requiredRecord(value, 'result', 'Herdr snapshot')
  const snapshot = requiredRecord(result, 'snapshot', 'Herdr snapshot')
  const panes = arrayValue(snapshot, 'panes')
  if (panes === undefined) throw new Error('Herdr snapshot has no panes.')
  return panes.flatMap((pane) => {
    try {
      return [paneFromValue(pane)]
    } catch {
      return []
    }
  })
}

function paneFromValue(value: unknown): HerdrPane {
  if (!isRecord(value)) throw new Error('Herdr returned an invalid pane.')
  const label = value.label
  return {
    paneId: requiredString(value, 'pane_id', 'Herdr pane'),
    tabId: requiredString(value, 'tab_id', 'Herdr pane'),
    workspaceId: requiredString(value, 'workspace_id', 'Herdr pane'),
    ...(typeof label === 'string' ? { label } : {}),
  }
}

function requiredRecord(
  value: unknown,
  key: string,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`)
  const nested = value[key]
  if (!isRecord(nested)) throw new Error(`${label} has no ${key}.`)
  return nested
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const nested = value[key]
  if (typeof nested !== 'string' || nested.length === 0) {
    throw new Error(`${label} has no ${key}.`)
  }
  return nested
}

function arrayValue(value: unknown, key: string): unknown[] | undefined {
  const nested = isRecord(value) ? value[key] : undefined
  return Array.isArray(nested) ? nested : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: string): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ +/gu, ' ')
    .trim()
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
