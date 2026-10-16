import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { ALL_LABELS } from './phase-state.ts'
import { parsePlanArgs } from './plan/args.ts'
import { resolvePlanDir } from './plan/paths.ts'
import { buildPlanPrompt } from './plan/prompt.ts'
import { parseResearchArgs } from './research/args.ts'
import { researchArtifactPath, resolveResearchDir } from './research/paths.ts'
import { buildResearchPrompt } from './research/prompt.ts'
import { modeForToplevel, type WorkMode } from './work-mode.ts'

const execFileAsync = promisify(execFile)
const AVEN_TIMEOUT_MS = 5_000

// AIDEV-NOTE: TypeBox schema is the source of truth for config shape;
// config.schema.json (checked in) mirrors it. Malformed config throws a
// clear error — never silent defaults (AGENTS.md rule).
const PiFlowConfigSchema = Type.Object({
  workRoots: Type.Array(
    Type.String({ description: 'Absolute path prefix of a work repo root' }),
    {
      description: 'Git toplevels under any prefix are "work" mode',
      minItems: 0,
    },
  ),
})

type PiFlowConfig = Static<typeof PiFlowConfigSchema>

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

export async function resolveMode(pi: ExtensionAPI): Promise<WorkMode> {
  const { stdout } = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const toplevel = stdout.trim()
  const config = await loadConfig(process.cwd())
  return modeForToplevel(toplevel, config.workRoots)
}

// AIDEV-NOTE: Best-effort label bootstrap — "already exists" and any other
// aven failure are tolerated; label creation must never break startup.
export async function ensureLabels(): Promise<void> {
  for (const label of ALL_LABELS) {
    try {
      await execFileAsync('aven', ['label', 'create', label], {
        timeout: AVEN_TIMEOUT_MS,
      })
    } catch {
      // already exists, aven missing, or timeout — fine
    }
  }
}

const STUB_PHASES = [
  'research',
  'plan',
  'implement',
  'validate',
  'feedback',
] as const

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async () => {
    await ensureLabels()
  })

  for (const phase of STUB_PHASES) {
    if (phase === 'research' || phase === 'plan') continue // implemented below
    pi.registerCommand(phase, {
      description: `RPIV flow: ${phase} phase (stub)`,
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `/flow ${phase}: not implemented yet — wired by its phase ticket.`,
          'info',
        )
      },
    })
  }

  pi.registerCommand('research', {
    description:
      'RPIV research phase. Usage: /research <topic> | /research --debug <symptom>',
    // AIDEV-NOTE: Command resolves args/mode/artifact path synchronously, then
    // hands off to the agent via sendUserMessage (same pattern as pr-digest).
    // The ticket-creation gate lives in the agent prompt — the command itself
    // never creates tickets. See research/ticket-gate.ts for the pure gate.
    handler: async (args, ctx) => {
      const parsed = parseResearchArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /research <topic> | /research --debug <symptom>',
          'info',
        )
        return
      }
      const mode = await resolveMode(pi)
      let input: string
      if (parsed.kind === 'debug') {
        input = parsed.symptom
      } else {
        input = parsed.topic
      }
      const { stdout } = await pi.exec(
        'git',
        ['rev-parse', '--show-toplevel'],
        {},
      )
      const toplevel = stdout.trim()
      const repoName = toplevel.split('/').pop() ?? 'unknown'
      const dir = resolveResearchDir(
        process.env.LLM_NOTES_ROOT,
        repoName,
        toplevel,
      )
      const artifactPath = researchArtifactPath(
        dir,
        input,
        new Date().toISOString().slice(0, 10),
      )
      pi.sendUserMessage(
        buildResearchPrompt({
          kind: parsed.kind,
          input,
          artifactPath,
          mode,
        }),
      )
    },
  })

  pi.registerCommand('plan', {
    description: 'RPIV plan phase. Usage: /plan <jira-id | aven-ref>',
    // AIDEV-NOTE: Same handoff pattern as /research. Work mode routes to the
    // user's feature-plan-aven skill by name; personal mode runs the size-check
    // flow. Decomposition only via plan/split-gate.ts after explicit confirm.
    handler: async (args, ctx) => {
      const parsed = parsePlanArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify('Usage: /plan <jira-id | aven-ref>', 'info')
        return
      }
      const mode = await resolveMode(pi)
      let ref: string
      if (parsed.kind === 'jira') {
        ref = parsed.jiraId
      } else {
        ref = parsed.ref
      }
      const { stdout } = await pi.exec(
        'git',
        ['rev-parse', '--show-toplevel'],
        {},
      )
      const toplevel = stdout.trim()
      const repoName = toplevel.split('/').pop() ?? 'unknown'
      const dir = resolvePlanDir(
        process.env.PERSONAL_FEATURES,
        repoName,
        toplevel,
        new Date().toISOString().slice(0, 10),
        ref,
      )
      const planPath = path.join(dir, 'plan.md')
      pi.sendUserMessage(
        buildPlanPrompt({
          mode,
          ref,
          planPath,
        }),
      )
    },
  })

  pi.registerCommand('flow', {
    description: 'RPIV flow overview (stub)',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        '/flow: not implemented yet — wired by the phase tickets. Phases: research, plan, implement, validate, feedback.',
        'info',
      )
    },
  })
}
