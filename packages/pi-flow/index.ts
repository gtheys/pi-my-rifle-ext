import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  type AgentToolResult,
  CONFIG_DIR_NAME,
  getAgentDir,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent'
import { hasLiveAssignmentForParent } from '@gtheys/pi-interactive-subagents'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { parseFeedbackArgs } from './feedback/args.ts'
import { parseFlowArgs } from './flow/args.ts'
import { resolveAvenRef } from './flow/aven-resolve-exec.ts'
import { classifyLabelFailure } from './flow/ensure-labels.ts'
import {
  type AvenRunner,
  findJiraEpic,
  findTicketResearchTarget,
  resolveJiraEpic,
} from './flow/jira-ref.ts'
import {
  checkPhaseCompletion,
  lifecycleLabelMutation,
} from './flow/label-gate.ts'
import { landDecision, landingBashBlock } from './flow/land-gate.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase, PHASE_LABEL, type Phase } from './flow/orchestrate.ts'
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
import {
  type AttemptResult,
  MAX_ATTEMPTS,
  nextAttempt,
  type RetryState,
  startRetry,
} from './implement/retry.ts'
import { ALL_LABELS } from './phase-state.ts'
import { parsePlanArgs } from './plan/args.ts'
import { parseResearchArgs } from './research/args.ts'
import { findResearchedArtifact } from './research/artifact.ts'
import { recordRunEvent, runStatePath } from './run-state.ts'
import { parseSpecReviewArgs } from './spec-review/args.ts'
import { listSpecsInReview, readPlanPath } from './spec-review/aven-spec.ts'
import { openFileInPane } from './spec-review/open-in-pane.ts'
import { pickSpecs } from './spec-review/picker.ts'
import { buildReviewPrompt } from './spec-review/prompt.ts'
import {
  buildPublishWorkerTask,
  resolvePublishRoot,
  spawnPublishWorker,
} from './spec-review/publish.ts'
import { parseSpecPublishArgs } from './spec-review/publish-args.ts'
import { parseValidateArgs } from './validate/args.ts'
import { modeForToplevel, type WorkMode } from './work-mode.ts'

const execFileAsync = promisify(execFile)
const AVEN_TIMEOUT_MS = 5_000

// AIDEV-NOTE: PMR-5900 — aven ref resolution must not depend on implicit
// cwd inference. The first ref-scoped aven call per ref resolves the
// workspace (see flow/aven-resolve-exec.ts) and memoizes it; later calls
// for the same ref reuse it. `avenWorkspace` config overrides everything.
const resolvedRefWorkspaces = new Map<string, string | undefined>()
let avenWorkspaceOverride: string | undefined
let overrideLoaded = false
let lastAvenFailure: string | undefined

export function lastAvenResolutionFailure(): string | undefined {
  return lastAvenFailure
}

function recordAvenFailure(error: unknown): void {
  lastAvenFailure = error instanceof Error ? error.message : String(error)
}

async function avenOverrideArg(): Promise<string[]> {
  if (!overrideLoaded) {
    overrideLoaded = true
    const config = await loadConfig(process.cwd())
    avenWorkspaceOverride = config.avenWorkspace
  }
  if (avenWorkspaceOverride !== undefined) {
    return ['--workspace', avenWorkspaceOverride]
  }
  return []
}

async function avenArgsWithWorkspace(
  args: string[],
  ref: string,
): Promise<string[]> {
  const override = await avenOverrideArg()
  if (override.length > 0) return [...args, ...override]
  if (!resolvedRefWorkspaces.has(ref)) {
    const resolved = await resolveAvenRef(ref, avenExec)
    if (!resolved.ok) throw new Error(resolved.reason)
    resolvedRefWorkspaces.set(ref, resolved.workspace)
  }
  const workspace = resolvedRefWorkspaces.get(ref)
  if (workspace !== undefined) {
    return [...args, '--workspace', workspace]
  }
  return args
}

// AIDEV-NOTE: Shared aven helpers (labels are the run state, notes are the
// halt record). Used by the /implement and /flow command handlers and by the
// flow loop deps — one parsing path, fail-closed (null/[] on any failure).
export async function readAvenLabels(ref: string): Promise<string[] | null> {
  try {
    const args = await avenArgsWithWorkspace(['show', ref, '--json'], ref)
    const { stdout } = await execFileAsync('aven', args, {
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
  } catch (error: unknown) {
    recordAvenFailure(error)
    return null
  }
}

export async function writeAvenNote(
  ref: string,
  text: string,
): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(['note', ref, text], ref)
    await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch (error: unknown) {
    recordAvenFailure(error)
    return false
  }
}

// AIDEV-NOTE: Structural input for the implement routing guard — an open
// epic tree is plan-route work regardless of type labels. Fail-open on aven
// errors (label-based routing stays the primary contract).
export async function epicHasOpenChildren(ref: string): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(
      ['epic', 'list', ref, '--json'],
      ref,
    )
    const { stdout } = await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    const parsed: unknown = JSON.parse(stdout)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { children?: unknown }).children)
    )
      return (parsed as { children: { open?: unknown }[] }).children.some(
        (c) => c.open === true,
      )
    return false
  } catch (error: unknown) {
    recordAvenFailure(error)
    return false
  }
}

export async function writeAvenLabel(
  ref: string,
  label: string,
): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(
      ['edit', ref, '--label', label],
      ref,
    )
    await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch (error: unknown) {
    recordAvenFailure(error)
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
  avenWorkspace: Type.Optional(
    Type.String({
      description:
        'Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and search fallback)',
    }),
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

// AIDEV-NOTE: Best-effort label bootstrap — label creation must never break
// startup (PMR-SE93). Failures are classified (flow/ensure-labels.ts):
// aven-missing → one visible warning; already-exists → silent; anything else
// → surfaced warning with stderr. The override targets the same workspace the
// ref-resolution path uses when `avenWorkspace` is configured; without it,
// cwd inference is the only option here (no ref is known at session_start).
export async function ensureLabels(
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void,
): Promise<void> {
  let override: string[]
  try {
    override = await avenOverrideArg()
  } catch {
    override = []
  }
  let avenMissing = false
  const otherFailures: string[] = []
  for (const label of ALL_LABELS) {
    try {
      await execFileAsync('aven', ['label', 'create', label, ...override], {
        timeout: AVEN_TIMEOUT_MS,
      })
    } catch (error: unknown) {
      const failure = classifyLabelFailure(error)
      if (failure.kind === 'aven-missing') {
        avenMissing = true
      } else if (failure.detail !== undefined) {
        otherFailures.push(`aven label create ${label}: ${failure.detail}`)
      }
    }
  }
  if (avenMissing) {
    notify?.(
      'phase labels unavailable; gates will fail-closed until aven is on PATH',
      'warning',
    )
  }
  for (const failure of otherFailures) {
    notify?.(failure, 'warning')
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
  notifyResearchFallback?: (jiraId: string) => void,
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
    // AIDEV-NOTE: read-only ticket lookup for ticket research — jira-ref epic
    // first (labels land there, /flow resumes clean), then the jira-key synced
    // ticket (no acli needed). Neither → acli branch, announced via
    // notifyResearchFallback so an acli-first run never looks like aven was
    // skipped.
    findTicketRef: async (jiraId) => {
      const found = await findTicketResearchTarget(jiraId, avenExec)
      if (found.kind === 'none') notifyResearchFallback?.(jiraId)
      if (found.kind === 'epic' || found.kind === 'synced') {
        return { kind: found.kind, ref: found.ref }
      }
      return null
    },
  }
}

export default function (pi: ExtensionAPI) {
  // AIDEV-NOTE: ui.notify holder — command and event handlers each get their
  // own ctx; the loop needs one stable notify. session_start fires before any
  // command or agent_settled event, so the holder is always populated by then.
  let notifyUser:
    | ((message: string, level: 'info' | 'warning' | 'error') => void)
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
    epicHasOpenChildren: (ref) => epicHasOpenChildren(ref),
    hasInFlightSubagent: () => hasLiveAssignmentForParent(process.pid),
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
    void ensureLabels(notifyUser)
  })

  // AIDEV-NOTE: PMR-EZHA — enforcement boundary for lifecycle run state.
  // Aven lifecycle labels (LIFECYCLE_LABELS) are written ONLY through the
  // flow_phase_complete tool below, which re-checks the pure gates
  // (flow/label-gate.ts over gates.ts / orchestrate.ts) before exec'ing aven.
  // Direct agent-side mutation is blocked at the bash tool_call event — the
  // ExtensionAPI does offer real interception (handler returns {block,
  // reason}), so no guard-wrapper fallback script is needed. The boundary is
  // the agent's bash TOOL: a human running aven by hand is out of scope
  // (humans own the run). Type/skip labels (bug, oneshot, plan,
  // research-skipped) stay agent-writable.
  // AIDEV-NOTE: PMR-06RH — landing interceptor. `git push` / `gh pr create`
  // are blocked ONLY while the flow loop has an active ref, and only until
  // flow_land authorizes that ref's landing (authorizedLanding). No flow
  // active → undefined → normal git use outside pi-flow is never touched.
  // A human running git by hand is out of scope (humans own the run).
  let authorizedLanding: string | null = null
  pi.on('tool_call', (event) => {
    if (!isToolCallEventType('bash', event)) return undefined
    const label = lifecycleLabelMutation(event.input.command)
    if (label !== null) {
      return {
        block: true,
        reason: `lifecycle label "${label}" is extension-governed — call the flow_phase_complete tool instead of writing aven labels directly`,
      }
    }
    const activeRef = loop.activeRef()
    if (activeRef === null || authorizedLanding === activeRef) return undefined
    const landing = landingBashBlock(event.input.command, activeRef)
    if (landing === null) return undefined
    return { block: true, reason: landing }
  })

  // AIDEV-NOTE: PMR-EZHA — the ONLY sanctioned write path for lifecycle
  // labels. Reads labels, consults the pure gate (checkPhaseCompletion), and
  // on refusal returns the gate reason as a tool error; on success execs the
  // same writeAvenLabel path the flow loop uses. Idempotent: an
  // already-complete phase returns ok without re-writing.
  const phaseResultDetails = {
    ok: false,
    refused: false,
    already: false,
    reason: '',
    label: '',
  }
  type PhaseResultDetails = typeof phaseResultDetails
  pi.registerTool({
    name: 'flow_phase_complete',
    label: 'flow phase complete',
    description:
      'Record completion of an RPIV flow phase by applying its lifecycle label (research=researched, plan=planned, implement=active, validate=review-passed, feedback=done). The gate re-checks phase order and refuses out-of-order completion with the reason. This is the ONLY way to write lifecycle labels — direct aven label edits on the ticket are blocked.',
    promptSnippet:
      'Gated lifecycle-label completion for RPIV flow phases (research/plan/implement/validate/feedback).',
    promptGuidelines: [
      'Call flow_phase_complete to close a flow phase — never run `aven edit <ref> --label <lifecycle>` yourself; that mutation is blocked.',
      'A refusal carries the gate reason (missing prior phase); run the missing phase, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      phase: Type.Union(
        [
          Type.Literal('research'),
          Type.Literal('plan'),
          Type.Literal('implement'),
          Type.Literal('validate'),
          Type.Literal('feedback'),
        ],
        {
          description: 'The flow phase being marked complete',
        },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: string; phase: Phase },
    ): Promise<AgentToolResult<PhaseResultDetails>> {
      const labels = await readAvenLabels(params.ref)
      if (labels === null) {
        return {
          content: [
            {
              type: 'text',
              text: `flow_phase_complete: cannot read aven labels for ${params.ref} (fail-closed)`,
            },
          ],
          details: {
            ok: false,
            refused: false,
            already: false,
            reason: '',
            label: '',
          } satisfies PhaseResultDetails,
          isError: true,
        }
      }
      const gate = checkPhaseCompletion(params.phase, labels)
      if (!gate.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `flow_phase_complete refused phase "${params.phase}" on ${params.ref}: ${gate.reason}`,
            },
          ],
          details: {
            ok: false,
            refused: true,
            already: false,
            reason: gate.reason ?? '',
            label: '',
          } satisfies PhaseResultDetails,
          isError: true,
        }
      }
      const label = PHASE_LABEL[params.phase]
      if (labels.includes(label)) {
        return {
          content: [
            {
              type: 'text',
              text: `flow_phase_complete: "${label}" already recorded on ${params.ref} — phase ${params.phase} was already complete`,
            },
          ],
          details: {
            ok: true,
            refused: false,
            already: true,
            reason: '',
            label,
          } satisfies PhaseResultDetails,
        }
      }
      const written = await writeAvenLabel(params.ref, label)
      if (!written) {
        return {
          content: [
            {
              type: 'text',
              text: `flow_phase_complete: aven write failed for "${label}" on ${params.ref}`,
            },
          ],
          details: {
            ok: false,
            refused: false,
            already: false,
            reason: '',
            label: '',
          } satisfies PhaseResultDetails,
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `flow_phase_complete: "${label}" landed on ${params.ref} — phase ${params.phase} recorded, the label is verified by this result`,
          },
        ],
        details: {
          ok: true,
          refused: false,
          already: false,
          reason: '',
          label,
        } satisfies PhaseResultDetails,
      }
    },
  })

  // AIDEV-NOTE: PMR-06RH — the ONLY sanctioned landing path for a flow run.
  // Re-checks the review gate at the landing boundary via the pure
  // landDecision (flow/land-gate.ts): 'review-passed' label required, and when
  // the agent supplies the review artifact its blockers_count verdict is
  // cross-checked. On ok, the ref's landing is authorized so the subsequent
  // git push / gh pr create passes the interceptor. Route is recorded, not
  // re-derived: mode detection stays the phase prompts' concern.
  pi.registerTool({
    name: 'flow_land',
    label: 'flow land',
    description:
      'Gate a flow landing: verifies the review-passed label (and an optional review artifact verdict) for the ref, then authorizes git push (route=push-main) or gh pr create (route=pr) for it. Direct git push / gh pr create before this tool returns ok are blocked while the flow is active.',
    promptSnippet:
      'Gated landing for RPIV flow runs — call before pushing the branch or creating the PR.',
    promptGuidelines: [
      'Call flow_land AFTER flow_phase_complete(phase="validate") and BEFORE git push / gh pr create — direct landing commands are blocked until it returns ok.',
      'A refusal carries the gate reason (missing review-passed label, blockers in the artifact); fix the cause, do not retry the call.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      route: Type.Union([Type.Literal('pr'), Type.Literal('push-main')], {
        description:
          'pr: create a PR via gh (work mode). push-main: push straight to main (personal mode).',
      }),
      artifact: Type.Optional(
        Type.String({
          description:
            'The review artifact text (must contain "blockers_count: <N>") — cross-checked when provided',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        route: 'pr' | 'push-main'
        artifact?: string
      },
    ): Promise<AgentToolResult<{ ok: boolean; reason: string }>> {
      const labels = await readAvenLabels(params.ref)
      const decision = landDecision(labels, params.artifact ?? null)
      if (!decision.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `flow_land refused landing ${params.ref} via ${params.route}: ${decision.reason}`,
            },
          ],
          details: { ok: false, reason: decision.reason },
          isError: true,
        }
      }
      authorizedLanding = params.ref
      return {
        content: [
          {
            type: 'text',
            text: `flow_land: landing for ${params.ref} authorized via ${params.route} — run the git push / gh pr create step now`,
          },
        ],
        details: { ok: true, reason: '' },
      }
    },
  })

  // AIDEV-NOTE: PMR-06RH — tooling-owned retry budget. The agent reports each
  // attempt's outcome here instead of counting in its head: the tool owns the
  // in-memory RetryState (per ref, per session — no persistence by design;
  // aven notes are the durable record) and nextAttempt decides retry vs
  // escalate. Escalation is surfaced as a tool error AND an aven note; after
  // it, further attempts for the ref are refused — only a human restarts
  // (clearing the state is a session restart or a passing attempt).
  const retryStates = new Map<string, RetryState>()
  pi.registerTool({
    name: 'flow_run_attempt',
    label: 'flow run attempt',
    description:
      'Record one test attempt for a flow task and get the retry decision from the owned budget (3 total attempts, then escalate). The 3rd failing attempt returns an escalation error — STOP and report to the human; further attempts are refused.',
    promptSnippet:
      'Retry-budget tracking for flow test attempts — report every attempt result here.',
    promptGuidelines: [
      'After EVERY test run in this phase, call flow_run_attempt with the outcome before deciding the next step — never count attempts yourself.',
      'An escalation result means STOP: report to the human, do not run further attempts.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      result: Type.Object({
        ok: Type.Boolean({ description: 'Whether the test attempt passed' }),
        lastError: Type.Optional(
          Type.String({ description: 'The failing test\u2019s error message' }),
        ),
        commands: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Commands run in this attempt',
          }),
        ),
        hypothesis: Type.Optional(
          Type.String({ description: 'What this attempt tried to change' }),
        ),
      }),
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        result: AttemptResult
      },
    ): Promise<AgentToolResult<{ ok: boolean; status: string }>> {
      const state = retryStates.get(params.ref) ?? startRetry()
      const transition = nextAttempt(state, params.result)
      if (transition.status === 'passed') {
        retryStates.delete(params.ref)
        return {
          content: [
            {
              type: 'text',
              text: `flow_run_attempt: tests passed for ${params.ref} — commit the green change`,
            },
          ],
          details: { ok: true, status: 'passed' },
        }
      }
      if (transition.status === 'retry') {
        retryStates.set(params.ref, transition.state)
        return {
          content: [
            {
              type: 'text',
              text: `flow_run_attempt: attempt ${transition.state.attempts}/${MAX_ATTEMPTS} failed for ${params.ref} — retry permitted (${MAX_ATTEMPTS - transition.state.attempts} left in budget)`,
            },
          ],
          details: { ok: false, status: 'retry' },
        }
      }
      const e = transition.escalation
      const note = `escalated after ${MAX_ATTEMPTS} failed attempts — commands: ${e.commands.join(' ; ') || 'none recorded'}; last error: ${e.lastError}; hypothesis: ${e.hypothesis}`
      const noted = await writeAvenNote(params.ref, note)
      // Keep the exhausted state so further reports keep escalating instead
      // of silently restarting the budget.
      retryStates.set(params.ref, { attempts: MAX_ATTEMPTS })
      return {
        content: [
          {
            type: 'text',
            text: `flow_run_attempt: retry budget exhausted for ${params.ref} — ESCALATE to the human. ${note}${noted ? '' : ' (aven note write FAILED — record this manually)'}`,
          },
        ],
        details: { ok: false, status: 'escalate' },
        isError: true,
      }
    },
  })

  // AIDEV-NOTE: The /flow advancement hook. agent_settled fires after a run
  // fully settles (blocking ask_user_question gates keep the run in flight,
  // so gates are never raced). Fire-and-forget subagents DO settle the run
  // mid-phase — their result arrives later as a steer — so the loop's
  // hasInFlightSubagent guard keeps those settles from halting the flow.
  // The loop re-reads aven labels and either injects the next phase prompt
  // or halts — advancement is code, not model.
  pi.on('agent_settled', () => {
    void loop.onSettled()
  })

  pi.registerCommand('research', {
    description:
      'RPIV research phase. Usage: /research <topic> | /research ID=<jira-id> | /research --debug <symptom>',
    // AIDEV-NOTE: Prompt prep lives in flow/phase-prompts.ts (shared with the
    // /flow loop). The ticket-creation gate lives in the agent prompt — the
    // command itself never creates tickets. See research/ticket-gate.ts.
    // Ticket refs (ID=<jira-id>, or bare jira-shaped in work mode) resolve
    // aven-first via findEpicRef and skip the creation gate — see
    // research/refs.ts.
    handler: async (args, ctx) => {
      const parsed = parseResearchArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /research <topic> | /research ID=<jira-id> | /research --debug <symptom>',
          'info',
        )
        return
      }
      const mode = await resolveMode(pi)
      let research: ResearchOverride
      if (parsed.kind === 'debug') {
        research = { kind: 'debug', text: parsed.symptom }
      } else if (parsed.forceRef === true) {
        research = { kind: 'feature', text: parsed.topic, refHint: 'force' }
      } else {
        research = { kind: 'feature', text: parsed.topic, refHint: 'explicit' }
      }
      const result = await buildPhasePrompt('research', {
        ...(await commandPhaseInput(
          pi,
          mode,
          research.text,
          false,
          [],
          (jiraId) => {
            ctx.ui.notify(
              `/research ${jiraId}: no aven epic or synced ticket found — research falls back to the Jira ticket via acli`,
              'info',
            )
          },
        )),
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
      const result = await buildPhasePrompt('implement', {
        ...(await commandPhaseInput(
          pi,
          mode,
          ref,
          parsed.skipResearch,
          labels,
        )),
        epicHasOpenChildren: await epicHasOpenChildren(ref),
      })
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
        // on the epic ref. refHint 'force': the research prompt resolves the
        // epic (research/refs.ts) instead of running the creation gate.
        research = { kind: 'feature', text: parsed.jiraId, refHint: 'force' }
        if (resolved.created) {
          ctx.ui.notify(
            `/flow ${parsed.jiraId}: pulled in local epic ${resolved.ref}`,
            'info',
          )
          // AIDEV-NOTE: pure-Jira research (acli fallback, no aven ref)
          // cannot land the "researched" label; inherit it from the prior
          // artifact so /flow resumes past research. Best-effort: a failed
          // label write just means flow halts at research as before.
          const { stdout: toplevel } = await pi.exec(
            'git',
            ['rev-parse', '--show-toplevel'],
            {},
          )
          const gitRoot = toplevel.trim()
          const artifact = await findResearchedArtifact(
            process.env.LLM_NOTES_ROOT,
            path.basename(gitRoot),
            gitRoot,
            parsed.jiraId,
          )
          if (artifact !== null) {
            const labeled = await writeAvenLabel(ref, 'researched')
            if (labeled) {
              await writeAvenNote(
                ref,
                `research inherited from prior pure-Jira artifact ${path.basename(artifact)} (no aven ref existed at research time)`,
              )
              ctx.ui.notify(
                `/flow ${parsed.jiraId}: prior research artifact ${path.basename(artifact)} found — marked ${ref} researched`,
                'info',
              )
            } else {
              ctx.ui.notify(
                `/flow ${parsed.jiraId}: prior research artifact ${path.basename(artifact)} found but the researched label write failed — flow halts at research`,
                'warning',
              )
            }
          }
        }
      } else {
        ref = parsed.ref
      }
      const labels = await readAvenLabels(ref)
      if (labels === null) {
        const detail =
          lastAvenResolutionFailure() ??
          'Check that the ref exists and aven is available.'
        ctx.ui.notify(
          `/flow ${ref}: cannot read aven labels — aborting (fail-closed). ${detail}`,
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
          ...(await commandPhaseInput(
            pi,
            mode,
            ref,
            parsed.skipResearch,
            [],
            (jiraId) => {
              ctx.ui.notify(
                `/flow ${jiraId}: no aven epic or synced ticket — research phase uses the acli fallback`,
                'info',
              )
            },
          )),
          research,
        },
      })
    },
  })

  // AIDEV-NOTE: /spec-review (PMR-MR36). ctx.ui.select is modal and blocks
  // the handler, so the picker collects a BATCH and ONE combined
  // sendUserMessage lands after the handler returns — review prompts never
  // interleave. Repo name = basename of the git toplevel (aven project).
  // Approval is never done here: the injected prompt makes the session the
  // reviewer and gates approval on the user's explicit "approve <REF>".
  pi.registerCommand('spec-review', {
    description:
      'Review specs in plan-state=review. Usage: /spec-review [--workspace <name>]',
    handler: async (args, ctx) => {
      const parsed = parseSpecReviewArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /spec-review [--workspace <name>] | /spec-review help',
          'info',
        )
        return
      }
      let toplevel = ''
      try {
        const out = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
        toplevel = out.stdout.trim()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/spec-review: not a git repo (${msg})`, 'warning')
        return
      }
      const project = path.basename(toplevel)
      const listed = await listSpecsInReview(avenExec, {
        project,
        workspace: parsed.workspace,
      })
      if (listed.kind === 'error') {
        ctx.ui.notify(`/spec-review: ${listed.reason}`, 'warning')
        return
      }
      if (listed.specs.length === 0) {
        ctx.ui.notify('no specs awaiting review', 'info')
        return
      }
      const outcome = await pickSpecs({
        specs: listed.specs,
        select: (title, options) => ctx.ui.select(title, options),
        resolvePlanPath: async (ref) => {
          const plan = await readPlanPath(avenExec, ref)
          if (plan.kind === 'error') return { ok: false, reason: plan.reason }
          if (plan.kind === 'none') {
            return {
              ok: false,
              reason: `${ref}: no plan-path metadata — skipped`,
            }
          }
          if (!existsSync(plan.planPath)) {
            return {
              ok: false,
              reason: `${ref}: plan file missing: ${plan.planPath}`,
            }
          }
          return { ok: true, planPath: plan.planPath }
        },
        onPicked: async (spec) => {
          const pane = await openFileInPane(pi, spec.planPath)
          if (!pane.details.ok) {
            const text = pane.content.map((c) => c.text).join('\n')
            ctx.ui.notify(`/spec-review: ${text}`, 'warning')
          }
        },
        onSkipped: (spec, reason) => {
          ctx.ui.notify(
            `/spec-review skipped ${spec.ref}: ${reason}`,
            'warning',
          )
        },
      })
      if (outcome.kind === 'error') {
        ctx.ui.notify(`/spec-review: ${outcome.reason}`, 'warning')
        return
      }
      if (outcome.picked.length === 0) {
        ctx.ui.notify('no specs selected for review', 'info')
        return
      }
      pi.sendUserMessage(buildReviewPrompt(outcome.picked))
    },
  })

  // AIDEV-NOTE: /spec-publish (PMR-MR36 subtask PMR-2D2X). Shared publish
  // for /spec-review approvals and feature-plan-aven sessions. Resolution +
  // task text are pure (publish.ts); the actual git work runs in a subagent
  // worker — push failure never rolls back an approval, it only notifies.
  pi.registerCommand('spec-publish', {
    description: 'Publish an approved spec plan. Usage: /spec-publish <REF>',
    handler: async (args, ctx) => {
      const parsed = parseSpecPublishArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify('Usage: /spec-publish <REF>', 'info')
        return
      }
      let toplevel = ''
      try {
        const out = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
        toplevel = out.stdout.trim()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/spec-publish: not a git repo (${msg})`, 'warning')
        return
      }
      const plan = await readPlanPath(avenExec, parsed.ref)
      if (plan.kind === 'error') {
        ctx.ui.notify(`/spec-publish: ${plan.reason}`, 'warning')
        return
      }
      if (plan.kind === 'none') {
        ctx.ui.notify(
          `/spec-publish: ${parsed.ref} has no plan-path metadata`,
          'warning',
        )
        return
      }
      if (!existsSync(plan.planPath)) {
        ctx.ui.notify(
          `/spec-publish: plan file missing: ${plan.planPath}`,
          'warning',
        )
        return
      }
      const config = await loadConfig(process.cwd())
      const mode = modeForToplevel(toplevel, config.workRoots)
      const resolved = resolvePublishRoot({
        repo: path.basename(toplevel),
        mode,
        planPath: plan.planPath,
        toplevel,
      })
      if (resolved.kind === 'error') {
        ctx.ui.notify(`/spec-publish: ${resolved.reason}`, 'warning')
        return
      }
      const outcome = await spawnPublishWorker(ctx, {
        ref: parsed.ref,
        repo: path.basename(toplevel),
        root: resolved.root,
        planFile: resolved.planFile,
        name: `spec-publish: ${parsed.ref}`,
        cwd: toplevel,
        task: buildPublishWorkerTask({
          ref: parsed.ref,
          repo: path.basename(toplevel),
          root: resolved.root,
          planFile: resolved.planFile,
          isFallback: resolved.isFallback,
        }),
      })
      const ok =
        outcome.includes('exited with code 0') &&
        !outcome.includes('PUBLISH FAILED') &&
        !outcome.includes('Publish manually')
      let severity: 'info' | 'warning' = 'info'
      if (!ok) severity = 'warning'
      ctx.ui.notify(outcome, severity)
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
