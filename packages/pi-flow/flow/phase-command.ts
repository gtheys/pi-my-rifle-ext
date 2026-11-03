// AIDEV-NOTE: PMR-T22H — phase-command factory. The 5 phase commands
// (/research, /plan, /implement, /validate, /feedback) share ONE skeleton
// (parse → resolveMode → resolve ref → commandPhaseInput → buildPhasePrompt
// → sendOrNotify) so notify wording and gate wiring cannot drift between
// phases; per-command variance is declared via the hooks below. The /flow
// loop command does NOT use the factory (it resolves/creates the epic and
// journals) but shares commandPhaseInput.
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import {
  avenExec,
  epicHasOpenChildren,
  readAvenLabels,
  writeAvenLabel,
} from '../aven/client.ts'
import { loadConfig, resolveMode } from '../config.ts'
import { parseFeedbackArgs } from '../feedback/args.ts'
import { needsResearchSkip } from '../gates.ts'
import { parseImplementArgs } from '../implement/args.ts'
import { parsePlanArgs } from '../plan/args.ts'
import { parseResearchArgs, type ResearchArgs } from '../research/args.ts'
import { parseValidateArgs } from '../validate/args.ts'
import type { WorkMode } from '../work-mode.ts'
import { findJiraEpic, findTicketResearchTarget } from './jira-ref.ts'
import type { Phase } from './orchestrate.ts'
import {
  buildPhasePrompt,
  type PhasePrompt,
  type PhasePromptInput,
  type ResearchOverride,
} from './phase-prompts.ts'

type ParsedRef =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }

// AIDEV-NOTE: Option B — phase-command Jira resolution is read-only: an
// existing pulled-in epic (jira-ref metadata) replaces the Jira ID so label
// gates read the epic; a miss passes the Jira ID through unchanged (the
// feature-plan-aven skill handles the cold pull-in itself). Only /flow
// creates the epic (it needs a real ref before any phase can run).
export async function resolvePhaseRef(
  parsed: ParsedRef,
  mode: WorkMode,
): Promise<string> {
  if (parsed.kind === 'aven' || mode !== 'work') return refOf(parsed)
  const found = await findJiraEpic(parsed.jiraId, avenExec)
  return found.kind === 'found' ? found.ref : parsed.jiraId
}

function refOf(parsed: ParsedRef): string {
  return parsed.kind === 'jira' ? parsed.jiraId : parsed.ref
}

// AIDEV-NOTE: Shared per-invocation inputs for buildPhasePrompt — the phase
// commands and (via /flow) the loop build identical inputs from the same env,
// so a human-invoked phase and a flow-driven phase can never drift.
export async function commandPhaseInput(
  pi: ExtensionAPI,
  input: {
    mode: WorkMode
    ref: string
    cwd?: string
    skipResearch?: boolean
    labels?: readonly string[]
    onResearchFallback?: (jiraId: string) => void
  },
): Promise<PhasePromptInput> {
  const { stdout } = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const config = await loadConfig(input.cwd ?? process.cwd())
  return {
    mode: input.mode,
    ref: input.ref,
    skipResearch: input.skipResearch ?? false,
    gitRoot: stdout.trim(),
    workRoots: config.workRoots,
    labels: input.labels ?? [],
    // AIDEV-NOTE: read-only ticket lookup for ticket research — jira-ref epic
    // first (labels land there, /flow resumes clean), then the jira-key synced
    // ticket (no acli needed). Neither → acli branch, announced via
    // onResearchFallback so an acli-first run never looks like aven was
    // skipped.
    findTicketRef: async (jiraId) => {
      const found = await findTicketResearchTarget(jiraId, avenExec)
      if (found.kind === 'none') input.onResearchFallback?.(jiraId)
      if (found.kind === 'epic' || found.kind === 'synced') {
        return { kind: found.kind, ref: found.ref }
      }
      return null
    },
  }
}

// AIDEV-NOTE: shared handler tail — one block/send path for every phase
// command, so notify wording cannot drift between phases.
function sendOrNotify(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
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

interface PhaseCommandOptions<Parsed extends { kind: string }> {
  name: Phase
  description: string
  /** Shown as `Usage: <usage>` when the parser returns kind 'help'. */
  usage: string
  parse: (raw: string) => Parsed | { kind: 'help' }
  /** Resolve the phase ref from parsed args; default is the shared
   *  resolvePhaseRef (aven-first Jira resolution). */
  resolveRef?: (parsed: Parsed, mode: WorkMode) => Promise<string>
  /** Extra PhasePromptInput fields (labels, research override, epic guard).
   *  May perform the durable side effects the phase needs (research-skipped
   *  label write). */
  extraInput?: (input: {
    parsed: Parsed
    mode: WorkMode
    ref: string
    ctx: ExtensionCommandContext
  }) => Promise<Partial<PhasePromptInput>>
  /** Called when ticket research finds no aven epic or synced ticket and
   *  falls back to acli. */
  onResearchFallback?: (jiraId: string, ctx: ExtensionCommandContext) => void
}

function registerPhaseCommand<Parsed extends { kind: string }>(
  pi: ExtensionAPI,
  options: PhaseCommandOptions<Parsed>,
): void {
  pi.registerCommand(options.name, {
    description: options.description,
    handler: async (args, ctx) => {
      const parsed = options.parse(args)
      if ((parsed as { kind: string }).kind === 'help') {
        ctx.ui.notify(`Usage: ${options.usage}`, 'info')
        return
      }
      const run = parsed as Parsed
      const mode = await resolveMode(pi, ctx.cwd)
      let ref: string
      if (options.resolveRef !== undefined) {
        ref = await options.resolveRef(run, mode)
      } else {
        ref = await resolvePhaseRef(run as Parsed & ParsedRef, mode)
      }
      const base = await commandPhaseInput(pi, {
        mode,
        ref,
        cwd: ctx.cwd,
        onResearchFallback:
          options.onResearchFallback === undefined
            ? undefined
            : (jiraId) => options.onResearchFallback?.(jiraId, ctx),
      })
      const extra =
        options.extraInput === undefined
          ? {}
          : await options.extraInput({ parsed: run, mode, ref, ctx })
      const result = await buildPhasePrompt(options.name, { ...base, ...extra })
      sendOrNotify(pi, ctx, options.name, ref, result)
    },
  })
}

function researchOverrideOf(
  parsed: Exclude<ResearchArgs, { kind: 'help' }>,
): ResearchOverride {
  if (parsed.kind === 'debug') {
    return { kind: 'debug', text: parsed.symptom }
  }
  if (parsed.forceRef === true) {
    return { kind: 'feature', text: parsed.topic, refHint: 'force' }
  }
  return { kind: 'feature', text: parsed.topic, refHint: 'explicit' }
}

export function registerPhaseCommands(pi: ExtensionAPI): void {
  // AIDEV-NOTE: Prompt prep lives in flow/phase-prompts.ts (shared with the
  // /flow loop). The ticket-creation gate lives in the agent prompt — the
  // command itself never creates tickets. See research/ticket-gate.ts.
  // Ticket refs (ID=<jira-id>, or bare jira-shaped in work mode) resolve
  // aven-first via findEpicRef and skip the creation gate — see
  // research/refs.ts.
  registerPhaseCommand(pi, {
    name: 'research',
    description:
      'RPIV research phase. Usage: /research <topic> | /research ID=<jira-id> | /research --debug <symptom>',
    usage:
      '/research <topic> | /research ID=<jira-id> | /research --debug <symptom>',
    parse: parseResearchArgs,
    resolveRef: async (parsed) => {
      if (parsed.kind === 'debug') return parsed.symptom
      return parsed.topic
    },
    extraInput: async ({ parsed }) => ({
      research: researchOverrideOf(parsed),
    }),
    onResearchFallback: (jiraId, ctx) => {
      ctx.ui.notify(
        `/research ${jiraId}: no aven epic or synced ticket found — research falls back to the Jira ticket via acli`,
        'info',
      )
    },
  })

  // AIDEV-NOTE: Work mode routes to the user's feature-plan-aven skill by
  // name; personal mode runs the size-check flow. Decomposition only via
  // plan/split-gate.ts after explicit confirm.
  registerPhaseCommand(pi, {
    name: 'plan',
    description:
      'RPIV plan phase. Usage: /plan <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    usage: '/plan <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    parse: parsePlanArgs,
  })

  // AIDEV-NOTE: Gate wiring lives in implement/routing.ts via
  // buildPhasePrompt('implement'). Labels fetched fail-closed (aven failure
  // -> empty labels -> routing refuses). --skip-research must leave durable
  // label state — gates read labels, never notes — so later invocations
  // never re-demand it.
  registerPhaseCommand(pi, {
    name: 'implement',
    description:
      'RPIV implement phase. Usage: /implement <jira-id | aven-ref | aven:<ref> | jira:<key>> [--skip-research]',
    usage:
      '/implement <jira-id | aven-ref | aven:<ref> | jira:<key>> [--skip-research]',
    parse: parseImplementArgs,
    extraInput: async ({ parsed, ref }) => {
      const labels = (await readAvenLabels(ref)) ?? []
      if (parsed.skipResearch && needsResearchSkip(labels)) {
        await writeAvenLabel(ref, 'research-skipped')
      }
      return {
        skipResearch: parsed.skipResearch,
        labels,
        epicHasOpenChildren: await epicHasOpenChildren(ref),
      }
    },
  })

  // AIDEV-NOTE: Work mode resolves the sh-devctl scripts dir from the first
  // configured workRoot (validate/paths.ts) inside buildPhasePrompt; missing
  // workRoots blocks loudly. Personal mode (PMR-8449) never hits the work gate.
  registerPhaseCommand(pi, {
    name: 'validate',
    description:
      'RPIV validate phase. Usage: /validate <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    usage: '/validate <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    parse: parseValidateArgs,
  })

  // AIDEV-NOTE: Work mode runs the /sonarqube + /pr-quality gate via the
  // prompt; personal mode runs /review + the outcome-summary-then-done flow.
  // All gating rules live in the pure feedback/triage.ts and the prompt text.
  registerPhaseCommand(pi, {
    name: 'feedback',
    description:
      'RPIV feedback phase. Usage: /feedback <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    usage: '/feedback <jira-id | aven-ref | aven:<ref> | jira:<key>>',
    parse: parseFeedbackArgs,
  })
}
