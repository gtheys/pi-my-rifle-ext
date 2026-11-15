// AIDEV-NOTE: PMR-T22H — index.ts is wiring only. Boundaries: aven/client.ts
// owns every aven shell-out; config.ts owns config + mode resolution;
// tools/* own the four agent tools; flow/phase-command.ts owns the 5 phase
// commands; spec-review/commands.ts owns the spec commands. What stays here:
// the extension entrypoint, the enforcement interceptors, the flow loop
// wiring, and /flow + /herdr-sync + /flow-view.
import { randomBytes } from 'node:crypto'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
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
  avenExec,
  discoverAvenPrefixes,
  ensureLabels,
  epicHasOpenChildren,
  lastAvenResolutionFailure,
  readAvenLabels,
  readFreshBlockers,
  readJiraRef,
  readPlanState,
  setAvenSessionCwd,
  writeAvenNote,
} from './aven/client.ts'
import { loadConfig, resolveMode, saveViewerPlacement } from './config.ts'
import { parseFlowArgs } from './flow/args.ts'
import { spawnJournalTarget } from './flow/attribution.ts'
import { pushToGateway } from './flow/cost.ts'
import { createCostAutoPush } from './flow/cost-autopush.ts'
import {
  type FlowCostDeps,
  registerFlowCostCommand,
} from './flow/cost-command.ts'
import { resolveJiraEpic } from './flow/jira-ref.ts'
import { lifecycleLabelMutation } from './flow/label-gate.ts'
import { landingIntercept } from './flow/land-gate.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase } from './flow/orchestrate.ts'
import {
  commandPhaseInput,
  registerPhaseCommands,
} from './flow/phase-command.ts'
import {
  parseRefKind,
  registerAvenPrefixes,
  trackingRef,
} from './flow/ref-kind.ts'
import { resumeSeedFromEvents } from './flow/resume.ts'
import {
  type FlowBindingSnapshot,
  parseFlowBindingSnapshot,
  reactivateFlowRef,
  restoreFlowBinding,
  setActiveFlowRef,
  setBindingChangeListener,
} from './flow/worktree-context.ts'
import {
  preflightRepo,
  resolveRepoRoot,
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
import { registerResolveSpecPath } from './plan-tools/resolve-spec-path.ts'
import prQualityExtension from './pr-quality/index.ts'
import reviewExtension from './review/review.ts'
import { readRunEvents, runStatePath } from './run-state.ts'
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
import {
  createLandingState,
  defaultSuiteRunner,
  registerLandTool,
} from './tools/land.ts'
import { registerPhaseCompleteTool } from './tools/phase-complete.ts'
import { registerRunAttemptTool } from './tools/run-attempt.ts'
import { registerSpecApproveTool } from './tools/spec-approve.ts'
import worktreeExtension from './worktree/index.ts'

// AIDEV-NOTE: test-facing export surface (PMR-T22H) — tests import these
// from index.ts; the implementations now live in the boundary modules.
export {
  readAvenLabels,
  setAvenSessionCwd,
  specApprove,
} from './aven/client.ts'
export {
  loadConfig,
  readConfigFile,
  resolveMode,
  saveViewerPlacement,
} from './config.ts'

// AIDEV-NOTE: PMR-XTQQ — best-effort journal write seam. Writers route
// through the mode-aware writer: journal-only while the durable run server
// owns the projection (per-write liveness probe), today's full writer path
// when absent. Journal failures must never break a flow phase; aven labels
// remain the gate source of truth.

export default function (pi: ExtensionAPI) {
  // AIDEV-NOTE: PMR-XTQQ — runServer.enabled kill switch; flipped from the
  // loaded config at every /flow start (default true). false = the probe
  // always reports absent (full-writer path permanently) and ensureDaemon
  // never spawns.
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
    },
    sendPrompt: (prompt) => {
      pi.sendUserMessage(prompt)
    },
  })

  // AIDEV-NOTE: PMR-HFK1 — spawn attribution journaling. The subagents
  // extension emits spawn/resume/reattach events; while a flow run is
  // active we journal them as `note` events so the later flow-cost rollup
  // can reconstruct child->subtask attribution even if env stamps are lost
  // (reassignments/takeovers included — cost follows whoever actually did
  // the work). No active run = nothing to attribute, ignore. Best-effort:
  // journal failures are already swallowed by the journal() wrapper.
  onFlowSpawn((info) => {
    // AIDEV-NOTE: nested spawns — in a flow WORKER (scouts spawned by a plan
    // agent, ...) the loop is not running, but the worker inherited
    // PI_FLOW_REF, so its spawns still belong to that flow. Those notes go to
    // the journal only (recordJournalOnly); the main process routes through
    // the mode-aware writer (journal-only while the daemon owns the
    // projection, full writer otherwise).
    const target = spawnJournalTarget(loop.activeRef(), process.env)
    if (target === null) return
    const { ref, nested } = target
    let text = `subagent ${info.childId} ("${info.name}") ${info.kind} — attribution env stamped`
    if (info.subtask !== undefined) {
      text = `subagent ${info.childId} ("${info.name}") ${info.kind} for subtask ${info.subtask} — attribution env stamped`
    }
    // AIDEV-NOTE (PMR-EA8X): append the session path so /flow-cost can
    // resolve child sessions from the journal alone (older notes without
    // it fall back to the durable assignment records).
    if (info.sessionFile !== undefined) {
      text = `${text}, session="${info.sessionFile}"`
    }
    const event = {
      kind: 'note' as const,
      at: new Date().toISOString(),
      ref,
      text,
    }
    if (nested) {
      void journalOnly(event)
      return
    }
    void journal(event)
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
      void resumeParkedRun(resumeConsumerDeps(savedRef))
    }
    setBindingChangeListener((snapshot) => {
      pi.appendEntry('pi-flow-binding', snapshot)
    })
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
  // agent-writable.
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
    return undefined
  })

  registerPhaseCompleteTool(pi, undefined, writer)
  registerLandTool(
    pi,
    landingState,
    () => loop.activeRef(),
    defaultSuiteRunner,
    undefined,
    undefined,
    writer,
  )
  // AIDEV-NOTE: PMR-T8ZG — the human code-review gate (PMR-3ZY1): the
  // code_review tool shares landingState with flow_land so a pass recorded
  // here is visible to the later flow_land check (PMR-C6AK, not wired yet).
  registerCodeReviewTool(pi, landingState)
  // AIDEV-NOTE: PMR-R9EN — the deviation gate is a registered tool so the
  // validate prompt can instruct the agent to CALL something (D3/D4) instead
  // of naming TS functions it cannot invoke.
  registerDeviationReviewTool(pi, writer)
  registerRunAttemptTool(pi)
  registerSpecApproveTool(pi)
  // AIDEV-NOTE: PMR-XCA9 — plan-tools absorbed from the retired pi-planning
  // package (resolve_spec_path, resolve_feature_path, open_in_pane,
  // jira_create_branch; /review-spec lives in spec-review/commands.ts).
  registerResolveSpecPath(pi)
  registerResolveFeaturePath(pi)
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
  // tool); pi-worktree is deleted, so it registers exactly once, here.
  worktreeExtension(pi)

  // AIDEV-NOTE: The /flow advancement hook. agent_settled fires after a run
  // fully settles (blocking ask_user_question gates keep the run in flight,
  // so gates are never raced). Fire-and-forget subagents DO settle the run
  // mid-phase — their result arrives later as a steer — so the loop's
  // hasInFlightSubagent guard keeps those settles from halting the flow.
  // The loop re-reads aven labels and either injects the next phase prompt
  // or halts — advancement is code, not model.
  pi.on('agent_settled', () => {
    void loop.onSettled()
    // AIDEV-NOTE: PMR-XTQQ subtask 3.3 — belt-and-braces consumer path. A
    // parked record for the restored binding is consumed + re-presented here
    // when session_start's check found nothing (e.g. the daemon parked the
    // run moments later). No-ops unless a binding exists; the consumer
    // itself guards loop-active / disabled / latch / nothing-pending.
    const resumeRef = boundRef
    if (resumeRef !== null) {
      void resumeParkedRun(resumeConsumerDeps(resumeRef))
    }
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

  pi.registerCommand('flow', {
    description:
      'PIV run-all (plan -> implement -> validate -> feedback; personal mode stops after validate). Usage: /flow <jira-id | aven-ref | aven:<ref> | jira:<key>>. Brainstorm topics go through /brainstorm.',
    // AIDEV-NOTE: Aven IS the run state — labels fetched fail-closed (aven
    // failure aborts, never starts mid-phase by accident). nextPhase()
    // resolves the first phase whose completion label is missing, then the
    // extension-owned loop (flow/loop.ts) takes over: it injects ONE phase
    // prompt at a time (same builder the phase commands use) and advances on
    // agent_settled when the phase label lands. No driver agent — the model
    // never sequences phases.
    handler: async (args, ctx) => {
      const parsed = parseFlowArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /flow <jira-id | aven-ref | aven:<ref> | jira:<key>>. Brainstorm topics go through /brainstorm.',
          'info',
        )
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
      runServerEnabled = config.runServer?.enabled !== false
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
        ctx.ui.notify(
          `/flow ${ref}: all phase labels present (done) — nothing to run.`,
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
      let promptInput = await commandPhaseInput(pi, {
        mode,
        ref,
        cwd: ctx.cwd,
      })
      if (seed.input !== undefined) {
        promptInput = {
          ...promptInput,
          mode: seed.input.mode,
          gitRoot: seed.input.gitRoot,
          workRoots: seed.input.workRoots,
        }
      }
      // AIDEV-NOTE: serializable prompt-input subset; closures
      // (findTicketRef, ...) are rebuilt per invocation, never journaled.
      await journal({
        kind: 'run-input',
        at: new Date().toISOString(),
        ref,
        input: {
          mode: promptInput.mode,
          gitRoot: promptInput.gitRoot,
          workRoots: [...promptInput.workRoots],
        },
      })
      await adhocCloseMain()
      const startInput: Parameters<typeof loop.start>[0] = {
        ref,
        trackRef,
        phase: next.phase,
        promptInput,
      }
      if (seed.resume !== undefined) {
        startInput.resume = seed.resume
      }
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
}
