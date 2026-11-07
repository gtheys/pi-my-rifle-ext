// AIDEV-NOTE: Extension-owned /flow loop (replaces the old "driver agent"
// handoff prompt — an agent cannot invoke slash commands, so a prompt asking
// it to do so just made the agent wander; PMR follow-up, see docs/rpiv-flow.md
// §5). The loop injects ONE phase prompt at a time via the same
// buildPhasePrompt the phase commands use, then advances on the
// agent_settled event: label landed -> next phase prompt; label missing,
// abort, or aven failure -> deterministic stop-on-fail (aven note + halt).
// Exception: a settle while a subagent is still in flight is a mid-phase
// async wait (fire-and-forget scouts/planners steer back as a later run),
// not a phase outcome — the loop stays armed and re-checks on the next
// settle (hasInFlightSubagent guard). The model never sequences phases —
// extension code does.
import { MAX_ATTEMPTS } from '../implement/retry.ts'
import type { FlowRunEvent } from '../run-state.ts'
import {
  clearFlowEnv,
  type FlowEnv,
  stampFlowPhase,
  stampFlowStart,
} from './attribution.ts'
import { nextPhase, PHASE_LABEL, type Phase } from './orchestrate.ts'
import { buildPhasePrompt, type PhasePromptInput } from './phase-prompts.ts'

export interface FlowLoopDeps {
  notify(message: string, level: 'info' | 'warning'): void
  /** Best-effort journal write; must never throw. */
  journal(event: FlowRunEvent): void
  /** Current aven labels on the ref; null = aven unavailable/failed. */
  readLabels(ref: string): Promise<string[] | null>
  /**
   * Aven `plan-state` metadata value on the ref (e.g. 'review', 'approved').
   * null = aven failed OR the field is absent — the two are deliberately not
   * distinguished; a null never triggers the awaiting-approval gate.
   */
  readPlanState(ref: string): Promise<string | null>
  /** Write an aven note on the ref; false = write failed. */
  avenNote(ref: string, text: string): Promise<boolean>
  /**
   * PMR-69V8: true when an aven review-blockers note ("reviewed-at:") was
   * written at/after sinceIso. Optional + fail-closed: absent or false keeps
   * the plain halt, so a validate failure without blockers never retries.
   */
  hasFreshBlockers?(ref: string, sinceIso: string): Promise<boolean>
  /** True when the ref is an epic with open children (implement routing guard). */
  epicHasOpenChildren(ref: string): Promise<boolean>
  /** True while this session has an in-flight subagent (mid-phase async wait). */
  hasInFlightSubagent(): boolean
  sendPrompt(prompt: string): void
  // AIDEV-NOTE: PMR-1CCT — optional active-ref sink so the review tool can
  // resolve the flow worktree (flow/worktree-context.ts). Called with the
  // ref on start and with null on every terminal transition (halt, pause,
  // done). Optional so existing tests/consumers need no changes.
  setActiveRef?(ref: string | null): void
  // AIDEV-NOTE: PMR-HFK1 — attribution env target, stamped at run start,
  // re-stamped per phase, cleared on terminal transitions. Optional +
  // defaults to process.env so existing tests/consumers need no changes.
  env?: FlowEnv
  /**
   * Called after every flow-env stamp/re-stamp/clear (start, phase change,
   * halt, pause, done) so observers (telemetry) can close the phase that
   * just ended without waiting for another span.
   */
  onFlowEnvChange?: () => void
  /**
   * Current main pi session file (null/absent = unknown). Journaled at every
   * phase start so /flow-cost can attribute the main session's cost to
   * phases (resumed flows may span several session files).
   */
  getSessionFile?: () => string | null
  /**
   * Called after every terminal transition (run complete, halt, pause for
   * approval) with the ref that just ended, AFTER the flow env was cleared.
   * Used to push cost metrics automatically.
   */
  onRunEnd?: (ref: string) => void
  // AIDEV-NOTE: PMR-VZEV — clears the landing state (authorized +
  // humanReviewPassed) on every start so stale authorization from a
  // superseded/prior flow cannot authorize a later landing.
  resetLandingState?(): void
}

export interface FlowStartInput {
  ref: string
  phase: Phase
  /** Per-run inputs for buildPhasePrompt (mode, gitRoot, workRoots, ...). */
  promptInput: Omit<PhasePromptInput, 'labels'>
}

interface FlowLoopState {
  ref: string
  currentPhase: Phase
  awaitingOutcome: boolean
  /** PMR-69V8: implement re-injections used this run (budget = MAX_ATTEMPTS - 1). */
  blockerRetries: number
  /** ISO time the current validate prompt was sent (blockers-note cutoff). */
  validateStartedAt: string
  promptInput: Omit<PhasePromptInput, 'labels'>
}

export interface FlowLoop {
  /** Start (or restart) the run at the given phase. Sends the phase prompt. */
  start(input: FlowStartInput): Promise<void>
  /** Evaluate the settled run: advance, halt, or finish. Ignored when idle. */
  onSettled(): Promise<void>
  /** Whether a flow run is awaiting a phase outcome in this session. */
  isActive(): boolean
  /** The active flow's ref, or null when no flow run is in flight (PMR-06RH). */
  activeRef(): string | null
}

class FlowLoopImpl implements FlowLoop {
  private readonly deps: FlowLoopDeps
  private readonly env: FlowEnv
  private state: FlowLoopState | null = null

  constructor(deps: FlowLoopDeps) {
    this.deps = deps
    this.env = deps.env ?? process.env
  }

  isActive(): boolean {
    return this.state !== null
  }

  activeRef(): string | null {
    if (this.state === null) return null
    return this.state.ref
  }

  async start(input: FlowStartInput): Promise<void> {
    if (this.state !== null) {
      this.deps.notify(
        `/flow: superseding active flow for ${this.state.ref} with ${input.ref}`,
        'info',
      )
    }
    // AIDEV-NOTE: PMR-HFK1 — stamp attribution env BEFORE any prompt is
    // sent: every child spawned from here on carries PI_FLOW_* into its tab
    // env. A fresh traceparent root per invocation (see attribution.ts) —
    // superseding stamps over the old run's values. Invalid ref = abort
    // fail-closed: the journal filename would be unusable anyway.
    const stamped = stampFlowStart(this.env, input.ref, input.phase)
    this.deps.onFlowEnvChange?.()
    if (!stamped.ok) {
      this.deps.notify(
        `/flow ${input.ref}: ${stamped.reason} — aborting.`,
        'warning',
      )
      this.state = null
      this.deps.setActiveRef?.(null)
      return
    }
    this.state = {
      ref: input.ref,
      currentPhase: input.phase,
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: now(),
      promptInput: input.promptInput,
    }
    this.deps.setActiveRef?.(input.ref)
    this.deps.resetLandingState?.()
    await this.sendPhasePrompt(input.phase)
  }

  // AIDEV-NOTE: No abort flag needed — an aborted/escaped phase turn cannot
  // have landed its label, so the label check below halts it. A post-label
  // abort (Escape after completion) correctly still advances.
  async onSettled(): Promise<void> {
    if (this.state === null || !this.state.awaitingOutcome) return
    this.state.awaitingOutcome = false
    const phase = this.state.currentPhase
    const labels = await this.deps.readLabels(this.state.ref)
    if (labels === null) {
      await this.halt(phase, 'cannot read aven labels (fail-closed)')
      return
    }
    const label = PHASE_LABEL[phase]
    if (!labels.includes(label)) {
      if (this.deps.hasInFlightSubagent()) {
        const state = this.state
        if (state !== null) {
          state.awaitingOutcome = true
          this.deps.journal({
            kind: 'note',
            at: now(),
            ref: state.ref,
            text: `settled at ${phase} without the "${label}" label but a subagent is in flight — flow stays armed`,
          })
        }
        return
      }
      // AIDEV-NOTE: PMR-W60H — a plan settle without "planned" while the
      // spec is at plan-state=review is the expected approval gate, not a
      // failure: pause with clear wording (info, no "halted" note) so the
      // failure-style halt stays reserved for real misses. aven failure or
      // a missing field keeps the fail-closed halt. Resume: a later /flow
      // re-enters plan; after spec approval the refreshed prompt completes
      // the phase.
      if (phase === 'plan') {
        const planState = await this.deps.readPlanState(this.state.ref)
        if (planState === 'review') {
          const ref = this.state.ref
          const text = `flow paused at plan: awaiting spec approval (plan-state=review) — approve via the spec_approve tool or /spec-review, then rerun /flow ${ref} (typing 'implement' as a plain message does NOT restart the flow — agent: tell the human to run /flow ${ref} before any implement/validate work)`
          await this.deps.avenNote(ref, text)
          this.deps.journal({ kind: 'note', at: now(), ref, text })
          this.deps.notify(`/flow ${ref}: ${text}`, 'info')
          this.state = null
          clearFlowEnv(this.env)
          this.deps.onFlowEnvChange?.()
          this.deps.setActiveRef?.(null)
          this.deps.onRunEnd?.(ref)
          return
        }
      }
      // AIDEV-NOTE: PMR-69V8 — route-back is extension sequencing, not a
      // prompt instruction: validate settled unlabelled and the agent left a
      // fresh review-blockers note -> re-inject the implement prompt, bounded
      // by the same 3-attempt budget as implement/retry.ts (2 retries).
      if (phase === 'validate' && this.deps.hasFreshBlockers !== undefined) {
        const retried = await this.retryAfterBlockers(
          await this.deps.hasFreshBlockers(
            this.state.ref,
            this.state.validateStartedAt,
          ),
        )
        if (retried) return
      }
      await this.halt(
        phase,
        `phase completed without landing the "${label}" label`,
      )
      return
    }
    await this.advanceAfter(phase, labels)
  }

  private async retryAfterBlockers(hasBlockers: boolean): Promise<boolean> {
    const state = this.state
    if (state === null || !hasBlockers) return false
    if (state.blockerRetries >= MAX_ATTEMPTS - 1) {
      await this.halt(
        'validate',
        `review blockers persist after ${state.blockerRetries} implement retries (budget exhausted)`,
      )
      return true
    }
    state.blockerRetries += 1
    this.deps.journal({
      kind: 'note',
      at: now(),
      ref: state.ref,
      text: `validate left review blockers — re-running implement (retry ${state.blockerRetries}/${MAX_ATTEMPTS - 1})`,
    })
    this.deps.notify(
      `/flow ${state.ref}: validate left review blockers — re-running implement (retry ${state.blockerRetries}/${MAX_ATTEMPTS - 1})`,
      'info',
    )
    // AIDEV-NOTE: the blockers live in the aven note, not in loop state — the
    // suffix points the retried agent at it so the retry fixes something.
    await this.sendPhasePrompt('implement', fixRoundSuffix(state.ref))
    return true
  }

  private async halt(phase: Phase, reason: string): Promise<void> {
    const ref = this.state?.ref ?? ''
    const text = `flow halted at ${phase}: ${reason}`
    await this.deps.avenNote(ref, text)
    this.deps.journal({ kind: 'note', at: now(), ref, text })
    this.deps.notify(`/flow ${ref}: ${text}`, 'warning')
    this.state = null
    // AIDEV-NOTE: PMR-HFK1 — terminal transition: no child spawned from now
    // on may attribute to this (dead) run.
    clearFlowEnv(this.env)
    this.deps.onFlowEnvChange?.()
    this.deps.setActiveRef?.(null)
    if (ref.length > 0) this.deps.onRunEnd?.(ref)
  }

  private async sendPhasePrompt(phase: Phase, suffix = ''): Promise<void> {
    if (this.state === null) return
    const labels = await this.deps.readLabels(this.state.ref)
    if (labels === null) {
      await this.halt(phase, 'cannot read aven labels (fail-closed)')
      return
    }
    const result = await buildPhasePrompt(phase, {
      ...this.state.promptInput,
      labels,
      ...(phase === 'implement'
        ? {
            epicHasOpenChildren: await this.deps.epicHasOpenChildren(
              this.state.ref,
            ),
          }
        : {}),
    })
    if (result.kind === 'block') {
      await this.halt(phase, result.reason)
      return
    }
    this.deps.journal({
      kind: 'phase-start',
      at: now(),
      ref: this.state.ref,
      phase,
    })
    const sessionFile = this.deps.getSessionFile?.() ?? null
    if (sessionFile !== null && sessionFile.length > 0) {
      this.deps.journal({
        kind: 'main-session',
        at: now(),
        ref: this.state.ref,
        sessionFile,
      })
    }
    this.state.currentPhase = phase
    // AIDEV-NOTE: PMR-HFK1 — phase transitions re-stamp the env so children
    // spawned in later phases attribute to the phase doing the work.
    stampFlowPhase(this.env, phase)
    this.deps.onFlowEnvChange?.()
    if (phase === 'validate') this.state.validateStartedAt = now()
    this.deps.sendPrompt(result.prompt + suffix)
    this.state.awaitingOutcome = true
  }

  // AIDEV-NOTE: advanceAfter runs after a settled phase turn whose label
  // landed: journal completion, resolve the next phase from the SAME label
  // table /flow starts from (labels stay the run state), and inject the next
  // phase prompt. All labels present = flow done.
  private async advanceAfter(phase: Phase, labels: string[]): Promise<void> {
    const ref = this.state?.ref ?? ''
    this.deps.journal({
      kind: 'phase-complete',
      at: now(),
      ref,
      phase,
      label: PHASE_LABEL[phase],
    })
    const next = nextPhase(labels, this.state?.promptInput.mode)
    if (next.kind === 'done') {
      this.deps.journal({
        kind: 'note',
        at: now(),
        ref,
        text: 'flow complete — all phase labels present',
      })
      this.deps.notify(`/flow ${ref}: all phases complete.`, 'info')
      this.state = null
      clearFlowEnv(this.env)
      this.deps.onFlowEnvChange?.()
      this.deps.setActiveRef?.(null)
      this.deps.onRunEnd?.(ref)
      return
    }
    await this.sendPhasePrompt(next.phase)
  }
}

export function createFlowLoop(deps: FlowLoopDeps): FlowLoop {
  return new FlowLoopImpl(deps)
}

function fixRoundSuffix(ref: string): string {
  return `

FIX ROUND (automatic retry after validate): read the MOST RECENT aven note on ${ref} containing "reviewed-at:" (aven show ${ref} --full). It lists the review blockers or deviation report. Fix EVERY item in it first, then run tests and commit.`
}

function now(): string {
  return new Date().toISOString()
}
