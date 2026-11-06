// AIDEV-NOTE: Single source of truth for phase handoff prompts, shared by
// the phase commands (/brainstorm, /plan, ...) in index.ts and the /flow loop
// in flow/loop.ts. Both entrypoints MUST produce identical prompts so gates
// and phase logic can never drift between a human invocation and a
// flow-driven one. The loop never "reimplements" a phase — it calls these
// same builders the commands call.
import {
  brainstormArtifactPath,
  resolveBrainstormDir,
} from '../brainstorm/paths.ts'
import {
  buildBrainstormPrompt,
  buildTicketBrainstormPrompt,
} from '../brainstorm/prompt.ts'
import { classifyBrainstormTarget } from '../brainstorm/refs.ts'
import { buildFeedbackPrompt } from '../feedback/prompt.ts'
import { buildImplementPrompt } from '../implement/prompt.ts'
import { routeFor } from '../implement/routing.ts'
import { buildPlanPrompt } from '../plan/prompt.ts'
import { resolveDevctlScriptsDir } from '../validate/paths.ts'
import { buildValidatePrompt } from '../validate/prompt.ts'
import type { WorkMode } from '../work-mode.ts'
import type { Phase } from './orchestrate.ts'

// AIDEV-NOTE: PMR-Z2K7 — research left the lifecycle Phase union; it stays
// here as a command-only phase so /brainstorm (and only /brainstorm) can
// reach brainstormPrompt through the shared builder (PMR-H7RW renamed the
// member from 'research' to 'brainstorm'). The /flow loop only ever passes
// lifecycle Phases.
export type CommandPhase = Phase | 'brainstorm'

export type PhasePrompt =
  | { kind: 'send'; prompt: string }
  | { kind: 'block'; reason: string }

export interface BrainstormOverride {
  kind: 'feature' | 'debug'
  text: string
  /** Provenance of text — decides ticket-ref resolution
   *  (brainstorm/refs.ts classifyBrainstormTarget): 'force' = known Jira ID
   *  (/flow jira kind or ID= prefix), 'explicit' = bare /brainstorm topic
   *  (ticket path only when jira-shaped AND work mode). Undefined = default
   *  ref-as-topic; never the ticket path (an aven ref must not hit acli). */
  refHint?: 'force' | 'explicit'
}

export interface PhasePromptInput {
  mode: WorkMode
  ref: string
  /** Git toplevel of the session cwd; brainstorm/plan derive repoName from it. */
  gitRoot: string
  /** Resolved pi-flow config workRoots; work-mode validate needs them. */
  workRoots: readonly string[]
  /** Current aven labels on the ref; implement routing gates on them. */
  labels: readonly string[]
  /** True when the ref is an epic with open children — forces the plan route
   *  (an oneshot route over an open tree is always a misroute: the whole
   *  tree gets executed as one batch without per-task workers). */
  epicHasOpenChildren?: boolean
  /** /brainstorm override: explicit kind + topic/symptom (flow defaults to feature+ref). */
  brainstorm?: BrainstormOverride
  /** Aven ticket lookup for ticket brainstorming (jira-ref epic, then jira-key
   *  synced ticket). Null = neither exists — the prompt falls back to acli. */
  findTicketRef?: (jiraId: string) => Promise<{
    kind: 'epic' | 'synced'
    ref: string
  } | null>
}

export async function buildPhasePrompt(
  phase: CommandPhase,
  input: PhasePromptInput,
): Promise<PhasePrompt> {
  switch (phase) {
    case 'brainstorm':
      return brainstormPrompt(input)
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

// AIDEV-NOTE: async so ticket brainstorming can resolve the local epic via
// findEpicRef before the prompt is built — /flow and /brainstorm share this
// one path. Debug symptoms never take the ticket branch.
async function brainstormPrompt(input: PhasePromptInput): Promise<PhasePrompt> {
  const brainstorm = input.brainstorm ?? {
    kind: 'feature' as const,
    text: input.ref,
  }
  const repoName = input.gitRoot.split('/').pop() ?? 'unknown'
  const dir = resolveBrainstormDir(
    input.mode,
    process.env.LLM_NOTES_ROOT,
    process.env.PERSONAL_FEATURES,
    repoName,
    input.gitRoot,
  )
  const today = new Date().toISOString().slice(0, 10)
  const target = classifyBrainstormTarget(brainstorm.text, {
    force: brainstorm.refHint === 'force',
    explicit: brainstorm.refHint === 'explicit',
    mode: input.mode,
  })
  if (brainstorm.kind === 'feature' && target.kind === 'ticket') {
    let resolved: { kind: 'epic' | 'synced'; ref: string } | null = null
    if (input.findTicketRef !== undefined) {
      resolved = await input.findTicketRef(target.jiraId)
    }
    return {
      kind: 'send',
      prompt: buildTicketBrainstormPrompt({
        jiraId: target.jiraId,
        target: resolved,
        artifactPath: brainstormArtifactPath(dir, target.jiraId, today),
        mode: input.mode,
      }),
    }
  }
  const artifactPath = brainstormArtifactPath(dir, brainstorm.text, today)
  return {
    kind: 'send',
    prompt: buildBrainstormPrompt({
      kind: brainstorm.kind,
      input: brainstorm.text,
      artifactPath,
      mode: input.mode,
    }),
  }
}

function planPrompt(input: PhasePromptInput): PhasePrompt {
  return {
    kind: 'send',
    prompt: buildPlanPrompt({ mode: input.mode, ref: input.ref }),
  }
}

function implementPrompt(input: PhasePromptInput): PhasePrompt {
  const routed = routeFor('aven', input.labels)
  if (routed.kind === 'refuse') {
    return { kind: 'block', reason: routed.reason }
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
  // AIDEV-NOTE: personal oneshot tickets have no plan.md, so the deviation
  // gate must name the ticket description as the spec source, not plan-path.
  return {
    kind: 'send',
    prompt: buildValidatePrompt({
      mode: input.mode,
      ref: input.ref,
      scriptsDir: null,
      oneshot: input.labels.includes('oneshot'),
    }),
  }
}

function feedbackPrompt(input: PhasePromptInput): PhasePrompt {
  if (input.mode === 'personal') {
    return {
      kind: 'block',
      reason:
        'personal mode has no feedback phase — validate writes the outcome summary note and sets done after the push.',
    }
  }
  return {
    kind: 'send',
    prompt: buildFeedbackPrompt({ mode: 'work', ref: input.ref }),
  }
}
