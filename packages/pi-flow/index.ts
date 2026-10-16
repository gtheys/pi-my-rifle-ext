import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { parseFeedbackArgs } from './feedback/args.ts'
import { buildFeedbackPrompt } from './feedback/prompt.ts'
import { parseFlowArgs } from './flow/args.ts'
import { nextPhase, remainingPhases } from './flow/orchestrate.ts'
import { buildFlowPrompt } from './flow/prompt.ts'
import { parseImplementArgs } from './implement/args.ts'
import { buildImplementPrompt } from './implement/prompt.ts'
import { routeFor } from './implement/routing.ts'
import { ALL_LABELS } from './phase-state.ts'
import { parsePlanArgs } from './plan/args.ts'
import { resolvePlanDir } from './plan/paths.ts'
import { buildPlanPrompt } from './plan/prompt.ts'
import { parseResearchArgs } from './research/args.ts'
import { researchArtifactPath, resolveResearchDir } from './research/paths.ts'
import { buildResearchPrompt } from './research/prompt.ts'
import { parseValidateArgs } from './validate/args.ts'
import { resolveDevctlScriptsDir } from './validate/paths.ts'
import { buildValidatePrompt } from './validate/prompt.ts'
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

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async () => {
    await ensureLabels()
  })

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

  pi.registerCommand('implement', {
    description:
      'RPIV implement phase. Usage: /implement <jira-id | aven-ref> [--skip-research]',
    // AIDEV-NOTE: Gate wiring lives in implement/routing.ts (canImplement /
    // needsResearchSkip). This handler resolves args/mode/labels, then hands
    // off via sendUserMessage. Refusal and skip-required are surfaced to the
    // user; the handler NEVER bypasses a gate. Note: labels are fetched via
    // aven CLI; best-effort — aven failure means empty labels, which the gate
    // then refuses (fail-closed).
    handler: async (args, ctx) => {
      const parsed = parseImplementArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /implement <jira-id | aven-ref> [--skip-research]',
          'info',
        )
        return
      }
      const mode = await resolveMode(pi)
      let ref: string
      if (parsed.kind === 'jira') {
        ref = parsed.jiraId
      } else {
        ref = parsed.ref
      }
      let labels: string[] = []
      try {
        const { stdout } = await execFileAsync(
          'aven',
          ['show', ref, '--json'],
          {
            timeout: AVEN_TIMEOUT_MS,
          },
        )
        const parsedTicket: unknown = JSON.parse(stdout)
        if (
          typeof parsedTicket === 'object' &&
          parsedTicket !== null &&
          Array.isArray((parsedTicket as { labels?: unknown }).labels)
        ) {
          labels = (parsedTicket as { labels: unknown[] }).labels.filter(
            (l): l is string => typeof l === 'string',
          )
        }
      } catch {
        // fail-closed: empty labels -> routing refuses below
      }
      const routed = routeFor(parsed.kind, labels, parsed.skipResearch)
      if (routed.kind === 'refuse') {
        ctx.ui.notify(`/implement ${ref}: ${routed.reason}`, 'warning')
        return
      }
      if (routed.kind === 'skip-required') {
        ctx.ui.notify(
          `/implement ${ref}: research not done. Re-run with --skip-research to explicitly skip (recorded as an aven note).`,
          'warning',
        )
        return
      }
      pi.sendUserMessage(
        buildImplementPrompt({
          mode,
          ref,
          route: routed.route,
          researchSkip: routed.researchSkip,
        }),
      )
    },
  })

  pi.registerCommand('validate', {
    description: 'RPIV validate phase. Usage: /validate <jira-id | aven-ref>',
    // AIDEV-NOTE: Work mode resolves the sh-devctl scripts dir from the first
    // configured workRoot (validate/paths.ts) and hands off via
    // sendUserMessage. Personal mode (PMR-8449) hands off via the same prompt
    // builder; validate/prompt.ts branches on mode and never falls through to
    // the work gate. Missing workRoots config fails loudly in work mode.
    handler: async (args, ctx) => {
      const parsed = parseValidateArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify('Usage: /validate <jira-id | aven-ref>', 'info')
        return
      }
      const mode = await resolveMode(pi)
      let ref: string
      if (parsed.kind === 'jira') {
        ref = parsed.jiraId
      } else {
        ref = parsed.ref
      }
      if (mode === 'work') {
        const config = await loadConfig(process.cwd())
        const scriptsDir = resolveDevctlScriptsDir(config.workRoots)
        if (scriptsDir === null) {
          ctx.ui.notify(
            `/validate ${ref}: no workRoots configured — cannot resolve the sh-devctl scripts dir. Set workRoots in pi-flow config.json.`,
            'warning',
          )
          return
        }
        pi.sendUserMessage(buildValidatePrompt({ mode, ref, scriptsDir }))
        return
      }
      pi.sendUserMessage(buildValidatePrompt({ mode, ref, scriptsDir: null }))
    },
  })

  pi.registerCommand('feedback', {
    description: 'RPIV feedback phase. Usage: /feedback <jira-id | aven-ref>',
    // AIDEV-NOTE: Same handoff pattern as /validate. Work mode runs the
    // /sonarqube + /pr-quality gate via the prompt; personal mode runs
    // /review + the outcome-summary-then-done flow. All gating rules live
    // in the pure feedback/triage.ts and the prompt text.
    handler: async (args, ctx) => {
      const parsed = parseFeedbackArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify('Usage: /feedback <jira-id | aven-ref>', 'info')
        return
      }
      const mode = await resolveMode(pi)
      let ref: string
      if (parsed.kind === 'jira') {
        ref = parsed.jiraId
      } else {
        ref = parsed.ref
      }
      pi.sendUserMessage(buildFeedbackPrompt({ mode, ref }))
    },
  })

  pi.registerCommand('flow', {
    description:
      'RPIV run-all. Usage: /flow <jira-id | aven-ref> [--skip-research]',
    // AIDEV-NOTE: Aven IS the run state — labels fetched fail-closed (aven
    // failure aborts, never starts from research by accident). nextPhase()
    // resolves the first phase whose completion label is missing; the
    // orchestrator prompt invokes the phase commands as a human would with
    // stop-on-fail at every boundary.
    handler: async (args, ctx) => {
      const parsed = parseFlowArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /flow <jira-id | aven-ref> [--skip-research]',
          'info',
        )
        return
      }
      const mode = await resolveMode(pi)
      let ref: string
      if (parsed.kind === 'jira') {
        ref = parsed.jiraId
      } else {
        ref = parsed.ref
      }
      let labels: string[] = []
      try {
        const { stdout } = await execFileAsync(
          'aven',
          ['show', ref, '--json'],
          {
            timeout: AVEN_TIMEOUT_MS,
          },
        )
        const parsedTicket: unknown = JSON.parse(stdout)
        if (
          typeof parsedTicket === 'object' &&
          parsedTicket !== null &&
          Array.isArray((parsedTicket as { labels?: unknown }).labels)
        ) {
          labels = (parsedTicket as { labels: unknown[] }).labels.filter(
            (l): l is string => typeof l === 'string',
          )
        }
      } catch {
        ctx.ui.notify(
          `/flow ${ref}: cannot read aven labels — aborting (fail-closed). Check that the ref exists and aven is available.`,
          'warning',
        )
        return
      }
      const next = nextPhase(labels, parsed.skipResearch)
      if (next.kind === 'done') {
        ctx.ui.notify(
          `/flow ${ref}: all phase labels present (done) — nothing to run.`,
          'info',
        )
        return
      }
      const commands = remainingPhases(next.phase).map(
        (phase) => `/${phase} ${ref}`,
      )
      pi.sendUserMessage(
        buildFlowPrompt({
          mode,
          ref,
          startPhase: next.phase,
          commands,
          researchSkip: next.researchSkip === true,
        }),
      )
    },
  })
}
