// AIDEV-NOTE: PMR-T22H — index.ts is wiring only. Boundaries: aven/client.ts
// owns every aven shell-out; config.ts owns config + mode resolution;
// tools/* own the four agent tools; flow/phase-command.ts owns the 5 phase
// commands; spec-review/commands.ts owns the spec commands. What stays here:
// the extension entrypoint, the enforcement interceptors, the flow loop
// wiring, and /flow + /herdr-sync + /flow-view.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  getAgentDir,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent'
import { hasLiveAssignmentForParent } from '@gtheys/pi-interactive-subagents'
import {
  avenExec,
  ensureLabels,
  epicHasOpenChildren,
  lastAvenResolutionFailure,
  readAvenLabels,
  readPlanState,
  setAvenSessionCwd,
  writeAvenNote,
} from './aven/client.ts'
import { resolveMode } from './config.ts'
import { parseFlowArgs } from './flow/args.ts'
import { resolveJiraEpic } from './flow/jira-ref.ts'
import { lifecycleLabelMutation } from './flow/label-gate.ts'
import { landingBashBlock } from './flow/land-gate.ts'
import { createFlowLoop } from './flow/loop.ts'
import { nextPhase } from './flow/orchestrate.ts'
import {
  commandPhaseInput,
  registerPhaseCommands,
} from './flow/phase-command.ts'
import { parseRefKind } from './flow/ref-kind.ts'
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
import { createLandingState, registerLandTool } from './tools/land.ts'
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
    avenNote: (ref, text) => writeAvenNote(ref, text),
    epicHasOpenChildren: (ref) => epicHasOpenChildren(ref),
    hasInFlightSubagent: () => hasLiveAssignmentForParent(process.pid),
    sendPrompt: (prompt) => {
      pi.sendUserMessage(prompt)
    },
  })

  pi.on('session_start', (_event, ctx) => {
    notifyUser = (message, level) => ctx.ui.notify(message, level)
    setAvenSessionCwd(ctx.cwd)
    void ensureLabels(notifyUser)
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
    const activeRef = loop.activeRef()
    if (activeRef === null || landingState.authorized === activeRef) {
      return undefined
    }
    const landing = landingBashBlock(event.input.command, activeRef)
    if (landing === null) return undefined
    return { block: true, reason: landing }
  })

  registerPhaseCompleteTool(pi)
  registerLandTool(pi, landingState)
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

  pi.registerCommand('flow', {
    description:
      'PIV run-all (plan -> implement -> validate -> feedback). Usage: /flow <jira-id | aven-ref | aven:<ref> | jira:<key>>. Brainstorm topics go through /brainstorm.',
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
      const next = nextPhase(labels)
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
