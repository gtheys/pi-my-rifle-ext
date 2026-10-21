// AIDEV-NOTE: Explicit herdr plugin sync (simplified from pi-workflows'
// src/herdr/setup.ts). `herdr plugin link <repo root>` is run ONLY by the
// /herdr-sync command — never during session start. Preflight validates the
// manifest against the package version before touching herdr, and the result
// is re-verified by listing after the mutation. Herdr absent = graceful skip.
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const HERDR_PLUGIN_ID = 'gtheys.pi-my-rifle-ext'

const MANIFEST_NAME = 'herdr-plugin.toml'
const VIEWER_PATH = 'plugins/herdr/flow-viewer.mjs'
const RESULT_SCHEMA = 'gtheys.pi-my-rifle-ext.herdr-sync.v1'
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024

export type HerdrSyncStatus =
  | 'linked'
  | 'relinked'
  | 'enabled'
  | 'unchanged'
  | 'unavailable'

export type HerdrSyncResult = {
  schema: typeof RESULT_SCHEMA
  status: HerdrSyncStatus
  changed: boolean
  pluginId: string
  expectedVersion: string
  effectiveVersion: string | null
  enabled: boolean | null
  runningPiProcessesNeedReload: true
  message: string
}

type Spawn = (
  command: string,
  args: readonly string[],
) => SpawnSyncReturns<string>

type InstalledPlugin = {
  root: string
  version: string
  enabled: boolean
}

/** Minimal TOML string reader for the keys preflight checks (port of pi-workflows). */
export function tomlString(text: string, key: string): string | undefined {
  const match = new RegExp(
    String.raw`^\s*${key}\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$`,
    'mu',
  ).exec(text)
  return match?.[1]
}

/** Validate the manifest + launcher against the repo root. Throws on any mismatch. */
export async function preflightRepo(
  repoRoot: string,
): Promise<{ root: string; version: string }> {
  const root = path.resolve(repoRoot)
  const packageJson: unknown = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8'),
  )
  const version = (packageJson as { version?: unknown }).version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json at ${root} has no version.`)
  }
  const manifest = await fs.readFile(path.join(root, MANIFEST_NAME), 'utf8')
  const id = tomlString(manifest, 'id')
  if (id !== HERDR_PLUGIN_ID) {
    throw new Error(`${MANIFEST_NAME} id must be ${HERDR_PLUGIN_ID}.`)
  }
  const manifestVersion = tomlString(manifest, 'version')
  if (manifestVersion !== version) {
    throw new Error(
      `${MANIFEST_NAME} version ${manifestVersion ?? '(missing)'} does not match package version ${version}. Bump both together.`,
    )
  }
  const platformsRaw =
    /platforms\s*=\s*\[([^\]]*)\]/mu.exec(manifest)?.[1] ?? ''
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  if (!platformsRaw.includes(`"${platform}"`)) {
    throw new Error(`${MANIFEST_NAME} does not support platform ${platform}.`)
  }
  const command = /command\s*=\s*\[([^\]]*)\]/mu.exec(manifest)?.[1] ?? ''
  if (!command.includes('"node"') || !command.includes(`"${VIEWER_PATH}"`)) {
    throw new Error(
      `${MANIFEST_NAME} command must be ["node", "${VIEWER_PATH}"].`,
    )
  }
  let viewerStat: import('node:fs').Stats
  try {
    viewerStat = await fs.stat(path.join(root, VIEWER_PATH))
  } catch {
    throw new Error(`${VIEWER_PATH} is missing from the repo root.`)
  }
  if (!viewerStat.isFile()) {
    throw new Error(`${VIEWER_PATH} is missing from the repo root.`)
  }
  return { root, version }
}

function parseInstalledPlugin(stdout: string): InstalledPlugin | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('Herdr returned invalid plugin JSON.')
  }
  const result = (value as Record<string, unknown>).result
  if (!isRecord(result) || !Array.isArray(result.plugins)) {
    throw new Error('Herdr returned an invalid plugin list.')
  }
  const candidates = result.plugins.filter(
    (plugin) => isRecord(plugin) && plugin.plugin_id === HERDR_PLUGIN_ID,
  )
  const candidate = candidates[0]
  if (candidate === undefined) return undefined
  if (
    !isRecord(candidate) ||
    typeof candidate.plugin_root !== 'string' ||
    typeof candidate.version !== 'string' ||
    typeof candidate.enabled !== 'boolean'
  ) {
    throw new Error(
      `Herdr returned an incomplete record for ${HERDR_PLUGIN_ID}.`,
    )
  }
  return {
    root: candidate.plugin_root,
    version: candidate.version,
    enabled: candidate.enabled,
  }
}

function matchesExpected(
  installed: InstalledPlugin,
  expected: { root: string; version: string },
  requireEnabled: boolean,
): boolean {
  return (
    path.resolve(installed.root) === path.resolve(expected.root) &&
    installed.version === expected.version &&
    (!requireEnabled || installed.enabled)
  )
}

export async function syncHerdrPlugin(
  repoRoot: string,
  spawn: Spawn = runCommand,
): Promise<HerdrSyncResult> {
  const expected = await preflightRepo(repoRoot)
  const initial = inspectHerdr(spawn, true)
  if (initial.available !== true) {
    return result('unavailable', false, expected.version, undefined)
  }

  const installed = initial.plugin
  if (installed === undefined) {
    await mutateOrThrow(spawn, 'link', [expected.root])
    const adopted = inspectHerdr(spawn, false)
    if (
      adopted.available === true &&
      adopted.plugin !== undefined &&
      matchesExpected(adopted.plugin, expected, true)
    ) {
      return result('linked', true, expected.version, adopted.plugin)
    }
    throw new Error('Could not link the Herdr plugin — verification failed.')
  }

  if (matchesExpected(installed, expected, true)) {
    return result('unchanged', false, expected.version, installed)
  }

  if (matchesExpected(installed, expected, false) && !installed.enabled) {
    await mutateOrThrow(spawn, 'enable', [HERDR_PLUGIN_ID])
    const adopted = inspectHerdr(spawn, false)
    if (
      adopted.available === true &&
      adopted.plugin !== undefined &&
      matchesExpected(adopted.plugin, expected, true)
    ) {
      return result('enabled', true, expected.version, adopted.plugin)
    }
    throw new Error('Could not enable the Herdr plugin — verification failed.')
  }

  await mutateOrThrow(spawn, 'unlink', [HERDR_PLUGIN_ID])
  await mutateOrThrow(spawn, 'link', [expected.root])
  const adopted = inspectHerdr(spawn, false)
  if (
    adopted.available === true &&
    adopted.plugin !== undefined &&
    matchesExpected(adopted.plugin, expected, true)
  ) {
    return result('relinked', true, expected.version, adopted.plugin)
  }
  throw new Error('Could not relink the Herdr plugin — verification failed.')
}

type Inspection =
  | { available: true; plugin: InstalledPlugin | undefined }
  | { available: false }

function inspectHerdr(spawn: Spawn, allowUnavailable: boolean): Inspection {
  const listed = spawn('herdr', [
    'plugin',
    'list',
    '--plugin',
    HERDR_PLUGIN_ID,
    '--json',
  ])
  if (listed.error !== undefined && listed.error !== null) {
    if (
      allowUnavailable &&
      (listed.error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { available: false }
    }
    throw new Error(`Could not run herdr: ${listed.error.message}`)
  }
  if (listed.status !== 0) {
    throw new Error(
      `Could not inspect Herdr plugins: ${bounded(listed.stderr || listed.stdout)}`,
    )
  }
  return { available: true, plugin: parseInstalledPlugin(listed.stdout) }
}

async function mutateOrThrow(
  spawn: Spawn,
  action: 'link' | 'unlink' | 'enable',
  args: readonly string[],
): Promise<void> {
  const changed = spawn('herdr', ['plugin', action, ...args])
  if (changed.error !== undefined && changed.error !== null) {
    throw new Error(`herdr plugin ${action} failed: ${changed.error.message}`)
  }
  if (changed.status !== 0) {
    throw new Error(
      `herdr plugin ${action} failed: ${bounded(changed.stderr || changed.stdout)}`,
    )
  }
}

function result(
  status: HerdrSyncStatus,
  changed: boolean,
  expectedVersion: string,
  effective: InstalledPlugin | undefined,
): HerdrSyncResult {
  const messages: Record<HerdrSyncStatus, string> = {
    linked: `Linked Herdr plugin ${HERDR_PLUGIN_ID}.`,
    relinked: `Repaired Herdr plugin ${HERDR_PLUGIN_ID}.`,
    enabled: `Enabled Herdr plugin ${HERDR_PLUGIN_ID}.`,
    unchanged: `Herdr plugin ${HERDR_PLUGIN_ID} is current.`,
    unavailable: 'Herdr is not installed; plugin synchronization was skipped.',
  }
  return {
    schema: RESULT_SCHEMA,
    status,
    changed,
    pluginId: HERDR_PLUGIN_ID,
    expectedVersion,
    effectiveVersion: effective?.version ?? null,
    enabled: effective?.enabled ?? null,
    runningPiProcessesNeedReload: true,
    message: messages[status],
  }
}

function runCommand(
  command: string,
  args: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
  })
}

function bounded(value: string): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ +/gu, ' ')
    .trim()
  return compact.length <= 300 ? compact : `${compact.slice(0, 299)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
