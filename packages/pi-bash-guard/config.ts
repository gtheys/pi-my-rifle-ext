// AIDEV-NOTE: TypeBox schema is the source of truth for config shape.
// config.schema.json (checked in) is regenerated from this at startup if
// missing. Global path: getAgentDir()/pi-bash-guard/config.json.
// Project override: <cwd>/<CONFIG_DIR_NAME>/pi-bash-guard/config.json.
// Precedence: project config > global config > built-in defaults.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

export const BashGuardConfigSchema = Type.Object({
  enabled: Type.Optional(
    Type.Boolean({
      description:
        'Master switch. Default true — the guard is on whenever the extension is loaded.',
    }),
  ),
  deciderUrl: Type.Optional(
    Type.String({
      description:
        "Base URL of a running strands-decider server (`strands-decider serve <model> --port <port>`). Default 'http://127.0.0.1:8000'.",
    }),
  ),
  threshold: Type.Optional(
    Type.Number({
      minimum: 0.5,
      maximum: 0.99,
      description:
        'Minimum calibrated confidence for a decider "safe" verdict to auto-allow a command. Default 0.85. Below it (or on any "destructive" verdict) the command waits for human confirmation.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: 60000,
      description:
        'Decider request timeout in milliseconds. Default 3000. On timeout the command waits for human confirmation (fail closed).',
    }),
  ),
  rememberApproval: Type.Optional(
    Type.Boolean({
      description:
        'When true (default), a human-approved command is not re-confirmed for the rest of the session (exact string match).',
    }),
  ),
})

export type BashGuardConfig = {
  enabled: boolean
  deciderUrl: string
  threshold: number
  timeoutMs: number
  rememberApproval: boolean
}

export const DEFAULT_CONFIG: BashGuardConfig = {
  enabled: true,
  deciderUrl: 'http://127.0.0.1:8000',
  threshold: 0.85,
  timeoutMs: 3000,
  rememberApproval: true,
}

export function globalConfigPath(): string {
  return path.join(getAgentDir(), 'pi-bash-guard', 'config.json')
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, 'pi-bash-guard', 'config.json')
}

async function readConfigFile(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Value.Check(BashGuardConfigSchema, parsed)) return {}
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-bash-guard config ${file}: ${msg}`)
  }
}

export async function resolveConfig(cwd: string): Promise<BashGuardConfig> {
  const global = await readConfigFile(globalConfigPath())
  const project = await readConfigFile(projectConfigPath(cwd))
  const merged: Record<string, unknown> = { ...global, ...project }
  const out: BashGuardConfig = { ...DEFAULT_CONFIG }
  if (typeof merged.enabled === 'boolean') out.enabled = merged.enabled
  if (typeof merged.deciderUrl === 'string') out.deciderUrl = merged.deciderUrl
  if (typeof merged.threshold === 'number') out.threshold = merged.threshold
  if (typeof merged.timeoutMs === 'number') out.timeoutMs = merged.timeoutMs
  if (typeof merged.rememberApproval === 'boolean') {
    out.rememberApproval = merged.rememberApproval
  }
  return out
}

// Scaffold config.schema.json next to the source when missing (same contract
// as pi-pr-digest).
export async function scaffoldSchema(): Promise<void> {
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'config.schema.json',
  )
  try {
    await fs.access(schemaPath)
  } catch {
    await fs.writeFile(
      schemaPath,
      JSON.stringify(BashGuardConfigSchema, null, 2),
      'utf-8',
    )
  }
}
