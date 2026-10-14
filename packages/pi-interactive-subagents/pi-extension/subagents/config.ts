import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR_NAME, getAgentDir } from '@mariozechner/pi-coding-agent'
import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

// AIDEV-NOTE: extension-owned config per repo convention. Global:
// <agentDir>/pi-subagents/config.json. Project override:
// <cwd>/<CONFIG_DIR_NAME>/pi-subagents/config.json. Parsed at this boundary
// (JSON.parse → unknown → TypeBox) — never cast elsewhere.
export const SUBAGENTS_CONFIG_DIR = 'pi-subagents'

const SubagentsConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    status: Type.Object(
      { enabled: Type.Boolean() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export type SubagentsConfig = Static<typeof SubagentsConfigSchema>

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  status: { enabled: true },
}

export function globalSubagentsConfigPath(
  agentDir: string = getAgentDir(),
): string {
  return join(agentDir, SUBAGENTS_CONFIG_DIR, 'config.json')
}

export function projectSubagentsConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, SUBAGENTS_CONFIG_DIR, 'config.json')
}

export function validateSubagentsConfig(
  raw: unknown,
  source: string,
): SubagentsConfig {
  if (!Value.Check(SubagentsConfigSchema, raw)) {
    let firstMessage = 'is invalid'
    for (const error of Value.Errors(SubagentsConfigSchema, raw)) {
      firstMessage = `${error.path === '' ? 'config' : error.path} ${error.message}`
      break
    }
    throw new Error(`Invalid subagents config in ${source}: ${firstMessage}`)
  }
  // Reconstruct instead of returning raw so metadata keys like $schema never
  // leak into the typed config value.
  return { status: raw.status }
}

function readSubagentsConfigFile(
  path: string,
  source: string,
): SubagentsConfig | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in subagents config ${source}: ${detail}`)
  }
  return validateSubagentsConfig(parsed, source)
}

/**
 * Scaffold the default global config when (and only when) it is missing.
 * Never touches an existing or malformed file — failures to parse surface
 * from loadSubagentsConfig instead.
 */
export function scaffoldGlobalSubagentsConfig(
  agentDir: string = getAgentDir(),
): string {
  const path = globalSubagentsConfigPath(agentDir)
  if (existsSync(path)) return path
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        $schema: 'https://json-schema.org/schema',
        ...DEFAULT_SUBAGENTS_CONFIG,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return path
}

export interface LoadedSubagentsConfig {
  config: SubagentsConfig
  source: string
}

/**
 * Load the effective config: project override wins, otherwise the global
 * config (scaffolded with defaults if missing). Throws on invalid JSON or
 * invalid shape at either location.
 */
export function loadSubagentsConfig(
  cwd?: string,
  agentDir: string = getAgentDir(),
): LoadedSubagentsConfig {
  if (cwd !== undefined) {
    const projectPath = projectSubagentsConfigPath(cwd)
    const project = readSubagentsConfigFile(projectPath, projectPath)
    if (project !== undefined) return { config: project, source: projectPath }
  }
  const globalPath = scaffoldGlobalSubagentsConfig(agentDir)
  const global = readSubagentsConfigFile(globalPath, globalPath)
  if (global !== undefined) return { config: global, source: globalPath }
  return { config: DEFAULT_SUBAGENTS_CONFIG, source: globalPath }
}
