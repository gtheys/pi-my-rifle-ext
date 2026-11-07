// AIDEV-NOTE: PMR-T22H — index.ts is wiring only. Boundaries: aven/client.ts
// owns every aven shell-out; config.ts owns config + mode resolution;
// tools/* own the four agent tools; flow/phase-command.ts owns the 5 phase
// commands; spec-review/commands.ts owns the spec commands. What stays here:
// the extension entrypoint, the enforcement interceptors, the flow loop
// wiring, and /flow + /herdr-sync + /flow-view.
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getAgentDir,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent'
import {
  hasLiveAssignmentForParent,
  onFlowSpawn,
} from '@gtheys/pi-interactive-subagents'
import {
  avenExec,
  discoverAvenPrefixes,
  ensureLabels,
  epicHasOpenChildren,
  lastAvenResolutionFailure,
  readAvenLabels,
  readFreshBlockers,
  readPlanState,
  setAvenSessionCwd,
  writeAvenNote,
} from './aven/client.ts'
import { resolveMode } from './config.ts'
import { parseFlowArgs } from './flow/args.ts'
import { resolveJiraEpic } from './flow/jira-ref.ts'
import { lifecycleLabelMutation } from './flow/label-gate.ts'
import { landingIntercept } from './flow/land-gate.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase } from './flow/orchestrate.ts'
import {
  commandPhaseInput,
  registerPhaseCommands,
} from './flow/phase-command.ts'
import { parseRefKind, registerAvenPrefixes } from './flow/ref-kind.ts'
import {
  type FlowBindingSnapshot,
  parseFlowBindingSnapshot,
  reactivateFlowRef,
  restoreFlowBinding,
  setActiveFlowRef,
  setBindingChangeListener,
} from './flow/worktree-context.ts'
import { syncHerdrPlugin } from './herdr/sync.ts'
import {
  FlowHerdrViewer,
  isValidRef,
  parseViewerPlacement,
} from './herdr/viewer.ts'
import { MODE_PROFILE } from './mode-profile.ts'
import { registerJiraCreateBranch } from './plan-tools/jira-branch-tool.ts'
import { registerResolveFeaturePath } from './plan-tools/resolve-feature-path.ts'
import { registerResolveSpecPath } from './plan-tools/resolve-spec-path.ts'
import prQualityExtension from './pr-quality/index.ts'
import reviewExtension from './review/review.ts'
import { recordRunEvent, runStatePath } from './run-state.ts'
import sonarqubeExtension from './sonarqube/sonarqube.ts'
import { registerSpecCommands } from './spec-review/commands.ts'
import { registerOpenInPane } from './spec-review/open-in-pane.ts'
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
export { loadConfig, readConfigFile, resolveMode } from './config.ts'

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
    const ref = loop.activeRef()
    if (ref === null) return
    let text = `subagent ${info.childId} ("${info.name}") ${info.kind} — attribution env stamped`
    if (info.subtask !== undefined) {
      text = `subagent ${info.childId} ("${info.name}") ${info.kind} for subtask ${info.subtask} — attribution env stamped`
    }
    void journal({ kind: 'note', at: new Date().toISOString(), ref, text })
  })

  pi.on('session_start', (_event, ctx) => {
    notifyUser = (message, level) => ctx.ui.notify(message, level)
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
    if (saved?.ref) {
      if (saved.worktree && !existsSync(saved.worktree.path)) {
        saved = { ref: saved.ref, worktree: null }
      }
      restoreFlowBinding(saved)
      notifyUser(
        `pi-flow: restored flow binding for ${saved.ref}. The /flow loop itself is not resumed — rerun /flow ${saved.ref} to continue phases.`,
        'info',
      )
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

  registerPhaseCompleteTool(pi)
  registerLandTool(pi, landingState, () => loop.activeRef(), defaultSuiteRunner)
  // AIDEV-NOTE: PMR-T8ZG — the human code-review gate (PMR-3ZY1): the
  // code_review tool shares landingState with flow_land so a pass recorded
  // here is visible to the later flow_land check (PMR-C6AK, not wired yet).
  registerCodeReviewTool(pi, landingState)
  // AIDEV-NOTE: PMR-R9EN — the deviation gate is a registered tool so the
  // validate prompt can instruct the agent to CALL something (D3/D4) instead
  // of naming TS functions it cannot invoke.
  registerDeviationReviewTool(pi)
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
  reviewExtension(pi)
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
  })

  registerPhaseCommands(pi)
  registerSpecCommands(pi)

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
      await journal({
        kind: 'run-start',
        at: new Date().toISOString(),
        ref,
        mode,
      })
      await loop.start({
        ref,
        phase: next.phase,
        promptInput: await commandPhaseInput(pi, {
          mode,
          ref,
          cwd: ctx.cwd,
        }),
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
      let placement: ReturnType<typeof parseViewerPlacement>
      if (placementArg === undefined) {
        placement = 'right'
      } else {
        placement = parseViewerPlacement(placementArg)
      }
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
