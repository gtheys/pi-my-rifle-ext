// AIDEV-NOTE: Single source of truth for phase handoff prompts, shared by
// the phase commands (/research, /plan, ...) in index.ts and the /flow loop
// in flow/loop.ts. Both entrypoints MUST produce identical prompts so gates
// and phase logic can never drift between a human invocation and a
// flow-driven one. The loop never "reimplements" a phase — it calls these
// same builders the commands call.
import path from 'node:path'
import { buildFeedbackPrompt } from '../feedback/prompt.ts'
import { buildImplementPrompt } from '../implement/prompt.ts'
import { routeFor } from '../implement/routing.ts'
import { resolvePlanDir } from '../plan/paths.ts'
import { buildPlanPrompt } from '../plan/prompt.ts'
import { researchArtifactPath, resolveResearchDir } from '../research/paths.ts'
import {
  buildResearchPrompt,
  buildTicketResearchPrompt,
} from '../research/prompt.ts'
import { classifyResearchTarget } from '../research/refs.ts'
import { resolveDevctlScriptsDir } from '../validate/paths.ts'
import { buildValidatePrompt } from '../validate/prompt.ts'
import type { WorkMode } from '../work-mode.ts'
import type { Phase } from './orchestrate.ts'

export type PhasePrompt =
  | { kind: 'send'; prompt: string }
  | { kind: 'block'; reason: string }

export interface ResearchOverride {
  kind: 'feature' | 'debug'
  text: string
  /** Provenance of text — decides ticket-ref resolution
   *  (research/refs.ts classifyResearchTarget): 'force' = known Jira ID
   *  (/flow jira kind or ID= prefix), 'explicit' = bare /research topic
   *  (ticket path only when jira-shaped AND work mode). Undefined = default
   *  ref-as-topic; never the ticket path (an aven ref must not hit acli). */
  refHint?: 'force' | 'explicit'
}

export interface PhasePromptInput {
  mode: WorkMode
  ref: string
  skipResearch: boolean
  /** Git toplevel of the session cwd; research/plan derive repoName from it. */
  gitRoot: string
  /** Resolved pi-flow config workRoots; work-mode validate needs them. */
  workRoots: readonly string[]
  /** Current aven labels on the ref; implement routing gates on them. */
  labels: readonly string[]
  /** True when the ref is an epic with open children — forces the plan route
   *  (an oneshot route over an open tree is always a misroute: the whole
   *  tree gets executed as one batch without per-task workers). */
  epicHasOpenChildren?: boolean
  /** /research override: explicit kind + topic/symptom (flow defaults to feature+ref). */
  research?: ResearchOverride
  /** Aven epic lookup for ticket research (jira-ref metadata). Absent = no
   *  aven access from this entrypoint; the ticket prompt falls back to acli. */
  findEpicRef?: (jiraId: string) => Promise<string | null>
}

export async function buildPhasePrompt(
  phase: Phase,
  input: PhasePromptInput,
): Promise<PhasePrompt> {
  switch (phase) {
    case 'research':
      return researchPrompt(input)
    case 'plan':
      return planPrompt(input)
    case 'implement':
      return implementPrompt(input)
    case 'validate':
      return validatePrompt(input)
    case 'feedback':
      return feedbackPrompt(input)
  }
}

// AIDEV-NOTE: async so ticket research can resolve the local epic via
// findEpicRef before the prompt is built — /flow and /research share this
// one path. Debug symptoms never take the ticket branch.
async function researchPrompt(input: PhasePromptInput): Promise<PhasePrompt> {
  const research = input.research ?? {
    kind: 'feature' as const,
    text: input.ref,
  }
  const repoName = input.gitRoot.split('/').pop() ?? 'unknown'
  const dir = resolveResearchDir(
    process.env.LLM_NOTES_ROOT,
    repoName,
    input.gitRoot,
  )
  const today = new Date().toISOString().slice(0, 10)
  const target = classifyResearchTarget(research.text, {
    force: research.refHint === 'force',
    explicit: research.refHint === 'explicit',
    mode: input.mode,
  })
  if (research.kind === 'feature' && target.kind === 'ticket') {
    let epicRef: string | null = null
    if (input.findEpicRef !== undefined) {
      epicRef = await input.findEpicRef(target.jiraId)
    }
    return {
      kind: 'send',
      prompt: buildTicketResearchPrompt({
        jiraId: target.jiraId,
        epicRef,
        artifactPath: researchArtifactPath(dir, target.jiraId, today),
        mode: input.mode,
      }),
    }
  }
  const artifactPath = researchArtifactPath(dir, research.text, today)
  return {
    kind: 'send',
    prompt: buildResearchPrompt({
      kind: research.kind,
      input: research.text,
      artifactPath,
      mode: input.mode,
    }),
  }
}

function planPrompt(input: PhasePromptInput): PhasePrompt {
  const repoName = input.gitRoot.split('/').pop() ?? 'unknown'
  const dir = resolvePlanDir(
    process.env.PERSONAL_FEATURES,
    repoName,
    input.gitRoot,
    new Date().toISOString().slice(0, 10),
    input.ref,
  )
  const planPath = path.join(dir, 'plan.md')
  return {
    kind: 'send',
    prompt: buildPlanPrompt({ mode: input.mode, ref: input.ref, planPath }),
  }
}

function implementPrompt(input: PhasePromptInput): PhasePrompt {
  const routed = routeFor('aven', input.labels, input.skipResearch)
  if (routed.kind === 'refuse') {
    return { kind: 'block', reason: routed.reason }
  }
  if (routed.kind === 'skip-required') {
    return {
      kind: 'block',
      reason:
        'research not done — re-run with --skip-research to explicitly skip',
    }
  }
  // AIDEV-NOTE: structural routing guard — labels are the routing contract,
  // but a tree with open children is plan-route work no matter what the type
  // labels say (legacy approvals, manual label edits). An oneshot prompt over
  // an open tree batches the whole tree into one cycle with no workers.
  const route =
    routed.route === 'oneshot' && input.epicHasOpenChildren === true
      ? 'plan'
      : routed.route
  return {
    kind: 'send',
    prompt: buildImplementPrompt({
      mode: input.mode,
      ref: input.ref,
      route,
      researchSkip: routed.researchSkip,
    }),
  }
}

function validatePrompt(input: PhasePromptInput): PhasePrompt {
  if (input.mode === 'work') {
    const scriptsDir = resolveDevctlScriptsDir(input.workRoots)
    if (scriptsDir === null) {
      return {
        kind: 'block',
        reason:
          'no workRoots configured — cannot resolve the sh-devctl scripts dir',
      }
    }
    return {
      kind: 'send',
      prompt: buildValidatePrompt({
        mode: input.mode,
        ref: input.ref,
        scriptsDir,
      }),
    }
  }
  return {
    kind: 'send',
    prompt: buildValidatePrompt({
      mode: input.mode,
      ref: input.ref,
      scriptsDir: null,
    }),
  }
}

function feedbackPrompt(input: PhasePromptInput): PhasePrompt {
  return {
    kind: 'send',
    prompt: buildFeedbackPrompt({ mode: input.mode, ref: input.ref }),
  }
}
