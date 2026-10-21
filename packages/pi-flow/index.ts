import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { parseFeedbackArgs } from './feedback/args.ts'
import { parseFlowArgs } from './flow/args.ts'
import {
  type AvenRunner,
  findJiraEpic,
  resolveJiraEpic,
} from './flow/jira-ref.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase } from './flow/orchestrate.ts'
import {
  buildPhasePrompt,
  type PhasePrompt,
  type PhasePromptInput,
  type ResearchOverride,
} from './flow/phase-prompts.ts'
import { needsResearchSkip } from './gates.ts'
import { syncHerdrPlugin } from './herdr/sync.ts'
import {
  FlowHerdrViewer,
  isValidRef,
  parseViewerPlacement,
} from './herdr/viewer.ts'
import { parseImplementArgs } from './implement/args.ts'
import { ALL_LABELS } from './phase-state.ts'
import { parsePlanArgs } from './plan/args.ts'
import { parseResearchArgs } from './research/args.ts'
import { recordRunEvent, runStatePath } from './run-state.ts'
import { parseValidateArgs } from './validate/args.ts'
import { modeForToplevel, type WorkMode } from './work-mode.ts'

const execFileAsync = promisify(execFile)
const AVEN_TIMEOUT_MS = 5_000

// AIDEV-NOTE: Shared aven helpers (labels are the run state, notes are the
// halt record). Used by the /implement and /flow command handlers and by the
// flow loop deps — one parsing path, fail-closed (null/[] on any failure).
export async function readAvenLabels(ref: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('aven', ['show', ref, '--json'], {
      timeout: AVEN_TIMEOUT_MS,
    })
    const parsedTicket: unknown = JSON.parse(stdout)
    if (
      typeof parsedTicket === 'object' &&
      parsedTicket !== null &&
      Array.isArray((parsedTicket as { labels?: unknown }).labels)
    ) {
      return (parsedTicket as { labels: unknown[] }).labels.filter(
        (l): l is string => typeof l === 'string',
      )
    }
    return null
  } catch {
    return null
  }
}

export async function writeAvenNote(
  ref: string,
  text: string,
): Promise<boolean> {
  try {
    await execFileAsync('aven', ['note', ref, text], {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch {
    return false
  }
}

export async function writeAvenLabel(
  ref: string,
  label: string,
): Promise<boolean> {
  try {
    await execFileAsync('aven', ['edit', ref, '--label', label], {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch {
    return false
  }
}

// AIDEV-NOTE: aven runner for the Jira-ID resolver (flow/jira-ref.ts) —
// execFileAsync throws on spawn failure / non-zero exit; aven's own errors
// (exit 0, text on stdout) are classified inside the resolver.
const avenExec: AvenRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('aven', [...args], {
    timeout: AVEN_TIMEOUT_MS,
  })
  return { stdout, stderr }
}

// AIDEV-NOTE: Option B — phase-command Jira resolution is read-only: an
// existing pulled-in epic (jira-ref metadata) replaces the Jira ID so label
// gates read the epic; a miss passes the Jira ID through unchanged (the
// feature-plan-aven skill handles the cold pull-in itself). Only /flow
// creates the epic (it needs a real ref before any phase can run).
async function resolvePhaseRef(
  parsed: { kind: 'jira'; jiraId: string } | { kind: 'aven'; ref: string },
  mode: WorkMode,
): Promise<string> {
  if (parsed.kind === 'aven' || mode !== 'work') return refOf(parsed)
  const found = await findJiraEpic(parsed.jiraId, avenExec)
  return found.kind === 'found' ? found.ref : parsed.jiraId
}

function refOf(
  parsed: { kind: 'jira'; jiraId: string } | { kind: 'aven'; ref: string },
): string {
  return parsed.kind === 'jira' ? parsed.jiraId : parsed.ref
}

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

// AIDEV-NOTE: Best-effort journal write — run-state recording must never
// break a flow phase; aven labels remain the gate source of truth.
async function journal(
  event: Parameters<typeof recordRunEvent>[1],
): Promise<void> {
  try {
    await recordRunEvent(getAgentDir(), event)
  } catch {
    // best-effort by design
  }
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

// AIDEV-NOTE: Shared per-invocation inputs for buildPhasePrompt — the phase
// commands and (via /flow) the loop build identical inputs from the same env,
// so a human-invoked phase and a flow-driven phase can never drift.
async function commandPhaseInput(
  pi: ExtensionAPI,
  mode: WorkMode,
  ref: string,
  skipResearch: boolean = false,
  labels: readonly string[] = [],
): Promise<PhasePromptInput> {
  const { stdout } = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const config = await loadConfig(process.cwd())
  return {
    mode,
    ref,
    skipResearch,
    gitRoot: stdout.trim(),
    workRoots: config.workRoots,
    labels,
  }
}

export default function (pi: ExtensionAPI) {
  // AIDEV-NOTE: ui.notify holder — command and event handlers each get their
  // own ctx; the loop needs one stable notify. session_start fires before any
  // command or agent_settled event, so the holder is always populated by then.
  let notifyUser:
    | ((message: string, level: 'info' | 'warning') => void)
    | null = null

  const loop = createFlowLoop({
    notify: (message, level) => {
      if (notifyUser !== null) {
        notifyUser(message, level)
      } else {
        console.log(`[pi-flow] ${level}: ${message}`)
      }
    },
    journal: (event) => {
      void journal(event)
    },
    readLabels: (ref) => readAvenLabels(ref),
    avenNote: (ref, text) => writeAvenNote(ref, text),
    avenSetLabel: (ref, label) => writeAvenLabel(ref, label),
    sendPrompt: (prompt) => {
      pi.sendUserMessage(prompt)
    },
  })

  // AIDEV-NOTE: shared handler tail — one block/send path for every phase
  // command, so notify wording cannot drift between phases.
  function sendOrNotify(
    ctx: { ui: { notify: (m: string, l: 'info' | 'warning') => void } },
    name: string,
    ref: string,
    result: PhasePrompt,
  ): void {
    if (result.kind === 'block') {
      ctx.ui.notify(`/${name} ${ref}: ${result.reason}`, 'warning')
      return
    }
    pi.sendUserMessage(result.prompt)
  }

  pi.on('session_start', (_event, ctx) => {
    notifyUser = (message, level) => ctx.ui.notify(message, level)
    void ensureLabels()
  })

  // AIDEV-NOTE: The /flow advancement hook. agent_settled fires after a run
  // fully settles (blocking ask_user_question gates keep the run in flight,
  // so gates are never raced). The loop re-reads aven labels and either
  // injects the next phase prompt or halts — advancement is code, not model.
  pi.on('agent_settled', () => {
    void loop.onSettled()
  })

  pi.registerCommand('research', {
    description:
      'RPIV research phase. Usage: /research <topic> | /research --debug <symptom>',
    // AIDEV-NOTE: Prompt prep lives in flow/phase-prompts.ts (shared with the
    // /flow loop). The ticket-creation gate lives in the agent prompt — the
    // command itself never creates tickets. See research/ticket-gate.ts.
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
      const research =
        parsed.kind === 'debug'
          ? { kind: 'debug' as const, text: parsed.symptom }
          : { kind: 'feature' as const, text: parsed.topic }
      const result = await buildPhasePrompt('research', {
        ...(await commandPhaseInput(pi, mode, research.text)),
        research,
      })
      sendOrNotify(ctx, 'research', research.text, result)
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
      const ref = await resolvePhaseRef(parsed, mode)
      const result = await buildPhasePrompt(
        'plan',
        await commandPhaseInput(pi, mode, ref),
      )
      sendOrNotify(ctx, 'plan', ref, result)
    },
  })

  pi.registerCommand('implement', {
    description:
      'RPIV implement phase. Usage: /implement <jira-id | aven-ref> [--skip-research]',
    // AIDEV-NOTE: Gate wiring lives in implement/routing.ts via
    // buildPhasePrompt('implement'). This handler resolves args/mode/labels,
    // then hands off via sendUserMessage; refuse/skip-required surface as a
    // block reason notification. Labels fetched fail-closed (aven failure ->
    // empty labels -> routing refuses).
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
      const ref = await resolvePhaseRef(parsed, mode)
      const labels = (await readAvenLabels(ref)) ?? []
      // AIDEV-NOTE: --skip-research must leave durable label state — gates
      // read labels, never notes — so later invocations never re-demand it.
      if (parsed.skipResearch && needsResearchSkip(labels)) {
        await writeAvenLabel(ref, 'research-skipped')
      }
      const result = await buildPhasePrompt(
        'implement',
        await commandPhaseInput(pi, mode, ref, parsed.skipResearch, labels),
      )
      sendOrNotify(ctx, 'implement', ref, result)
    },
  })

  pi.registerCommand('validate', {
    description: 'RPIV validate phase. Usage: /validate <jira-id | aven-ref>',
    // AIDEV-NOTE: Work mode resolves the sh-devctl scripts dir from the first
    // configured workRoot (validate/paths.ts) inside buildPhasePrompt; missing
    // workRoots blocks loudly. Personal mode (PMR-8449) never hits the work gate.
    handler: async (args, ctx) => {
      const parsed = parseValidateArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify('Usage: /validate <jira-id | aven-ref>', 'info')
        return
      }
      const mode = await resolveMode(pi)
      const ref = await resolvePhaseRef(parsed, mode)
      const result = await buildPhasePrompt(
        'validate',
        await commandPhaseInput(pi, mode, ref),
      )
      sendOrNotify(ctx, 'validate', ref, result)
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
      const ref = await resolvePhaseRef(parsed, mode)
      const result = await buildPhasePrompt(
        'feedback',
        await commandPhaseInput(pi, mode, ref),
      )
      sendOrNotify(ctx, 'feedback', ref, result)
    },
  })

  pi.registerCommand('flow', {
    description:
      'RPIV run-all. Usage: /flow <jira-id | aven-ref> [--skip-research]',
    // AIDEV-NOTE: Aven IS the run state — labels fetched fail-closed (aven
    // failure aborts, never starts from research by accident). nextPhase()
    // resolves the first phase whose completion label is missing, then the
    // extension-owned loop (flow/loop.ts) takes over: it injects ONE phase
    // prompt at a time (same builder the phase commands use) and advances on
    // agent_settled when the phase label lands. No driver agent — the model
    // never sequences phases.
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
      let research: ResearchOverride | undefined
      if (parsed.kind === 'jira') {
        if (mode !== 'work') {
          ctx.ui.notify(
            `/flow ${parsed.jiraId}: Jira IDs are work-mode only (this repo is personal) — use an aven ref`,
            'warning',
          )
          return
        }
        const resolved = await resolveJiraEpic(parsed.jiraId, avenExec)
        if (resolved.kind === 'abort') {
          ctx.ui.notify(`/flow ${parsed.jiraId}: ${resolved.reason}`, 'warning')
          return
        }
        ref = resolved.ref
        // Research topic stays the human-readable Jira ID; aven labels live
        // on the epic ref.
        research = { kind: 'feature', text: parsed.jiraId }
        if (resolved.created) {
          ctx.ui.notify(
            `/flow ${parsed.jiraId}: pulled in local epic ${resolved.ref}`,
            'info',
          )
        }
      } else {
        ref = parsed.ref
      }
      const labels = await readAvenLabels(ref)
      if (labels === null) {
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
      await journal({
        kind: 'run-start',
        at: new Date().toISOString(),
        ref,
        mode,
        skipResearch: parsed.skipResearch,
      })
      await loop.start({
        ref,
        phase: next.phase,
        skipResearch: parsed.skipResearch,
        researchSkip: next.researchSkip === true,
        promptInput: {
          ...(await commandPhaseInput(pi, mode, ref, parsed.skipResearch)),
          research,
        },
      })
    },
  })

  pi.registerCommand('herdr-sync', {
    description:
      'Link this repo as a Herdr plugin (idempotent). Usage: /herdr-sync',
    // AIDEV-NOTE: Explicit-only plugin registration — never during
    // session_start. Preflight validates herdr-plugin.toml against the
    // package version; herdr absent = graceful skip. Port of pi-workflows'
    // `pi-workflows herdr sync` discipline.
    handler: async (_args, ctx) => {
      const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
      )
      let result: Awaited<ReturnType<typeof syncHerdrPlugin>>
      try {
        result = await syncHerdrPlugin(repoRoot)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/herdr-sync failed: ${msg}`, 'warning')
        return
      }
      const level = result.status === 'unavailable' ? 'info' : 'info'
      ctx.ui.notify(
        `${result.message}${result.runningPiProcessesNeedReload ? ' Running Pi processes need a reload to pick up plugin panes.' : ''}`,
        level,
      )
    },
  })

  pi.registerCommand('flow-view', {
    description:
      'Open the flow run-state viewer in a Herdr pane. Usage: /flow-view <ref> [right|below|left|above|tab]',
    // AIDEV-NOTE: Herdr-gated viewer opener. Requires an existing run-state
    // file (i.e. /flow must have started at least once for the ref). Dedupes
    // by pane label ("flow · <ref>") via herdr api snapshot — survives Pi
    // reloads without any state of our own.
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const ref = parts[0]
      const placementArg = parts[1]
      if (ref === undefined || !isValidRef(ref)) {
        ctx.ui.notify(
          'Usage: /flow-view <ref> [right|below|left|above|tab]',
          'info',
        )
        return
      }
      const placement =
        placementArg === undefined
          ? 'right'
          : parseViewerPlacement(placementArg)
      if (placement === undefined) {
        ctx.ui.notify(
          `Unknown placement "${placementArg}". Use right|below|left|above|tab.`,
          'warning',
        )
        return
      }
      const viewer = new FlowHerdrViewer(pi.exec)
      const capability = await viewer.probe()
      if (!capability.available) {
        ctx.ui.notify(`/flow-view: ${capability.reason}`, 'warning')
        return
      }
      const runFile = runStatePath(getAgentDir(), ref)
      if (runFile === null) {
        ctx.ui.notify(`/flow-view: invalid ref "${ref}".`, 'warning')
        return
      }
      try {
        await fs.access(runFile)
      } catch {
        ctx.ui.notify(
          `/flow-view ${ref}: no run state yet — run /flow ${ref} first.`,
          'warning',
        )
        return
      }
      try {
        const opened = await viewer.open(ref, placement)
        ctx.ui.notify(
          opened.reused
            ? `Focused existing flow viewer for ${ref}.`
            : `Opened flow viewer for ${ref} (${placement}).`,
          'info',
        )
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/flow-view ${ref}: ${msg}`, 'warning')
      }
    },
  })
}
