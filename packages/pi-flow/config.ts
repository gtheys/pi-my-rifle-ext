// AIDEV-NOTE: pi-flow config boundary (PMR-T22H) — TypeBox schema is the
// source of truth for config shape; config.schema.json (checked in) mirrors
// it. Malformed config throws a clear error — never silent defaults
// (AGENTS.md rule). resolveMode is the pi-bound mode resolver; the pure
// modeForToplevel decision lives in work-mode.ts.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { modeForToplevel, type WorkMode } from './work-mode.ts'

const PiFlowConfigSchema = Type.Object({
  workRoots: Type.Array(
    Type.String({ description: 'Absolute path prefix of a work repo root' }),
    {
      description: 'Git toplevels under any prefix are "work" mode',
      minItems: 0,
    },
  ),
  avenWorkspace: Type.Optional(
    Type.String({
      description:
        'Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and search fallback)',
    }),
  ),
  landTestCommand: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Argv of the test command flow_land runs before authorizing a landing (default ["bun","run","test"]). PMR-05HX: the landing gate never trusts a claimed-green suite.',
      minItems: 1,
    }),
  ),
  telemetry: Type.Optional(
    Type.Object(
      {
        enabled: Type.Boolean({
          description:
            'Master switch — telemetry subscribes to nothing when false/absent (PMR-R8AG)',
        }),
        otlpEndpoint: Type.String({
          description:
            'OTLP/HTTP base URL (e.g. https://host:4478); spans POST to <endpoint>/v1/traces',
        }),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              'Static extra headers for OTLP export. Secrets belong in env (PI_FLOW_OTLP_TOKEN), not config',
          }),
        ),
      },
      { description: 'Optional OTLP telemetry export (PMR-R8AG)' },
    ),
  ),
})

export type PiFlowConfig = Static<typeof PiFlowConfigSchema>

export async function readConfigFile(
  file: string,
): Promise<Partial<PiFlowConfig>> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-flow config ${file}: ${msg}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`pi-flow config ${file} is not valid JSON: ${msg}`)
  }
  if (!Value.Check(PiFlowConfigSchema, parsed)) {
    const errors = Value.Errors(PiFlowConfigSchema, parsed)
      .map((e) => e.message)
      .join('; ')
    throw new Error(`pi-flow config ${file} is invalid: ${errors}`)
  }
  return parsed
}

// AIDEV-NOTE: Global getAgentDir()/pi-flow/config.json, then project override
// ctx.cwd/CONFIG_DIR_NAME/pi-flow/config.json wins. Missing files = empty
// merge; present-but-invalid = throw.
export async function loadConfig(cwd: string): Promise<PiFlowConfig> {
  const globalPath = path.join(getAgentDir(), 'pi-flow', 'config.json')
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, 'pi-flow', 'config.json')
  const merged: PiFlowConfig = { workRoots: [] }
  Object.assign(merged, await readConfigFile(globalPath))
  Object.assign(merged, await readConfigFile(projectPath))
  return merged
}

export async function resolveMode(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<WorkMode> {
  const { stdout } = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const toplevel = stdout.trim()
  // AIDEV-NOTE: session cwd, not process.cwd() — see avenOverrideArg note in
  // aven/client.ts.
  const config = await loadConfig(cwd ?? process.cwd())
  return modeForToplevel(toplevel, config.workRoots)
}
