// AIDEV-NOTE: PMR-T22H — index.ts is wiring only. Boundaries: aven/client.ts
// owns every aven shell-out; config.ts owns config + mode resolution;
// tools/* own the four agent tools; flow/phase-command.ts owns the 5 phase
// commands; spec-review/commands.ts owns the spec commands. What stays here:
// the extension entrypoint, the enforcement interceptors, the flow loop
// wiring, and /flow + /herdr-sync + /flow-view + /flow-view-replay.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getAgentDir,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  hasLiveAssignmentForParent,
  listAssignments,
  onFlowSpawn,
} from '@gtheys/pi-interactive-subagents'
import {
  adhocCloseMain,
  adhocSettled,
  configureAdhoc,
  createAdhocTracker,
} from './adhoc/tracker.ts'
import {
  applyAvenErrorLabel,
  avenExec,
  discoverAvenPrefixes,
  ensureLabels,
  epicHasOpenChildren,
  lastAvenResolutionFailure,
  listReadyTickets,
  readAvenLabels,
  readFreshBlockers,
  readGateAnswer,
  readJiraRef,
  readPlanState,
  setAvenSessionCwd,
  writeAvenNote,
  writeGateAnswer,
} from './aven/client.ts'
import { listTicketStatuses } from './aven/status.ts'
import {
  loadConfig,
  resolveMode,
  resolveRunServerEnabled,
  saveViewerPlacement,
} from './config.ts'
import {
  type AnswerDeps,
  answerUsageText,
  executeFlowAnswer,
  parseFlowAnswerArgs,
} from './flow/answer.ts'
import { FLOW_USAGE, type FlowArgs, parseFlowArgs } from './flow/args.ts'
import { spawnJournalTarget } from './flow/attribution.ts'
import {
  type HealResult,
  healFlowBinding,
  recoveryCommand,
} from './flow/binding-heal.ts'
import { pushToGateway } from './flow/cost.ts'
import { createCostAutoPush } from './flow/cost-autopush.ts'
import {
  type FlowCostDeps,
  registerFlowCostCommand,
} from './flow/cost-command.ts'
import {
  type DurableRefDeps,
  deriveFlowRefs,
  deriveParkedCandidates,
  type ParkedCandidate,
} from './flow/durable-refs.ts'
import { mergeIntercept } from './flow/effect-gate.ts'
import type { OpenGate } from './flow/gates.ts'
import { collectOpenGates, createGateDeps } from './flow/gates.ts'
import { resolveJiraEpic } from './flow/jira-ref.ts'
import {
  lifecycleLabelMutation,
  receiptMetadataMutation,
} from './flow/label-gate.ts'
import { landingIntercept } from './flow/land-gate.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase } from './flow/orchestrate.ts'
import {
  commandPhaseInput,
  registerPhaseCommands,
} from './flow/phase-command.ts'
import {
  isPickerInvocation,
  planPickerOutcome,
  planTicketPickerOutcome,
  splitGateValue,
  TICKET_ROW_VALUE,
} from './flow/picker.ts'
import {
  type ReconcileCommandDeps,
  registerReconcileCommand,
} from './flow/reconcile-command.ts'
import { createReconcileDeps, listJournalRefs } from './flow/reconcile-deps.ts'
import {
  parseRefKind,
  registerAvenPrefixes,
  trackingRef,
} from './flow/ref-kind.ts'
import {
  mergeSeedInput,
  resumeSeedFromEvents,
  runInputRecord,
} from './flow/resume.ts'
import {
  planResumePickerOutcome,
  type ResumeSelection,
} from './flow/resume-picker.ts'
import {
  type DashboardToggleOutcome,
  initFlowWidget,
  refreshAfterSettle,
  refreshFlowWidget,
  toggleFlowDashboardPin,
  type WidgetAssignment,
} from './flow/widget.ts'
import {
  type FlowBindingSnapshot,
  type FlowWorktree,
  getActiveFlowRef,
  parseFlowBindingSnapshot,
  reactivateFlowRef,
  restoreFlowBinding,
  setActiveFlowRef,
  setBindingChangeListener,
} from './flow/worktree-context.ts'
import type { FlowDiagramDeps } from './flow-diagram/command.ts'
import {
  diagramStamp,
  registerFlowDiagramCommand,
} from './flow-diagram/command.ts'
import { loadHpRenderer } from './flow-diagram/vendor/harness-profiler/load.ts'
import {
  preflightRepo,
  resolveRepoRoot,
  resolveSessionRepoRoot,
  syncHerdrPlugin,
} from './herdr/sync.ts'
import {
  decidePlacement,
  FlowHerdrViewer,
  isValidRef,
  parseViewerPlacement,
  pluginVersionStatus,
} from './herdr/viewer.ts'
import { MODE_PROFILE } from './mode-profile.ts'
import { registerJiraCreateBranch } from './plan-tools/jira-branch-tool.ts'
import { registerResolveFeaturePath } from './plan-tools/resolve-feature-path.ts'
import { registerResolveNotesPath } from './plan-tools/resolve-notes-path.ts'
import { registerResolveSpecPath } from './plan-tools/resolve-spec-path.ts'
import prQualityExtension from './pr-quality/index.ts'
import reviewExtension from './review/review.ts'
import {
  createEffectJournal,
  type FlowRunEvent,
  projectRunState,
  readRunEvents,
  runStatePath,
} from './run-state.ts'
import { type ResumeConsumerDeps, resumeParkedRun } from './server/consumer.ts'
import { pendingDirPath } from './server/daemon.ts'
import { ensureDaemon } from './server/lifecycle.ts'
import {
  createDaemonAliveProbe,
  createEventWriter,
  type EventWriter,
} from './server/writer.ts'
import sonarqubeExtension from './sonarqube/sonarqube.ts'
import { registerSpecCommands } from './spec-review/commands.ts'
import { registerOpenInPane } from './spec-review/open-in-pane.ts'
import { registerTelemetry } from './telemetry/index.ts'
import { registerCodeReviewTool } from './tools/code-review.ts'
import { buildCodeReviewGatePrompt } from './tools/code-review-parse.ts'
import { registerDeviationReviewTool } from './tools/deviation.ts'
import { registerFlowSubmitTool } from './tools/flow-submit.ts'
import {
  createLandingState,
  defaultSuiteRunner,
  registerLandTool,
} from './tools/land.ts'
import { registerPhaseCompleteTool } from './tools/phase-complete.ts'
import { productionReviewDeps } from './tools/review-deps.ts'
import {
  createAttemptLedger,
  registerRunAttemptTool,
} from './tools/run-attempt.ts'
import { registerSpecApproveTool } from './tools/spec-approve.ts'
import {
  type CleanupFlowWorktreeSummary,
  cleanupFlowWorktree,
  default as worktreeExtension,
} from './worktree/index.ts'
import {
  refsFromRunsDir,
  resolveDoneWorktree,
  sweepMergedFlowWorktrees,
} from './worktree/sweep.ts'

// AIDEV-NOTE: test-facing export surface (PMR-T22H) — tests import these
// from index.ts; the implementations now live in the boundary modules.
export {
  readAvenLabels,
  readGateAnswer,
  setAvenSessionCwd,
  specApprove,
  writeGateAnswer,
} from './aven/client.ts'
export {
  loadConfig,
  readConfigFile,
  resolveMode,
  resolveRunServerEnabled,
  saveViewerPlacement,
} from './config.ts'

// AIDEV-NOTE: PMR-XTQQ — best-effort journal write seam. Writers route
// through the mode-aware writer: journal-only while the durable run server
// owns the projection (per-write liveness probe), today's full writer path
// when absent. Journal failures must never break a flow phase; aven labels
// remain the gate source of truth.

// AIDEV-NOTE: production wiring for the /flow answer dispatch lives INSIDE
// the extension closure below (makeAnswerDeps) so the answer path's journal
// appends route through the mode-aware writer seam.

// Shared by /flow dashboard and the alt+shift+d shortcut — one notify surface so the
// keyboard path and the command path always stay in parity.
type DashboardNotifyLevel = 'info' | 'warning' | 'error'
type DashboardNotifyCtx = {
  ui: { notify: (message: string, level?: DashboardNotifyLevel) => void }
}

function notifyDashboardOutcome(
  ctx: DashboardNotifyCtx,
  outcome: DashboardToggleOutcome,
): void {
  if (outcome === 'no-content') {
    ctx.ui.notify(
      'No flow content to show — the dashboard appears when a flow is active.',
      'info',
    )
  } else if (outcome === 'pinned') {
    ctx.ui.notify(
      'Flow dashboard pinned — /flow dashboard or alt+shift+d to hide.',
      'info',
    )
  } else {
    ctx.ui.notify('Flow dashboard hidden.', 'info')
  }
}

// AIDEV-NOTE: PMR-T9ZQ 3.1 — the seam now derives rich PARKED CANDIDATES
// (not bare refs): the cross-session resume paths must know the candidate's
// phase/status/owner/worktree history before they render the consent menu.
// Production defaults resolve the session gitRoot and scan the pending-run
// records; tests inject fakes via the optional second parameter.
export interface DurableRebindDeps {
  deriveCandidates: () => Promise<ParkedCandidate[]>
  heal: (ref: string, cwd: string) => Promise<HealResult>
}

// AIDEV-NOTE: PMR-T9ZQ — one-line decline notice for the resume picker: the
// session stays clean, the recovery commands are the whole message. Pure so
// the wiring test can pin the exact shape.
function resumeDeclineMessage(refs: string[]): string {
  let commands = ''
  for (let i = 0; i < refs.length; i++) {
    if (i > 0) {
      commands += ' / '
    }
    commands += recoveryCommand(refs[i])
  }
  return `pi-flow: resume declined — this session stays clean. Recover with ${commands}.`
}

// The consent prompt for a parked cross-session run. Select rows are
// rendered from flow/resume-picker.ts labels, so the title stays generic.
const RESUME_SELECT_TITLE = 'Parked flow runs in this repo — resume one?'

// AIDEV-NOTE: PMR-T9ZQ — the ctx surface askResumeThenArm needs. Structurally
// narrowed (same shape as pickReadyTicketRef) so command, session_start and
// agent_settled contexts all fit without importing Pi internals.
type ResumeAskCtx = {
  cwd: string
  hasUI: boolean
  ui: {
    notify(message: string, level?: 'info' | 'warning' | 'error'): void
    select(title: string, options: string[]): Promise<string | undefined>
  }
}

// AIDEV-NOTE: PMR-T9ZQ — module-level ask latch, per PROCESS (so a settle
// firing while a startup select is open can never stack a second prompt).
// askResumeThenArm flips it to 'asking' SYNCHRONOUSLY before awaiting
// ctx.ui.select and to 'done' after any completed ask (pick, cancel, or a
// fail-closed throw). The startup path calls askResumeThenArm unconditionally
// (every new session asks at most once anyway); the agent_settled belt-and-
// braces path (subtask 3.2) must gate on 'idle'.
type ResumeAskState = 'idle' | 'asking' | 'done'
let resumeAskState: ResumeAskState = 'idle'

// AIDEV-NOTE: PMR-DRKH — injectable IO seam for the session_start durable
// rebind (plan 3.1). Production defaults resolve the session gitRoot and
// scan the pending-run records (same construction as the worktreeExtension
// deriveFlowRefs wiring); tests inject fakes via the optional second
// parameter on the extension factory.
export default function (
  pi: ExtensionAPI,
  durableRebindDeps?: DurableRebindDeps,
) {
  // AIDEV-NOTE: PMR-XTQQ — runServer.enabled kill switch (default true).
  // Synced from config at session_start (deviation JKD6RFC0MYY3N29C: the
  // switch must be live from extension init, not only from the first /flow,
  // so a disabled session gets exactly today's full-writer/no-injection
  // behavior before any /flow ran) and re-synced at every /flow start.
  // false = the probe always reports absent (full-writer path permanently),
  // ensureDaemon never spawns, and the pending consumer is a no-op.
  let runServerEnabled = true
  // AIDEV-NOTE: PMR-XTQQ subtask 3.3 — in-process per-ref latch for the
  // pending-record consumer. Added on a successful consumption attempt
  // (before the /flow injection), cleared when the /flow start path runs so
  // a real rerun re-arms the consumer. agent_settled fires often; the latch
  // plus the rename-first ENOENT contract makes repeated settles no-ops.
  const resumeLatch = new Set<string>()
  // AIDEV-NOTE: the ref of the restored session binding (PMR-PJM0), when
  // one exists — the only ref the agent_settled consumer checks. session_start
  // fires before any settle, so this is always populated before use.
  // PMR-T9ZQ 3.2: a NULL boundRef no longer means "the settle path does
  // nothing" — it means this session owns no restored run, so the settle path
  // may run the consent picker for a late parked candidate (never a silent
  // rebind).
  let boundRef: string | null = null

  // AIDEV-NOTE: PMR-XTQQ subtask 3.3 — shared consumer deps. Pure-ish:
  // sender + io live behind these closures so tests never need a live pi.
  function resumeConsumerDeps(ref: string): ResumeConsumerDeps {
    return {
      ref,
      agentDir: getAgentDir(),
      pendingDir: pendingDirPath(getAgentDir()),
      enabled: () => runServerEnabled,
      loopActive: () => loop.isActive(),
      latch: resumeLatch,
      notify: (message, level) => {
        if (notifyUser !== null) notifyUser(message, level)
      },
      send: (message) => {
        pi.sendUserMessage(message, { expandPromptTemplates: true })
      },
    }
  }
  // AIDEV-NOTE: PMR-86NN + PMR-T9ZQ — single construction site for the
  // production durable-run scanner deps, shared by the two derive modes:
  // deriveFlowRefs (plain refs — the worktree bind self-heal seam) and
  // deriveParkedCandidates (rich records — the resume picker). One site so
  // the two can never drift. Resolves the session gitRoot at call time
  // (same `git rev-parse --show-toplevel` semantics as the sweep's journal
  // filter) and reuses the pendingDir construction from the resume
  // consumer; gitRoot resolution failure fails closed (null => empty list).
  const durableScanDeps = async (): Promise<DurableRefDeps | null> => {
    const gitRoot = await resolveSessionRepoRoot(pi)
    if (gitRoot === null) {
      return null
    }
    return {
      agentDir: getAgentDir(),
      pendingDir: pendingDirPath(getAgentDir()),
      io: {
        readdir: (dir) => readdir(dir),
        readFile: (p) => fs.readFile(p, 'utf8'),
      },
      readRunEvents: (agentDir, ref, io) => readRunEvents(agentDir, ref, io),
      gitRoot,
    }
  }
  const makeDeriveRefs = (): (() => Promise<string[]>) => {
    return async () => {
      const deps = await durableScanDeps()
      if (deps === null) {
        return []
      }
      return deriveFlowRefs(deps)
    }
  }
  // AIDEV-NOTE: PMR-T9ZQ 3.1 — production rich-candidate scanner for the
  // resume picker (same scan/filters as makeDeriveRefs, per the durable-refs
  // header note).
  const makeDeriveCandidates = (): (() => Promise<ParkedCandidate[]>) => {
    return async () => {
      const deps = await durableScanDeps()
      if (deps === null) {
        return []
      }
      return deriveParkedCandidates(deps)
    }
  }
  // AIDEV-NOTE: PMR-DRKH — production derive/heal IO for the session_start
  // durable rebind. Heal goes through the shared productionReviewDeps so the
  // resolver's verification chain (binding → aven note → herdr) is identical
  // to /code-review. Overridable via the extension factory's second param.
  // PMR-T9ZQ: the candidate list is rich now and NOTHING here runs before a
  // human picks Resume (see the session_start resume-picker gate below).
  const durableRebind: DurableRebindDeps = durableRebindDeps ?? {
    deriveCandidates: makeDeriveCandidates(),
    heal: (ref, cwd) => healFlowBinding(ref, productionReviewDeps(pi, cwd)),
  }
  const writer: EventWriter = createEventWriter(
    getAgentDir(),
    createDaemonAliveProbe(getAgentDir(), () => runServerEnabled),
  )

  async function journal(
    event: Parameters<typeof writer.record>[0],
  ): Promise<void> {
    await writer.record(event)
  }

  async function journalOnly(
    event: Parameters<typeof writer.recordJournalOnly>[0],
  ): Promise<void> {
    await writer.recordJournalOnly(event)
  }

  // AIDEV-NOTE: PMR-T9ZQ 3.1 — arm a CONSENTED cross-session resume: exactly
  // today's PMR-DRKH sequence, in order, but only ever reached behind the
  // picker gate. heal is conditional on candidate.hasWorktree — a run that
  // never journaled a worktree-create effect gets the plain restore info
  // and NEVER a heal-failed warning (kills the plan-phase noise). The config
  // sync stays BEFORE the consumer (JKD6RFC0MYY3N29C), and the whole gate
  // runs strictly before consumePending renames a pending record.
  async function armResumedRun(
    ctx: ResumeAskCtx,
    candidate: ParkedCandidate,
  ): Promise<void> {
    const ref = candidate.ref
    restoreFlowBinding({ ref, worktree: null })
    boundRef = ref
    if (candidate.hasWorktree) {
      try {
        const healed = await durableRebind.heal(ref, ctx.cwd)
        if (healed.ok) {
          ctx.ui.notify(
            `pi-flow: restored flow binding for ${ref} from the pending-run record. The /flow loop itself is not resumed — recover with ${recoveryCommand(ref)} if needed.`,
            'info',
          )
        } else {
          ctx.ui.notify(
            `pi-flow: restored flow binding for ${ref}, but the worktree heal failed (${healed.reason}). Recover with ${recoveryCommand(ref)}.`,
            'warning',
          )
        }
      } catch {
        ctx.ui.notify(
          `pi-flow: restored flow binding for ${ref}. Recover with ${recoveryCommand(ref)}.`,
          'info',
        )
      }
    } else {
      ctx.ui.notify(
        `pi-flow: restored flow binding for ${ref} (this run never bound a worktree). Recover with ${recoveryCommand(ref)} if needed.`,
        'info',
      )
    }
    try {
      const config = await loadConfig(ctx.cwd)
      runServerEnabled = resolveRunServerEnabled(config)
    } catch {
      // best-effort init; /flow re-syncs per start
    }
    await resumeParkedRun(resumeConsumerDeps(ref))
  }

  // The notify-only degradation shared by the headless plan and every
  // fail-closed path: one info line per candidate, nothing else.
  function notifyResumeFallback(ctx: ResumeAskCtx, lines: string[]): void {
    for (const line of lines) {
      ctx.ui.notify(line, 'info')
    }
  }

  // AIDEV-NOTE: PMR-T9ZQ 3.1 — the shared ask-then-arm gate for BOTH
  // cross-session resume paths (session_start's durable rebind here; the
  // agent_settled belt-and-braces path in subtask 3.2 reuses it verbatim).
  // The order is the contract: derive -> planResumePickerOutcome -> (UI
  // sessions only) ctx.ui.select -> armResumedRun on a resume pick. Nothing
  // binds, heals, consumes or injects before the human answers, and every
  // non-resume outcome fails CLOSED to a fully clean session: a decline/Esc
  // gets one info line listing the recovery commands, a headless context or
  // a throwing select gets the notify-only fallback lines. The module-level
  // ask latch is flipped synchronously around the await so overlapping
  // asks never stack two prompts in one process.
  async function askResumeThenArm(
    ctx: ResumeAskCtx,
    candidates: ParkedCandidate[],
  ): Promise<void> {
    let plan = planResumePickerOutcome(ctx.hasUI, candidates)
    if (plan.kind === 'menu') {
      if (resumeAskState === 'asking') {
        return
      }
      const labelToValue = new Map(plan.options.map((o) => [o.label, o.value]))
      resumeAskState = 'asking'
      let selection: ResumeSelection
      try {
        const picked = await ctx.ui.select(
          RESUME_SELECT_TITLE,
          plan.options.map((o) => o.label),
        )
        if (picked === undefined) {
          selection = { stage: 'resume-cancelled' }
        } else {
          selection = {
            stage: 'resume-picked',
            value: labelToValue.get(picked) ?? '',
          }
        }
      } catch {
        // select unavailable (a mode without a dialog implementation) or it
        // threw: fail closed — no consent was obtained, so surface the
        // plain-text recovery lines and leave the session clean. Re-planning
        // with hasUI=false is what turns this path into the same notify-only
        // shape the headless startup shows.
        resumeAskState = 'done'
        const closed = planResumePickerOutcome(false, candidates)
        if (closed.kind === 'fallback') {
          notifyResumeFallback(ctx, closed.lines)
        }
        return
      }
      resumeAskState = 'done'
      plan = planResumePickerOutcome(ctx.hasUI, candidates, selection)
    }
    if (plan.kind === 'fallback') {
      notifyResumeFallback(ctx, plan.lines)
      return
    }
    if (plan.kind === 'declined') {
      ctx.ui.notify(resumeDeclineMessage(plan.refs), 'info')
      return
    }
    if (plan.kind === 'resume') {
      await armResumedRun(ctx, plan.candidate)
    }
  }

  // AIDEV-NOTE: production wiring for the /flow answer dispatch (PMR-R5VB) —
  // the only place where human answers reach aven. `ctx` is the command
  // handler's context, structurally narrowed. Lives inside the extension
  // closure so appendJournal routes through the mode-aware writer seam
  // (journal-only while the durable run server owns the projection).
  // AIDEV-NOTE (yolo plan 1.2): shared ready-ticket picker IO for both the
  // zero-arg /flow picker ('tickets' plan) and the '/flow --yolo' shortcut.
  // Same planner (planTicketPickerOutcome), same select, same notify
  // outcomes; the callers differ only in the yolo bit they put on the
  // reassigned parsed ref. Returns the picked ref, or undefined when every
  // non-run outcome (fallback / none / failed / silent) already notified or
  // stayed silent and the handler must return.
  async function pickReadyTicketRef(
    ctx: {
      hasUI: boolean
      ui: {
        notify(message: string, level: 'info' | 'warning' | 'error'): void
        select(title: string, options: string[]): Promise<string | undefined>
      }
    },
    hadGates: boolean,
  ): Promise<string | undefined> {
    const tickets = await listReadyTickets()
    let ticketPlan = planTicketPickerOutcome(ctx.hasUI, hadGates, tickets)
    if (ticketPlan.kind === 'menu') {
      const labelToValue = new Map(
        ticketPlan.options.map((o) => [o.label, o.value]),
      )
      const picked = await ctx.ui.select(
        'Ready ticket — start a flow:',
        ticketPlan.options.map((o) => o.label),
      )
      if (picked === undefined) {
        ticketPlan = planTicketPickerOutcome(ctx.hasUI, hadGates, tickets, {
          stage: 'ticket-cancelled',
        })
      } else {
        ticketPlan = planTicketPickerOutcome(ctx.hasUI, hadGates, tickets, {
          stage: 'ticket-picked',
          ref: labelToValue.get(picked) ?? '',
        })
      }
    }
    if (ticketPlan.kind === 'fallback') {
      for (const line of ticketPlan.lines) {
        ctx.ui.notify(line, 'info')
      }
      return undefined
    }
    if (ticketPlan.kind === 'none') {
      ctx.ui.notify(ticketPlan.line, 'info')
      return undefined
    }
    if (ticketPlan.kind === 'failed') {
      const detail = lastAvenResolutionFailure() ?? 'aven unavailable'
      ctx.ui.notify(
        `pi-flow: could not list ready tickets (${detail}) — run \`aven list --ready\` to inspect, then /flow <ref> manually`,
        'warning',
      )
      return undefined
    }
    if (ticketPlan.kind === 'run') {
      return ticketPlan.ref
    }
    // 'silent' (cancel / lookup miss): notify nothing.
    return undefined
  }

  // AIDEV-NOTE (yolo plan 1.2): gate collection with the fail-closed warn
  // shared by the zero-arg picker and the /flow --yolo shortcut. Returns
  // null after warning when the runs dir / aven list read failed.
  async function collectGatesOrWarn(ctx: {
    ui: { notify(message: string, level: 'info' | 'warning' | 'error'): void }
  }): Promise<OpenGate[] | null> {
    let gates: OpenGate[] = []
    let failed = false
    try {
      gates = await collectOpenGates(createGateDeps(getAgentDir()))
    } catch {
      failed = true
    }
    if (failed) {
      ctx.ui.notify(
        'pi-flow: could not read open gates (runs dir / aven list failed) — run /flow answer <ref> <choice> manually',
        'warning',
      )
      return null
    }
    return gates
  }

  function makeAnswerDeps(ctx: {
    cwd: string
    ui: {
      notify(message: string, level: 'info' | 'warning' | 'error'): void
    }
  }): AnswerDeps {
    return {
      notify: (message, level) => ctx.ui.notify(message, level),
      writeGateAnswer: (ref, gate, choice) =>
        writeGateAnswer(ref, gate, choice),
      writeAvenNote: (ref, text) => writeAvenNote(ref, text),
      appendJournal: (event) => journalOnly(event),
      now: () => new Date().toISOString(),
    }
  }
  // AIDEV-NOTE: ui.notify holder — command and event handlers each get their
  // own ctx; the loop needs one stable notify. session_start fires before any
  // command or agent_settled event, so the holder is always populated by then.
  let notifyUser:
    | ((message: string, level: 'info' | 'warning' | 'error') => void)
    | null = null

  // main pi session file, refreshed on session_start; journaled per phase so
  // /flow-cost can attribute main-session cost (see flow/cost.ts)
  let mainSessionFile: string | null = null
  // late-bound: automatic cost push, built after the cost deps below
  let autoPushCost: ((ref: string) => Promise<void>) | null = null
  // late-bound: the telemetry handle only exists after registerTelemetry below
  let syncTelemetryFlowEnv: (() => void) | null = null
  // late-bound: same handle, used by the ad-hoc tracker for its run traces
  let telemetryHandle: ReturnType<typeof registerTelemetry> | null = null
  // AIDEV-NOTE: PMR-81SX 5.2 — late-bound worktree cleanup at flow done. The
  // wrapper is wired into the loop before the worktree extension has resolved
  // its effects journal; the impl is assigned right after registration so the
  // cleanup's effect declarations land in the SAME journal the worktree tool
  // itself uses.
  let onFlowDoneImpl:
    | ((
        ref: string,
        mode: 'work' | 'personal',
        worktree: FlowWorktree | undefined,
        // PMR-YG2N fix round — session repo root (undefined = process cwd).
        cwd: string | undefined,
      ) => Promise<CleanupFlowWorktreeSummary>)
    | null = null
  const loop = createFlowLoop({
    getSessionFile: () => mainSessionFile,
    onRunEnd: (ref) => {
      if (autoPushCost !== null) void autoPushCost(ref)
    },
    onFlowEnvChange: () => {
      if (syncTelemetryFlowEnv !== null) syncTelemetryFlowEnv()
    },
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
    readPlanState: (ref) => readPlanState(ref),
    hasFreshBlockers: (ref, since) => readFreshBlockers(ref, since),
    avenNote: (ref, text) => writeAvenNote(ref, text),
    // yolo 5.1 — best-effort `error` label on halted yolo runs (never
    // rejects; the loop additionally catches, belt and braces).
    avenLabel: (ref) => applyAvenErrorLabel(ref),
    // PMR-81SX 5.2 — wrapper never rejects (impl never throws either); the
    // loop additionally catches, belt and braces.
    onFlowDone: async (ref, mode, worktree) => {
      if (onFlowDoneImpl !== null) {
        try {
          // AIDEV-NOTE: PMR-YG2N fix round — the loop has no ctx, so the
          // done-path cwd falls back to the session repo root resolved from
          // the process cwd (no cwd arg), matching commandPhaseInput's
          // journal gitRoot semantics.
          const loopRoot = await resolveSessionRepoRoot(pi)
          let loopCwd: string | undefined
          if (loopRoot === null) {
            loopCwd = undefined
          } else {
            loopCwd = loopRoot
          }
          await onFlowDoneImpl(ref, mode, worktree, loopCwd)
        } catch {
          // never break the run end
        }
      }
    },
    epicHasOpenChildren: (ref) => epicHasOpenChildren(ref),
    hasInFlightSubagent: () => hasLiveAssignmentForParent(process.pid),
    setActiveRef: (ref) => {
      if (ref === null) {
        setActiveFlowRef(null)
      } else {
        reactivateFlowRef(ref)
      }
    },
    resetLandingState: () => {
      landingState.authorized = null
      landingState.humanReviewPassed = null
      landingState.mergeAuthorized = null
    },
    sendPrompt: (prompt) => {
      pi.sendUserMessage(prompt)
    },
  })

  // AIDEV-NOTE: PMR-HFK1 — spawn attribution journaling (PMR-C998). The
  // subagents extension emits spawn/resume/reattach events; while a flow run
  // is active we journal them as structured `spawn-record` events (no more
  // note text — note-text emission is retired by PMR-C998) so the later
  // flow-cost rollup can reconstruct child->subtask attribution even if env
  // stamps are lost (reassignments/takeovers included — cost follows whoever
  // actually did the work). No active run = nothing to attribute, ignore.
  // Best-effort: journal failures are already swallowed by the journal()
  // wrapper.
  onFlowSpawn((info) => {
    // AIDEV-NOTE: nested spawns — in a flow WORKER (scouts spawned by a plan
    // agent, ...) the loop is not running, but the worker inherited
    // PI_FLOW_REF, so its spawns still belong to that flow. Those records go
    // to the journal only (recordJournalOnly); the main process routes through
    // the mode-aware writer (journal-only while the daemon owns the
    // projection, full writer otherwise).
    const target = spawnJournalTarget(loop.activeRef(), process.env)
    if (target === null) return
    const { ref, nested } = target
    // AIDEV-NOTE: PMR-C998 — structured spawn-record instead of note text.
    // subtask / sessionFile are carried only when present (never empty
    // strings) so the reader can distinguish "unknown" from "known empty".
    const event: Extract<FlowRunEvent, { kind: 'spawn-record' }> = {
      kind: 'spawn-record',
      at: new Date().toISOString(),
      ref,
      childId: info.childId,
      name: info.name,
      spawnKind: info.kind,
    }
    if (info.subtask !== undefined && info.subtask !== '') {
      event.subtask = info.subtask
    }
    // AIDEV-NOTE (PMR-EA8X): sessionFile lets /flow-cost resolve child
    // sessions from the journal alone (PMR-C998: now a structured field on
    // the spawn-record instead of a note-text suffix; older notes without it
    // still fall back to the durable assignment records).
    if (info.sessionFile !== undefined && info.sessionFile !== '') {
      event.sessionFile = info.sessionFile
    }
    if (nested) {
      void journalOnly(event)
      return
    }
    void journal(event)
    // AIDEV-NOTE (PMR-ZGPY 3.2): widget refresh on subagent lifecycle change.
    void refreshFlowWidget()
  })

  // AIDEV-NOTE (PMR-ZGPY 3.2): flow-status widget wiring ONLY — lifecycle
  // and data collection live in flow/widget.ts. refreshFlowWidget() is
  // pulled from agent_settled + the onFlowSpawn hook; assignment filtering
  // to THIS process's children happens inside the widget via parentPid.
  initFlowWidget(pi, {
    readState: async () => {
      const ref = loop.activeRef()
      if (ref === null) return null
      const events = await readRunEvents(getAgentDir(), ref)
      if (events === null) return null
      return projectRunState(events)
    },
    listAssignments: () => {
      const assignments: WidgetAssignment[] = []
      for (const view of listAssignments()) {
        if (view.state === 'unknown') continue
        assignments.push({
          name: view.record.name,
          status: view.record.status,
          parentPid: view.record.claim.pid,
        })
      }
      return assignments
    },
    collectOpenGates: () => collectOpenGates(createGateDeps(getAgentDir())),
    parentPid: process.pid,
  })

  pi.on('session_start', (_event, ctx) => {
    notifyUser = (message, level) => ctx.ui.notify(message, level)
    mainSessionFile = ctx.sessionManager.getSessionFile() ?? null
    setAvenSessionCwd(ctx.cwd)
    void ensureLabels(notifyUser)
    // AIDEV-NOTE: PMR-F8HB — register this workspace's aven project
    // prefixes so bare Jira-shaped aven refs (PMR-2424) classify as aven
    // instead of colliding with JIRA_RE. Best-effort: aven unavailable or
    // no projects keeps the historical Jira-first heuristic.
    void discoverAvenPrefixes().then((prefixes) => {
      if (prefixes.length > 0) {
        registerAvenPrefixes(prefixes)
      }
    })
    // AIDEV-NOTE: PMR-PJM0 — rebuild the flow ref/worktree binding after
    // reload/restart from the last persisted session entry.
    let saved: FlowBindingSnapshot | null = null
    // AIDEV-NOTE: PMR-P2MK — getBranch() walks the current leaf path only, so
    // an abandoned fork's binding cannot win; entry data is shape-validated.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === 'pi-flow-binding') {
        const parsed = parseFlowBindingSnapshot(entry.data)
        if (parsed !== null) saved = parsed
      }
    }
    const savedRef = saved?.ref
    if (saved !== null && savedRef != null) {
      const restored = saved
      if (restored.worktree && !existsSync(restored.worktree.path)) {
        saved = { ref: savedRef, worktree: null }
      }
      restoreFlowBinding(restored)
      // AIDEV-NOTE: PMR-PJM0 + PMR-XTQQ subtask 3.3 — the /flow loop itself
      // is not resumed on reload, BUT when a parked run record exists for
      // this ref (durable run server parked it mid-loop), the consumer below
      // re-presents `/flow <ref>` automatically. Manual rerun stays the
      // fallback for the no-record / dropped-record path.
      notifyUser(
        `pi-flow: restored flow binding for ${savedRef}. The /flow loop itself is not resumed — if a parked run record exists it is re-presented automatically; otherwise rerun /flow ${savedRef} to continue phases.`,
        'info',
      )
      boundRef = savedRef
      // AIDEV-NOTE: PMR-XTQQ — sync the kill switch from config BEFORE the
      // consumer runs (deviation JKD6RFC0MYY3N29C): with runServer.enabled
      // false, resumeParkedRun must no-op (today's behavior) even though no
      // /flow has run in this session yet. Config read failure keeps the
      // enabled default — best-effort; /flow re-syncs per start and surfaces
      // config errors loudly there.
      void (async () => {
        try {
          const config = await loadConfig(ctx.cwd)
          runServerEnabled = resolveRunServerEnabled(config)
        } catch {
          // best-effort init; /flow re-syncs per start
        }
        await resumeParkedRun(resumeConsumerDeps(savedRef))
      })()
    } else {
      // AIDEV-NOTE: PMR-DRKH — durable resume PICKER gate when the PMR-PJM0
      // branch walk restored nothing (no pi-flow-binding entry on the leaf
      // path). PMR-T9ZQ rewrote the old automatic takeover: candidates are
      // derived as rich ParkedCandidates and handed to the shared
      // askResumeThenArm gate, which renders the consent menu (ctx.ui.select)
      // and binds / heals / consumes ONLY after a human picked Resume.
      // Zero candidates → silent (today's behavior); no UI, a declined pick,
      // Esc or a throwing select → fully clean session plus notify-only
      // recovery lines. A resumed pick runs the same heal + config-sync +
      // resumeParkedRun sequence as the PMR-PJM0 block above (config read
      // BEFORE the consumer, JKD6RFC0MYY3N29C), with the heal skipped
      // entirely for runs that never declared a worktree. The gate always
      // precedes consumePending, so a declined session never renames a
      // pending record. A new session re-arms the ask-once latch (the plan's
      // accepted per-process restart case).
      resumeAskState = 'idle'
      void (async () => {
        let candidates: ParkedCandidate[]
        try {
          candidates = await durableRebind.deriveCandidates()
        } catch {
          return
        }
        await askResumeThenArm(ctx, candidates)
      })()
    }
    setBindingChangeListener((snapshot) => {
      pi.appendEntry('pi-flow-binding', snapshot)
    })
    // AIDEV-NOTE: PMR-YG2N 4.1 — fire-and-forget sweep AFTER the restore
    // block + binding listener: a restored done binding is itself sweepable.
    runBackgroundSweep({ cwd: ctx.cwd })
  })

  // AIDEV-NOTE: PMR-EZHA — enforcement boundary for lifecycle run state.
  // Aven lifecycle labels (LIFECYCLE_LABELS) are written ONLY through the
  // flow_phase_complete tool (tools/phase-complete.ts), which re-checks the
  // pure gates (flow/label-gate.ts over gates.ts / orchestrate.ts) before
  // exec'ing aven. Direct agent-side mutation is blocked at the bash
  // tool_call event — the ExtensionAPI does offer real interception (handler
  // returns {block, reason}), so no guard-wrapper fallback script is needed.
  // The boundary is the agent's bash TOOL: a human running aven by hand is
  // out of scope (humans own the run). Type labels (bug, oneshot, plan) stay
  // agent-writable. PMR-R5VB (review blocker fix): the same tool_call
  // interceptor also blocks forged human receipts via bash metadata writes —
  // see receiptMetadataMutation below.
  // AIDEV-NOTE: PMR-06RH — landing interceptor. `git push` / `gh pr create`
  // are blocked ONLY while the flow loop has an active ref, and only until
  // flow_land authorizes that ref's landing (landingState). No flow active →
  // undefined → normal git use outside pi-flow is never touched. A human
  // running git by hand is out of scope (humans own the run).
  // AIDEV-NOTE: PMR-06RH — landing interceptor. `git push` / `gh pr create`
  // are blocked ONLY while the flow loop has an active ref, and only until
  // flow_land authorizes that ref's landing (landingState). PMR-VZEV: the
  // authorization is cleared after use — one flow_land ok authorizes ONE
  // landing command; the next push re-blocks. No flow active → normal git
  // use outside pi-flow is never touched. A human running git by hand is
  // out of scope (humans own the run).
  // AIDEV-NOTE: PMR-VDVJ phase 4 — merge-main interceptor (mergeIntercept):
  // the same matcher pair for the personal route. A merge-main ok pins
  // landingState.mergeAuthorized to the EXACT command flow_land returned;
  // only that exact command is allowed once (clear:true clears ONLY
  // mergeAuthorized — never authorized/humanReviewPassed, which belong to
  // the push one-shot), and any other merge form (different branch, -C
  // path, or extra flags) stays blocked while the flow is active.
  const landingState = createLandingState()
  pi.on('tool_call', (event) => {
    if (!isToolCallEventType('bash', event)) return undefined
    const label = lifecycleLabelMutation(event.input.command)
    if (label !== null) {
      return {
        block: true,
        reason: `lifecycle label "${label}" is extension-governed — call the flow_phase_complete tool instead of writing aven labels directly`,
      }
    }
    // AIDEV-NOTE: PMR-R5VB — receipt forge blocker. Writing aven metadata
    // spec-answer/review-answer (any value) or plan-state=approved directly
    // from the model's bash would forge a human receipt, reaching
    // spec_approve / flow_land merge-main without a human /flow answer.
    // receiptMetadataMutation (flow/label-gate.ts) gates those at this same
    // boundary; the extension's own aven writes (flow/answer.ts) bypass it
    // because they are not model tool calls.
    const metadata = receiptMetadataMutation(event.input.command)
    if (metadata !== null) {
      if (metadata === 'plan-state=approved') {
        return {
          block: true,
          reason:
            'plan-state=approved is extension-governed — approval transitions go through the receipt-gated spec_approve tool, which requires a human /flow answer first',
        }
      }
      return {
        block: true,
        reason: `aven metadata "${metadata}" is human-gated — the human records receipts with /flow answer <ref> <choice>; model-written receipts are not proof of anything`,
      }
    }
    const decision = landingIntercept(
      event.input.command,
      loop.activeRef(),
      landingState.authorized,
    )
    if (decision.action === 'block') {
      return { block: true, reason: decision.reason }
    }
    if (decision.clear) {
      landingState.authorized = null
      landingState.humanReviewPassed = null
    }
    const mergeDecision = mergeIntercept(
      event.input.command,
      loop.activeRef(),
      landingState.mergeAuthorized,
    )
    if (mergeDecision.action === 'block') {
      return { block: true, reason: mergeDecision.reason }
    }
    if (mergeDecision.clear) {
      landingState.mergeAuthorized = null
    }
    return undefined
  })

  registerPhaseCompleteTool(pi, undefined, writer)
  // AIDEV-NOTE: PMR-R5VB — merge-main's human-review gate also accepts the
  // durable aven answer (human-only /flow answer <ref> pass); the read is
  // fail-closed (null on failure -> marker-only evaluation).
  registerLandTool(
    pi,
    landingState,
    () => loop.activeRef(),
    defaultSuiteRunner,
    // AIDEV-NOTE: PMR-R5VB — readGateAnswer's AnswerChoice also allows
    // 'approve'/'reject' (other gates); narrow to this gate's vocabulary.
    async (ref) => {
      const answer = await readGateAnswer(ref, 'review')
      if (answer === 'pass') return 'pass' as const
      if (answer === 'fail') return 'fail' as const
      return null
    },
    undefined,
    undefined,
    writer,
    // AIDEV-NOTE: PMR-VDVJ — strict effect journal for route=pr's
    // declare-before-authorize gate; journal-only O_APPEND writes are
    // daemon-safe by design (the projection folds in on the next full write).
    createEffectJournal(getAgentDir()),
  )
  // AIDEV-NOTE: PMR-T8ZG — the human code-review gate (PMR-3ZY1): the
  // code_review tool shares landingState with flow_land so a pass recorded
  // here is visible to the later flow_land check (PMR-C6AK, not wired yet).
  registerCodeReviewTool(pi, landingState, undefined, undefined, writer)
  // AIDEV-NOTE: PMR-R9EN — the deviation gate is a registered tool so the
  // validate prompt can instruct the agent to CALL something (D3/D4) instead
  // of naming TS functions it cannot invoke.
  registerDeviationReviewTool(pi, writer)
  // AIDEV-NOTE: PMR-XTQQ 4.2 — the flow_run_attempt budget is durable: the
  // tool journals attempt-record snapshots through the mode-aware writer
  // (journal-only while the daemon owns the projection) and seeds from the
  // journal on first call per ref. Ledger io failures degrade to in-memory.
  registerRunAttemptTool(
    pi,
    createAttemptLedger(getAgentDir(), {
      record: async (event) => {
        // Outcome boolean intentionally discarded: the ledger is best-effort.
        await writer.record(event)
      },
    }),
  )
  // AIDEV-NOTE: PMR-CD46 — mode-aware writer so spec_approve receipt
  // writes route journal-only while the daemon owns the projection
  // (mirrors registerPhaseCompleteTool above).
  registerSpecApproveTool(pi, undefined, writer)
  // AIDEV-NOTE: PMR-C998 — advisory step-output journaling via flow_submit;
  // shares the mode-aware writer so journal writes stay daemon-safe.
  registerFlowSubmitTool(pi, { writer })
  // AIDEV-NOTE: PMR-XCA9 — plan-tools absorbed from the retired pi-planning
  // package (resolve_spec_path, resolve_feature_path, open_in_pane,
  // jira_create_branch; /review-spec lives in spec-review/commands.ts).
  registerResolveSpecPath(pi)
  registerResolveFeaturePath(pi)
  registerResolveNotesPath(pi)
  registerOpenInPane(pi)
  registerJiraCreateBranch(pi)

  // AIDEV-NOTE: PMR-W8SG — review/sonarqube/pr-quality absorbed from the
  // retired pi-review package. Each is a self-registering extension
  // entrypoint (own commands + agent tool); pi-review is deleted, so these
  // register exactly once, here.
  reviewExtension(pi, writer)
  sonarqubeExtension(pi)
  prQualityExtension(pi)

  // AIDEV-NOTE: PMR-K0ZV — worktree/ absorbed from the retired pi-worktree
  // package. Self-registering extension entrypoint (the `worktree` agent
  // tool); pi-worktree is deleted, so it registers exactly once, here. The
  // journal is created here so the flow-done cleanup (PMR-81SX 5.2) can
  // share the exact same instance.
  const worktreeEffects = createEffectJournal(getAgentDir())
  // AIDEV-NOTE: PMR-DRKH — worktree bind self-heal seam; the scanner is
  // the shared makeDeriveRefs() above (PMR-86NN).
  worktreeExtension(pi, {
    effects: worktreeEffects,
    deriveFlowRefs: makeDeriveRefs(),
  })

  // AIDEV-NOTE: PMR-YG2N 4.1 — background worktree sweep, latched fire-and-
  // forget. Latched because session_start and the /flow run path can both
  // trigger it within one session; the sweep itself is idempotent but the
  // aven execs it performs are not free, so a concurrent invocation is
  // dropped, not queued. Wiring only (PMR-T22H): all sweep logic lives in
  // worktree/sweep.ts.
  let sweepInFlight = false
  const runBackgroundSweep = (ctx: { cwd: string }): void => {
    if (sweepInFlight) {
      return
    }
    sweepInFlight = true
    const deps = {
      listRefs: async () => {
        try {
          const names = await readdir(join(getAgentDir(), 'pi-flow', 'runs'))
          return refsFromRunsDir(names)
        } catch {
          return []
        }
      },
      readEvents: async (ref: string) => {
        const events = await readRunEvents(getAgentDir(), ref)
        if (events === null) {
          return []
        }
        return events
      },
      appendEvent: (event: FlowRunEvent) => journal(event),
      readLabels: (ref: string) => readAvenLabels(ref),
      annotate: async (ref: string, body: string) => {
        await writeAvenNote(ref, body)
      },
      // AIDEV-NOTE: PMR-YG2N fix round — the sweep's gitRoot filter must
      // match the journal's gitRoot semantics (commandPhaseInput:
      // `git rev-parse --show-toplevel` from the session cwd), NOT
      // resolveRepoRoot()'s install-root value; a foreign-root journal ref
      // under the old wiring was silently noop'd with a terminal marker.
      // resolveSessionRepoRoot never throws; null (or a throw) makes the
      // sweep return quietly (fail-closed).
      sessionGitRoot: async () => resolveSessionRepoRoot(pi, ctx.cwd),
      notify: (message: string, level: 'info' | 'warning') => {
        if (notifyUser !== null) {
          notifyUser(message, level)
        }
      },
    }
    void sweepMergedFlowWorktrees(pi, worktreeEffects, ctx.cwd, deps)
      .catch(() => {})
      .finally(() => {
        sweepInFlight = false
      })
  }
  onFlowDoneImpl = async (ref, mode, worktree, cwd) => {
    // Loop contract is Promise<void>: the CleanupFlowWorktreeSummary is
    // intentionally discarded here (observability lives in the annotate
    // path inside cleanupFlowWorktree itself, PMR-W6C4).
    const summary = await cleanupFlowWorktree(pi, worktreeEffects, {
      ref,
      mode,
      worktree,
      // AIDEV-NOTE: PMR-YG2N fix round — the done-path cwd is the session
      // repo root supplied by the caller (/flow done branch passes ctx.cwd;
      // the loop wrapper passes resolveSessionRepoRoot(pi), process-cwd
      // semantics), replacing the PMR-82K0 resolveRepoRoot() install-root
      // value that mis-scoped cleanup in foreign repos.
      cwd,
      annotate: async (noteRef, body) => {
        await writeAvenNote(noteRef, body)
      },
    })
    // AIDEV-NOTE: PMR-YG2N 3.1 — best-effort worktree-sweep marker with the
    // flow-done source so later sweeps can skip terminal outcomes; routed
    // through the mode-aware writer seam (journal closure above).
    try {
      await journal({
        kind: 'worktree-sweep',
        at: new Date().toISOString(),
        ref,
        source: 'flow-done',
        outcome: summary.action,
        detail: summary.reason,
      })
    } catch {
      // a failed marker changes nothing else
    }
    return summary
  }

  // AIDEV-NOTE: The /flow advancement hook. agent_settled fires after a run
  // fully settles (blocking ask_user_question gates keep the run in flight,
  // so gates are never raced). Fire-and-forget subagents DO settle the run
  // mid-phase — their result arrives later as a steer — so the loop's
  // hasInFlightSubagent guard keeps those settles from halting the flow.
  // The loop re-reads aven labels and either injects the next phase prompt
  // or halts — advancement is code, not model.
  pi.on('agent_settled', (_event, ctx) => {
    // AIDEV-NOTE: PMR-2KH5 — the refresh must run AFTER the loop's settle
    // work: phase-complete/phase-start are journaled only inside onSettled
    // (after an aven readLabels shell-out) and the widget projects
    // currentPhase solely from journal events, so the old concurrent refresh
    // read the pre-transition journal and re-set the stale phase (footer a
    // turn behind; done/halt never refreshed). refreshAfterSettle chains the
    // refresh onto the settle promise. Still fire-and-forget: the extension
    // runner awaits handlers, so awaiting the shell-out here would stall
    // pi's idle resolution; the onSettled rejection stays unhandled, as
    // before (fail-noisy).
    void refreshAfterSettle(() => loop.onSettled())
    // AIDEV-NOTE (PMR-ZGPY 3.2): pull-based widget refresh — no fs.watch in
    // the flow process (ISC-A-3); the widget updates on settle signals.
    // AIDEV-NOTE: PMR-XTQQ subtask 3.3 — belt-and-braces consumer path. A
    // parked record for the restored binding is consumed + re-presented here
    // when session_start's check found nothing (e.g. the daemon parked the
    // run moments later). No-ops unless a binding exists; the consumer
    // itself guards loop-active / disabled / latch / nothing-pending.
    // PMR-2KH5 decision: resumeParkedRun stays CONCURRENT with the settle
    // refresh — it re-presents a parked prompt and never journals phase
    // events, so it cannot race the widget's journal read.
    const resumeRef = boundRef
    if (resumeRef !== null) {
      void resumeParkedRun(resumeConsumerDeps(resumeRef))
      return
    }
    // AIDEV-NOTE: PMR-T9ZQ 3.2 — belt-and-braces CONSENT gate for a LATE
    // parked candidate (the daemon parked the run after session_start's scan
    // found nothing, and a session with no binding used to let it stall
    // silently). boundRef === null now runs the SAME askResumeThenArm gate as
    // startup, once per process. Three guards carry the contract: the sync
    // door check (a settle landing while the startup picker is open never
    // stacks a second menu); the post-scan re-check (askResumeThenArm guards
    // 'asking' but never 'done', so an ask that completed during our scan
    // must not be spent again); and the live-binding check — a session that
    // started /flow HERE owns a run without boundRef being set (that var
    // only tracks the session_start restore), and adopting its own parked run
    // would drop a real worktree binding back to null. A headless fallback
    // never reaches a menu, so the latch is pinned here too — otherwise every
    // settle would re-print those recovery lines. Net effect: this path
    // reaches resumeParkedRun for NO ref that did not pass the gate.
    if (getActiveFlowRef() !== null || resumeAskState !== 'idle') {
      return
    }
    void (async () => {
      let candidates: ParkedCandidate[]
      try {
        candidates = await durableRebind.deriveCandidates()
      } catch {
        return
      }
      if (candidates.length === 0) {
        // nothing parked (yet): leave the latch armed for a later settle
        return
      }
      // the scan is async — a startup ask may have opened (or finished)
      // while it ran, so the latch is re-checked before spending the ask
      if (resumeAskState !== 'idle') {
        return
      }
      await askResumeThenArm(ctx, candidates)
      if (resumeAskState === 'idle') {
        resumeAskState = 'done'
      }
    })()
  })

  registerPhaseCommands(pi)
  registerSpecCommands(pi)

  // AIDEV-NOTE (PMR-EA8X): /flow-cost — offline per-ticket cost rollup from
  // the run journal + session files (the authority). --push forwards
  // aggregates to the Pushgateway when PI_FLOW_PUSHGATEWAY_URL is set
  // (endpoint override + bearer secret = the two env-var exceptions the
  // config rules allow); push failures warn, never fail.
  const costDeps: FlowCostDeps = {
    readRunEvents: (ref) => readRunEvents(getAgentDir(), ref),
    listAssignmentRecords: () => {
      const records: AssignmentRecord[] = []
      for (const view of listAssignments()) {
        if (view.state === 'unknown') continue
        records.push(view.record)
      }
      return records
    },
    readSessionFile: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    push: (ref, body, mode) => {
      const url = process.env.PI_FLOW_PUSHGATEWAY_URL
      if (url === undefined || url.length === 0) {
        return Promise.resolve({
          ok: false,
          error: 'PI_FLOW_PUSHGATEWAY_URL is not set',
        })
      }
      const token = process.env.PI_FLOW_PUSHGATEWAY_TOKEN
      return pushToGateway(
        url,
        ref,
        body,
        async (u, init) => {
          const response = await fetch(u, init)
          return { status: response.status, statusText: response.statusText }
        },
        token,
        mode,
      )
    },
  }
  registerFlowCostCommand(pi, costDeps)

  // AIDEV-NOTE (PMR-MSDJ 2.3): /flow-reconcile-push — the manual face of the
  // tombstone reconcile. Every seam is the DAEMON'S OWN wiring
  // (`flow/reconcile-deps.ts`): one env gate, one journal rule,
  // one aven call, so the two surfaces cannot disagree about what is stale.
  // The only session-side difference is the channel — `warn` lands in
  // `ctx.ui.notify` here instead of `server.log`, and `agentDir` is
  // `getAgentDir()` (Pi's own resolution) rather than the daemon's
  // PI_FLOW_AGENT_DIR. See flow/reconcile-command.ts for the mode/URL
  // semantics table (`--dry-run` answers WITHOUT a gateway, a real run does not).
  const reconcileDeps: ReconcileCommandDeps = {
    createEngineDeps: (warn) =>
      createReconcileDeps({ agentDir: getAgentDir(), warn }),
    listJournalRefs: () => listJournalRefs(getAgentDir()),
    readRunEvents: (ref) => readRunEvents(getAgentDir(), ref),
    listTicketStatuses: () => listTicketStatuses(),
  }
  registerReconcileCommand(pi, reconcileDeps)

  // AIDEV-NOTE (PMR-PVT5 4.2): /flow-diagram wiring — mirrors the costDeps
  // shapes (readRunEvents + filtered listAssignments + try/catch session
  // reads) and owns only the side effects: diagram write under
  // `<agentDir>/pi-flow/diagrams` with an injected-clock filename stamp, and
  // a best-effort xdg-open/open fallback that resolves false on anything
  // abnormal. Filename/patch logic lives in flow-diagram/command.ts; this
  // file stays wiring-only.
  const nowMs = (): number => Date.now()
  const flowDiagramDeps: FlowDiagramDeps = {
    readRunEvents: (ref) => readRunEvents(getAgentDir(), ref),
    listAssignmentRecords: () => {
      const records: AssignmentRecord[] = []
      for (const view of listAssignments()) {
        if (view.state === 'unknown') continue
        records.push(view.record)
      }
      return records
    },
    readSessionFile: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    loadRenderer: () => loadHpRenderer(),
    writeDiagram: async (ref, runIndex, html) => {
      const dir = join(getAgentDir(), 'pi-flow', 'diagrams')
      await fs.mkdir(dir, { recursive: true })
      const path = join(
        dir,
        `${ref}.run${runIndex}.${diagramStamp(nowMs())}.html`,
      )
      await fs.writeFile(path, html, 'utf8')
      return path
    },
    openDiagram: (path) => {
      // AIDEV-NOTE: try each opener in order; detached + stdio ignore, unref
      // the child, resolve false on spawn error or non-zero exit.
      const openers = ['xdg-open', 'open']
      const attempt = (index: number): Promise<boolean> => {
        if (index >= openers.length) return Promise.resolve(false)
        return new Promise((resolve) => {
          const child = spawn(openers[index] as string, [path], {
            detached: true,
            stdio: 'ignore',
          })
          child.on('error', () => {
            void attempt(index + 1).then(resolve)
          })
          child.on('spawn', () => {
            child.unref()
          })
          child.on('exit', (code) => {
            if (code === 0) {
              resolve(true)
            } else {
              void attempt(index + 1).then(resolve)
            }
          })
        })
      }
      return attempt(0)
    },
  }
  registerFlowDiagramCommand(pi, flowDiagramDeps)
  // AIDEV-NOTE: cost metrics are pushed automatically when a run ends (done,
  // halt, pause) — same env gate as `/flow-cost --push`; see flow/cost-autopush.ts.
  autoPushCost = createCostAutoPush({
    ...costDeps,
    enabled: () => (process.env.PI_FLOW_PUSHGATEWAY_URL ?? '').length > 0,
    notify: (message, level) => {
      if (notifyUser !== null) notifyUser(`flow-cost ${message}`, level)
    },
  })

  // AIDEV-NOTE: ad-hoc (/brainstorm, /pr-quality, /review) time + cost; see
  // adhoc/tracker.ts. Same env gate as the cost push: no URL = push fails
  // silently inside the tracker.
  configureAdhoc(
    createAdhocTracker({
      now: () => Date.now(),
      getSessionFile: () => mainSessionFile,
      readSession: costDeps.readSessionFile,
      flowActive: () => (process.env.PI_FLOW_REF ?? '').length > 0,
      trace: {
        begin: (run, nest) => telemetryHandle?.adhocBegin(run, nest),
        end: (run, attributes) => telemetryHandle?.adhocEnd(run, attributes),
      },
      push: async (runId, body) => {
        const url = process.env.PI_FLOW_PUSHGATEWAY_URL
        if (url === undefined || url.length === 0) return
        const headers: Record<string, string> = { 'content-type': 'text/plain' }
        const token = process.env.PI_FLOW_PUSHGATEWAY_TOKEN
        if (token !== undefined && token.length > 0) {
          headers.authorization = `Bearer ${token}`
        }
        await fetch(
          `${url.replace(/\/+$/, '')}/metrics/job/pi-flow-adhoc/run/${encodeURIComponent(runId)}`,
          { method: 'POST', headers, body },
        )
      },
    }),
  )
  pi.on('agent_settled', () => {
    void adhocSettled()
  })
  pi.on('session_shutdown', () => {
    void adhocCloseMain()
  })

  // AIDEV-NOTE (PMR-R8AG): OTLP telemetry, disabled by default. The
  // session_start probe resolves telemetry config (global + project merge,
  // same loader as everything else); null = zero subscriptions, zero
  // allocations. PI_FLOW_OTLP_TOKEN (env, never config) adds the bearer
  // header. Export failures journal at most ONE note per process — flow
  // runs must proceed identically with no backend at all.
  const telemetry = registerTelemetry(pi, {
    loadSettings: async (cwd) => {
      const config = await loadConfig(cwd)
      const telemetry = config.telemetry
      if (telemetry === undefined || !telemetry.enabled) return null
      const headers: Record<string, string> = { ...(telemetry.headers ?? {}) }
      const token = process.env.PI_FLOW_OTLP_TOKEN
      if (token !== undefined && token.length > 0) {
        headers.authorization = `Bearer ${token}`
      }
      return {
        endpoint: telemetry.otlpEndpoint,
        headers,
        captureContent: telemetry.captureContent,
        jiraBaseUrl: telemetry.jiraBaseUrl,
        maxContentChars: telemetry.maxContentChars,
      }
    },
    env: process.env,
    rng: { bytes: (n) => randomBytes(n) },
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init)
      return { status: response.status }
    },
    now: () => Date.now(),
    onExportFailure: (error) => {
      const ref = loop.activeRef()
      if (ref === null) return
      void journal({
        kind: 'note',
        at: new Date().toISOString(),
        ref,
        text: `telemetry export failed: ${error} (further failures silent)`,
      })
    },
  })
  syncTelemetryFlowEnv = telemetry.syncFlowEnv
  telemetryHandle = telemetry

  // AIDEV-NOTE: PMR-T8ZG — human entry point of the code-review gate. The
  // command resolves the ref and sends the gate prompt via sendUserMessage
  // (phase-command pattern); the code_review tool owns everything else.
  // Agents cannot invoke slash commands, which is exactly why the tool exists.
  pi.registerCommand('code-review', {
    description:
      'Run the human code-review gate for a flow ref. Usage: /code-review <jira-id | aven-ref>',
    handler: async (args, ctx) => {
      const raw = args.trim()
      if (raw === '') {
        ctx.ui.notify('Usage: /code-review <jira-id | aven-ref>', 'info')
        return
      }
      const kinded = parseRefKind(raw)
      let ref: string
      if (kinded.kind === 'jira') {
        ref = kinded.jiraId
      } else {
        ref = kinded.ref
      }
      pi.sendUserMessage(buildCodeReviewGatePrompt(ref))
    },
  })

  // AIDEV-NOTE: alt+shift+d is the keyboard twin of `/flow dashboard` — both
  // delegate to toggleFlowDashboardPin. Precedent: pi-prompt-snippets pairs
  // alt+s with /snippets. alt+d was rejected: it is a Pi built-in
  // (tui.editor.deleteWordForward), so the old registration shadowed it — the
  // earlier no-collision check only covered in-repo extensions, not built-ins.
  pi.registerShortcut('alt+shift+d', {
    description: 'Toggle the flow dashboard widget',
    handler: async (ctx) => {
      notifyDashboardOutcome(ctx, await toggleFlowDashboardPin(ctx))
    },
  })

  pi.registerCommand('flow', {
    description:
      'PIV run-all (plan -> implement -> validate -> feedback; personal feedback = wrap-up: outcome summary, done, auto worktree cleanup) or record a protected human decision. Usage: /flow <ref> [--yolo] | /flow --yolo (receipt gates skipped, personal mode only) | /flow answer <ref> <approve|reject|pass|fail> | /flow dashboard. Brainstorm topics go through /brainstorm. Completed-flow worktrees are cleaned up automatically (loop done, /flow rerun, or session/flow-start sweep) and are never deleted while dirty, in flight, or unproven.',
    // AIDEV-NOTE: Aven IS the run state — labels fetched fail-closed (aven
    // failure aborts, never starts mid-phase by accident). nextPhase()
    // resolves the first phase whose completion label is missing, then the
    // extension-owned loop (flow/loop.ts) takes over: it injects ONE phase
    // prompt at a time (same builder the phase commands use) and advances on
    // agent_settled when the phase label lands. No driver agent — the model
    // never sequences phases.
    handler: async (args, ctx) => {
      const answerParsed = parseFlowAnswerArgs(args)
      if (answerParsed.kind === 'answer-help') {
        ctx.ui.notify(answerUsageText, 'info')
        return
      }
      if (answerParsed.kind === 'answer') {
        // AIDEV-NOTE: PMR-R5VB — /flow answer is the HUMAN-ONLY decision
        // recorder. Slash commands run before the agent loop (extensions.md),
        // and this path must never call pi.sendUserMessage: the work runs and
        // returns (same shape as /herdr-sync below), so no model turn is ever
        // triggered by an answer. Same ref charset guard as the run path —
        // the journal filename derives from the ref.
        if (!isValidRef(answerParsed.ref)) {
          ctx.ui.notify(
            `/flow answer ${answerParsed.ref}: invalid ref (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}) — aborting.`,
            'warning',
          )
          return
        }
        await executeFlowAnswer(
          { ref: answerParsed.ref, choice: answerParsed.choice },
          makeAnswerDeps(ctx),
        )
        return
      }
      // AIDEV-NOTE (PMR-C3B6): '/flow dashboard' is a literal token reserved at the
      // HANDLER level, before parseFlowArgs — 'dashboard' matches the ref charset
      // ([A-Za-z0-9][A-Za-z0-9._-]{0,99}) so without this branch it would start a
      // run for a ticket named 'dashboard'. Exact single token, case-insensitive
      // (same reservation semantics as the 'help' literal in flow/args.ts,
      // PMR-N0W6). Toggle-only: never sendUserMessage, never spawns.
      if (args.trim().toLowerCase() === 'dashboard') {
        notifyDashboardOutcome(ctx, await toggleFlowDashboardPin(ctx))
        return
      }
      let parsed: FlowArgs = parseFlowArgs(args)
      if (isPickerInvocation(args)) {
        // AIDEV-NOTE (PMR-ZGPY 4.2, PMR-XQA1; fix round 2): ONLY zero-arg
        // /flow opens the two-step picker (gate select → choice select). Every
        // other arg shape keeps the parseFlowArgs usage notify below —
        // /flow X Y is a typo, not a picker. The picker ANSWERS gates via
        // executeFlowAnswer with the SAME deps the /flow answer subcommand
        // uses (makeAnswerDeps) — it never resumes runs, never spawns, and
        // never calls sendUserMessage (PMR-W60H, ISC-A-1). It is fully
        // independent of T6 (D10). All decision logic is pure
        // (planPickerOutcome); this handler only performs ctx.ui.select IO
        // and acts on the plan. Menu option values are the composite
        // ref|kind (splitGateValue) so same-ref rows resolve their own
        // vocabulary (fix round 2). collectOpenGates failure is fail-closed:
        // warn once, never throw (ISC-13). ctx.ui.select returns the option
        // STRING or undefined on cancel (Pi types.d.ts) — labels map back to
        // values through the option lists.
        // AIDEV-NOTE (PMR-3E1Z 3.1): the ONLY fall-through outcome is the
        // ready-ticket 'run' plan: a picked ref is reassigned into `parsed`
        // as { kind: 'aven', ref } and the block falls through into the
        // standard run path — the exact same start a typed /flow <ref> gets.
        // Every other picker outcome returns inside this block. No
        // sendUserMessage / spawn / resume here (PMR-W60H / ISC-A-1):
        // falling through IS the flow start.
        let gates: OpenGate[] = []
        const collected = await collectGatesOrWarn(ctx)
        if (collected === null) {
          return
        }
        gates = collected
        let plan = planPickerOutcome(ctx.hasUI, gates)
        if (plan.kind === 'menu') {
          const labelToValue = new Map(
            plan.options.map((o) => [o.label, o.value]),
          )
          const picked = await ctx.ui.select(
            'Open gate — pick one:',
            plan.options.map((o) => o.label),
          )
          if (picked === undefined) {
            plan = planPickerOutcome(ctx.hasUI, gates, {
              stage: 'gate-cancelled',
            })
          } else {
            const value = labelToValue.get(picked) ?? ''
            // Sentinel row first (PMR-3E1Z): the ready-ticket row must never
            // reach splitGateValue — it is not a composite ref|kind value.
            if (value === TICKET_ROW_VALUE) {
              plan = planPickerOutcome(ctx.hasUI, gates, {
                stage: 'ticket-row-picked',
              })
            } else {
              // Composite value → ref+kind (fix round 2): ref-only lookup could
              // first-match another row sharing the ref.
              const split = splitGateValue(value)
              plan = planPickerOutcome(ctx.hasUI, gates, {
                stage: 'gate-picked',
                gateRef: split.ref,
                gateKind: split.kind,
              })
            }
          }
        }
        if (plan.kind === 'choice-menu') {
          const labelToValue = new Map(
            plan.options.map((o) => [o.label, o.value]),
          )
          const chosen = await ctx.ui.select(
            `${plan.gateRef} — answer with:`,
            plan.options.map((o) => o.label),
          )
          if (chosen === undefined) {
            plan = planPickerOutcome(ctx.hasUI, gates, {
              stage: 'choice-cancelled',
              gateRef: plan.gateRef,
              gateKind: plan.gateKind,
            })
          } else {
            plan = planPickerOutcome(ctx.hasUI, gates, {
              stage: 'answered',
              gateRef: plan.gateRef,
              gateKind: plan.gateKind,
              choice: labelToValue.get(chosen) ?? '',
            })
          }
        }
        if (plan.kind === 'tickets') {
          // PMR-3E1Z 3.1 / yolo plan 1.2: ready-ticket picker step, shared
          // with the /flow --yolo shortcut via pickReadyTicketRef. Only
          // 'run' falls through (parsed reassigned below); everything else
          // notifies or stays silent and returns.
          const ticketRef = await pickReadyTicketRef(ctx, gates.length > 0)
          if (ticketRef === undefined) {
            return
          }
          // AIDEV-NOTE (PMR-3E1Z): picked refs join the run path exactly
          // like a typed /flow <aven-ref> — parsed reassigned, block falls
          // through. 'aven' never matches the 'jira' branch below, so
          // picked refs skip Jira resolution like typed aven refs.
          parsed = { kind: 'aven', ref: ticketRef, yolo: false }
        } else if (plan.kind === 'fallback') {
          for (const line of plan.lines) {
            ctx.ui.notify(line, 'info')
          }
          return
        } else if (plan.kind === 'empty') {
          // 'empty' is purely silent now (PMR-3E1Z): zero-gate invocations
          // return 'tickets' before this branch, so it only covers user
          // cancel / lookup miss — notify nothing.
          return
        } else if (plan.kind === 'print-command') {
          ctx.ui.notify(
            `/flow answer ${plan.ref} ${plan.choices.join('|')}`,
            'info',
          )
          return
        } else if (plan.kind === 'answer') {
          await executeFlowAnswer(
            { ref: plan.ref, choice: plan.choice },
            makeAnswerDeps(ctx),
          )
          return
        } else {
          // AIDEV-NOTE: PMR-P3MB — catch-all safety net. Every current
          // PickerPlan kind is handled above (a hypothetical miss would land
          // on the benign parsed {kind:'help'} path), but a FUTURE variant
          // must never slide into the flow-start path below.
          return
        }
      }
      if (parsed.kind === 'picker') {
        // AIDEV-NOTE (yolo plan 1.2): bare '/flow --yolo' skips the
        // gate-answering select — a yolo run never waits on gates — and
        // lands directly on the ready-ticket picker. The picked ref is
        // reassigned with yolo: true and falls through into the standard
        // run path below, exactly like the zero-arg picker's 'run'
        // outcome. Gate collection stays because the ticket picker
        // suppresses its no-gates message while gates are open; a gate
        // read failure warns fail-closed and returns, never starts a run.
        const collected = await collectGatesOrWarn(ctx)
        if (collected === null) {
          return
        }
        const yoloRef = await pickReadyTicketRef(ctx, collected.length > 0)
        if (yoloRef === undefined) {
          return
        }
        parsed = { kind: 'aven', ref: yoloRef, yolo: true }
      }
      if (parsed.kind === 'help') {
        // Fix round 2: non-zero-arg /flow keeps the pre-picker usage notify —
        // the picker is exclusively the zero-arg invocation (isPickerInvocation).
        ctx.ui.notify(FLOW_USAGE, 'info')
        return
      }
      const mode = await resolveMode(pi, ctx.cwd)
      let ref: string
      if (parsed.kind === 'jira') {
        if (!MODE_PROFILE[mode].acceptsJiraRefs) {
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
        if (resolved.created) {
          ctx.ui.notify(
            `/flow ${parsed.jiraId}: pulled in local epic ${resolved.ref}`,
            'info',
          )
        }
      } else {
        ref = parsed.ref
      }
      // AIDEV-NOTE: PMR-HFK1 — charset guard BEFORE run-start: the journal
      // filename and the attribution env both derive from the ref (the loop
      // re-checks at start; this keeps the run-start event out of a journal
      // whose projection would be unusable).
      if (!isValidRef(ref)) {
        ctx.ui.notify(
          `/flow ${ref}: invalid ref (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}) — aborting.`,
          'warning',
        )
        return
      }
      // AIDEV-NOTE: PMR-XTQQ — ensure the durable run server at run start,
      // BEFORE the loop starts: a live daemon takes over projection ownership
      // so every subsequent journal write routes journal-only. Spawn failure
      // or disabled switch → notify once and continue (never block the flow;
      // the full-writer fallback is today's exact behavior).
      const config = await loadConfig(ctx.cwd)
      runServerEnabled = resolveRunServerEnabled(config)
      if (runServerEnabled) {
        const ensured = await ensureDaemon(getAgentDir())
        if (
          ensured.status === 'spawn-timeout' ||
          ensured.status === 'spawn-failed'
        ) {
          let detail = ''
          if (ensured.status === 'spawn-failed') {
            detail = ` (${ensured.reason})`
          }
          ctx.ui.notify(
            `pi-flow: run server not started${detail} — continuing in-session; runs won't survive a session exit`,
            'warning',
          )
        }
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
      const next = nextPhase(labels, mode)
      if (next.kind === 'done') {
        // AIDEV-NOTE: PMR-YG2N — harness-orchestrated flows never enter the
        // loop, so this early return is their only cleanup trigger. Resolve
        // the worktree binding-first/note-second, run the same onFlowDoneImpl
        // the loop uses (summary discarded there), and surface the outcome
        // without ever blocking the handler on cleanup failure.
        const resolved = await resolveDoneWorktree(pi, ctx.cwd, ref)
        let summary: CleanupFlowWorktreeSummary
        if (onFlowDoneImpl === null) {
          summary = { action: 'deferred', reason: 'cleanup not ready' }
        } else {
          try {
            summary = await onFlowDoneImpl(ref, mode, resolved, ctx.cwd)
          } catch {
            summary = { action: 'deferred', reason: 'cleanup error' }
          }
        }
        let cleanupLine: string
        if (summary.action === 'removed') {
          cleanupLine = `Worktree cleanup: removed ${resolved?.path ?? ''}.`
        } else if (summary.action === 'noop') {
          cleanupLine = 'Worktree cleanup: no flow worktree bound.'
        } else if (summary.action === 'kept-all') {
          // AIDEV-NOTE: PMR-YG2N fix round — kept-all is a deliberate KEEP
          // (unmerged worktree), not a deferral; label it accordingly.
          cleanupLine = `Worktree cleanup: kept (${summary.reason}).`
        } else {
          cleanupLine = `Worktree cleanup: deferred (${summary.reason}).`
        }
        if (summary.action === 'removed' && getActiveFlowRef() === ref) {
          // Durable hygiene: the null-binding write also appends the
          // session entry (see setActiveFlowRef).
          setActiveFlowRef(null)
        }
        ctx.ui.notify(
          `/flow ${ref}: all phase labels present (done) — nothing to run. ${cleanupLine}`,
          'info',
        )
        return
      }
      // AIDEV-NOTE: work/personal separation — the run is TRACKED by its Jira
      // key in work mode (typed Jira ID, else the epic's jira-ref metadata),
      // by the aven ref in personal mode. `ref` (aven) still drives the
      // journal and every aven operation.
      let epicJiraRef: string | null = null
      if (mode === 'work' && parsed.kind !== 'jira') {
        epicJiraRef = await readJiraRef(ref)
      }
      const trackRef = trackingRef({
        mode,
        avenRef: ref,
        jiraId: parsed.kind === 'jira' ? parsed.jiraId : undefined,
        epicJiraRef,
      })
      await journal({
        kind: 'run-start',
        at: new Date().toISOString(),
        ref,
        mode,
        trackRef,
      })
      // AIDEV-NOTE: PMR-T9ZQ 1.2 — owner identity stamp. PROJECTED event (not
      // journal-only): the parked-run resume picker reads state.owner through
      // readRunEvents + projectRunState, so this must go through the
      // projecting `journal` seam. sessionFile is the closure's main session
      // file (null until a session_start supplied one — the loop refreshes it
      // per phase prompt); pid is the liveness carrier the picker probes.
      // Best-effort like every other journal write: writer.record never
      // rejects, so a failed stamp cannot halt the run.
      await journal({
        kind: 'owner-session',
        at: new Date().toISOString(),
        ref,
        sessionFile: mainSessionFile,
        pid: process.pid,
      })
      // AIDEV-NOTE: PMR-XTQQ phase 2 — resume seeding. The journal tail's
      // latest loop-state restores the blocker-retry budget and the validate
      // blockers-note cutoff exactly; the journaled run-input scalars win
      // over a fresh rebuild ONLY while their gitRoot still exists (else the
      // fresh commandPhaseInput result is used). Phase position is never
      // seeded — aven labels re-derive it via nextPhase above.
      const seed = resumeSeedFromEvents(
        await readRunEvents(getAgentDir(), ref),
        (p) => existsSync(p),
      )
      // AIDEV-NOTE (yolo plan 2.1/2.2, 6.1): thread --yolo BEFORE
      // mergeSeedInput — the journaled seed wins for yolo (flag-less resume of
      // a yolo run stays yolo; --yolo cannot upgrade a running non-yolo seed).
      // Config yolo only fills a FRESH start: absent flag (false) || config.
      let promptInput = {
        ...(await commandPhaseInput(pi, {
          mode,
          ref,
          cwd: ctx.cwd,
        })),
        yolo: parsed.yolo || config.yolo,
      }
      promptInput = mergeSeedInput(promptInput, seed)
      const yolo = promptInput.yolo === true
      promptInput = { ...promptInput, yolo }
      // AIDEV-NOTE: serializable prompt-input subset; closures
      // (findTicketRef, ...) are rebuilt per invocation, never journaled.
      // mergeSeedInput (override rule) and runInputRecord (journaled shape)
      // live in flow/resume.ts — flow.test.ts covers both.
      await journal({
        kind: 'run-input',
        at: new Date().toISOString(),
        ref,
        input: runInputRecord(promptInput),
      })
      await adhocCloseMain()
      const startInput: Parameters<typeof loop.start>[0] = {
        ref,
        trackRef,
        phase: next.phase,
        promptInput,
        yolo,
      }
      if (seed.resume !== undefined) {
        startInput.resume = seed.resume
      }
      // AIDEV-NOTE: PMR-YG2N 4.1 — fire-and-forget sweep immediately before
      // loop.start: a restarting flow is never done, so the labels-done gate
      // keeps its own worktree safe without a skip-list.
      runBackgroundSweep({ cwd: ctx.cwd })
      await loop.start(startInput)
      // AIDEV-NOTE: PMR-XTQQ subtask 3.3 — a real rerun re-arms the pending
      // consumer for this ref.
      resumeLatch.delete(ref)
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
      const repoRoot = resolveRepoRoot()
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
      'Open the flow run-state viewer in a Herdr pane. Usage: /flow-view <jira-id | aven-ref | aven:<ref> | jira:<key>> [right|below|left|above|tab]',
    // AIDEV-NOTE: Herdr-gated viewer opener. Requires an existing run-state
    // file (i.e. /flow must have started at least once for the ref). Dedupes
    // by pane label ("flow · <ref>") via herdr api snapshot — survives Pi
    // reloads without any state of our own.
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const rawRef = parts[0]
      const placementArg = parts[1]
      // AIDEV-NOTE: same kind-prefix escape hatch as the phase parsers
      // (PMR-PCVK) — strip aven:/jira: before the run-state filename check.
      let ref: string | undefined
      if (rawRef === undefined) {
        ref = undefined
      } else {
        const kinded = parseRefKind(rawRef)
        if (kinded.kind === 'jira') {
          ref = kinded.jiraId
        } else {
          ref = kinded.ref
        }
      }
      if (ref === undefined || !isValidRef(ref)) {
        ctx.ui.notify(
          'Usage: /flow-view <jira-id | aven-ref | aven:<ref> | jira:<key>> [right|below|left|above|tab]',
          'info',
        )
        return
      }
      // AIDEV-NOTE: Placement resolution chain (PMR-9Q2S 3.2): explicit arg
      // (validated below) > configured viewerPlacement > interactive prompt
      // (only when ctx.hasUI; no UI -> 'right' silently). loadConfig throws
      // on malformed config — same failure mode as the rest of pi-flow.
      // AIDEV-NOTE: PMR-JP37 (3.3) — a freshly picked placement is persisted
      // best-effort to the global config so the next /flow-view without an
      // arg skips the prompt. Persistence failure warns but never blocks the
      // open; arg/config paths below never rewrite config.
      let parsedArg: ReturnType<typeof parseViewerPlacement>
      if (placementArg === undefined) {
        parsedArg = undefined
      } else {
        parsedArg = parseViewerPlacement(placementArg)
      }
      if (placementArg !== undefined && parsedArg === undefined) {
        ctx.ui.notify(
          `Unknown placement "${placementArg}". Use right|below|left|above|tab.`,
          'warning',
        )
        return
      }
      let configured: ReturnType<typeof parseViewerPlacement>
      try {
        const config = await loadConfig(ctx.cwd)
        configured = config.viewerPlacement
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/flow-view: failed to load config: ${msg}`, 'warning')
        return
      }
      const decision = decidePlacement(parsedArg, configured)
      let placement: NonNullable<ReturnType<typeof parseViewerPlacement>>
      if (decision.kind === 'placement') {
        placement = decision.placement
      } else if (ctx.hasUI) {
        const choice = await ctx.ui.select('Viewer placement:', [
          'right',
          'below',
          'left',
          'above',
          'tab',
        ])
        if (choice === undefined) {
          placement = 'right'
        } else {
          const picked = parseViewerPlacement(choice)
          if (picked === undefined) {
            placement = 'right'
          } else {
            placement = picked
            try {
              const savedPath = await saveViewerPlacement(getAgentDir(), picked)
              ctx.ui.notify(`Saved viewer placement to ${savedPath}.`, 'info')
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              ctx.ui.notify(
                `/flow-view: could not save viewer placement: ${msg}`,
                'warning',
              )
            }
          }
        }
      } else {
        placement = 'right'
      }
      const viewer = new FlowHerdrViewer(pi.exec)
      const capability = await viewer.probe()
      if (!capability.available) {
        ctx.ui.notify(`/flow-view: ${capability.reason}`, 'warning')
        return
      }
      // AIDEV-NOTE: Installed-plugin version gate (PMR-9Q2S 2.2). This is a
      // diagnostic refusal, not a repair — the fix is /herdr-sync, never an
      // inline relink. Preflight failure also refuses instead of crashing.
      let expected: string
      try {
        expected = (await preflightRepo(resolveRepoRoot())).version
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(
          `/flow-view: repo preflight failed: ${msg} — run /herdr-sync`,
          'warning',
        )
        return
      }
      const installed = await viewer.installedPlugin()
      const versionStatus = pluginVersionStatus(installed, expected)
      if (versionStatus.status === 'not-installed') {
        ctx.ui.notify(
          '/flow-view: herdr plugin not installed — run /herdr-sync to relink the plugin.',
          'warning',
        )
        return
      }
      if (versionStatus.status === 'disabled') {
        ctx.ui.notify(
          '/flow-view: herdr plugin is disabled — run /herdr-sync to relink the plugin.',
          'warning',
        )
        return
      }
      if (versionStatus.status === 'drift') {
        ctx.ui.notify(
          `/flow-view: herdr plugin version ${versionStatus.installed} != expected ${versionStatus.expected} — run /herdr-sync to relink the plugin.`,
          'warning',
        )
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
        let message: string
        if (opened.reused) {
          message = `Focused existing flow viewer for ${ref}.`
        } else {
          message = `Opened flow viewer for ${ref} (${placement}).`
        }
        ctx.ui.notify(message, 'info')
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/flow-view ${ref}: ${msg}`, 'warning')
      }
    },
  })

  pi.registerCommand('flow-view-replay', {
    description:
      'Open the flow journal replay viewer in a Herdr pane. Usage: /flow-view-replay <jira-id | aven-ref | aven:<ref> | jira:<key>> [right|below|left|above|tab]',
    // AIDEV-NOTE: PMR-ZGPY 5.4 wiring — byte-for-byte mirror of the
    // /flow-view handler above with one difference: viewer.open is called
    // with 'replay' mode (typecheck-enforced union in FlowHerdrViewer.open).
    // The handler body is intentionally duplicated rather than extracted
    // (wiring-only subtask); if a third mode ever lands, extract then.
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const rawRef = parts[0]
      const placementArg = parts[1]
      let ref: string | undefined
      if (rawRef === undefined) {
        ref = undefined
      } else {
        const kinded = parseRefKind(rawRef)
        if (kinded.kind === 'jira') {
          ref = kinded.jiraId
        } else {
          ref = kinded.ref
        }
      }
      if (ref === undefined || !isValidRef(ref)) {
        ctx.ui.notify(
          'Usage: /flow-view-replay <jira-id | aven-ref | aven:<ref> | jira:<key>> [right|below|left|above|tab]',
          'info',
        )
        return
      }
      let parsedArg: ReturnType<typeof parseViewerPlacement>
      if (placementArg === undefined) {
        parsedArg = undefined
      } else {
        parsedArg = parseViewerPlacement(placementArg)
      }
      if (placementArg !== undefined && parsedArg === undefined) {
        ctx.ui.notify(
          `Unknown placement "${placementArg}". Use right|below|left|above|tab.`,
          'warning',
        )
        return
      }
      let configured: ReturnType<typeof parseViewerPlacement>
      try {
        const config = await loadConfig(ctx.cwd)
        configured = config.viewerPlacement
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(
          `/flow-view-replay: failed to load config: ${msg}`,
          'warning',
        )
        return
      }
      const decision = decidePlacement(parsedArg, configured)
      let placement: NonNullable<ReturnType<typeof parseViewerPlacement>>
      if (decision.kind === 'placement') {
        placement = decision.placement
      } else if (ctx.hasUI) {
        const choice = await ctx.ui.select('Viewer placement:', [
          'right',
          'below',
          'left',
          'above',
          'tab',
        ])
        if (choice === undefined) {
          placement = 'right'
        } else {
          const picked = parseViewerPlacement(choice)
          if (picked === undefined) {
            placement = 'right'
          } else {
            placement = picked
            try {
              const savedPath = await saveViewerPlacement(getAgentDir(), picked)
              ctx.ui.notify(`Saved viewer placement to ${savedPath}.`, 'info')
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              ctx.ui.notify(
                `/flow-view-replay: could not save viewer placement: ${msg}`,
                'warning',
              )
            }
          }
        }
      } else {
        placement = 'right'
      }
      const viewer = new FlowHerdrViewer(pi.exec)
      const capability = await viewer.probe()
      if (!capability.available) {
        ctx.ui.notify(`/flow-view-replay: ${capability.reason}`, 'warning')
        return
      }
      let expected: string
      try {
        expected = (await preflightRepo(resolveRepoRoot())).version
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(
          `/flow-view-replay: repo preflight failed: ${msg} — run /herdr-sync`,
          'warning',
        )
        return
      }
      const installed = await viewer.installedPlugin()
      const versionStatus = pluginVersionStatus(installed, expected)
      if (versionStatus.status === 'not-installed') {
        ctx.ui.notify(
          '/flow-view-replay: herdr plugin not installed — run /herdr-sync to relink the plugin.',
          'warning',
        )
        return
      }
      if (versionStatus.status === 'disabled') {
        ctx.ui.notify(
          '/flow-view-replay: herdr plugin is disabled — run /herdr-sync to relink the plugin.',
          'warning',
        )
        return
      }
      if (versionStatus.status === 'drift') {
        ctx.ui.notify(
          `/flow-view-replay: herdr plugin version ${versionStatus.installed} != expected ${versionStatus.expected} — run /herdr-sync to relink the plugin.`,
          'warning',
        )
        return
      }
      const runFile = runStatePath(getAgentDir(), ref)
      if (runFile === null) {
        ctx.ui.notify(`/flow-view-replay: invalid ref "${ref}".`, 'warning')
        return
      }
      try {
        await fs.access(runFile)
      } catch {
        ctx.ui.notify(
          `/flow-view-replay ${ref}: no run state yet — run /flow ${ref} first.`,
          'warning',
        )
        return
      }
      try {
        const opened = await viewer.open(ref, placement, 'replay')
        let message: string
        if (opened.reused) {
          message = `Focused existing flow replay viewer for ${ref}.`
        } else {
          message = `Opened flow replay viewer for ${ref} (${placement}).`
        }
        ctx.ui.notify(message, 'info')
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/flow-view-replay ${ref}: ${msg}`, 'warning')
      }
    },
  })
}
