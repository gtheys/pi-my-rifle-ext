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
import type { FlowRunEvent } from '../run-state.ts'
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
  /** Set an aven label on the ref; false = write failed. */
  avenSetLabel(ref: string, label: string): Promise<boolean>
  /** True when the ref is an epic with open children (implement routing guard). */
  epicHasOpenChildren(ref: string): Promise<boolean>
  /** True while this session has an in-flight subagent (mid-phase async wait). */
  hasInFlightSubagent(): boolean
  sendPrompt(prompt: string): void
}

export interface FlowStartInput {
  ref: string
  phase: Phase
  skipResearch: boolean
  researchSkip: boolean
  /** Per-run inputs for buildPhasePrompt (mode, gitRoot, workRoots, ...). */
  promptInput: Omit<PhasePromptInput, 'labels'>
}

interface FlowLoopState {
  ref: string
  currentPhase: Phase
  awaitingOutcome: boolean
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
  private state: FlowLoopState | null = null
  private skipResearch = false

  constructor(deps: FlowLoopDeps) {
    this.deps = deps
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
    this.state = {
      ref: input.ref,
      currentPhase: input.phase,
      awaitingOutcome: false,
      promptInput: input.promptInput,
    }
    this.skipResearch = input.skipResearch
    if (input.researchSkip) {
      await this.recordResearchSkip(input.ref)
    }
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
          const text = `flow paused at plan: awaiting spec approval (plan-state=review) — approve via the spec_approve tool or /spec-review, then rerun /flow ${ref}`
          await this.deps.avenNote(ref, text)
          this.deps.journal({ kind: 'note', at: now(), ref, text })
          this.deps.notify(`/flow ${ref}: ${text}`, 'info')
          this.state = null
          return
        }
      }
      await this.halt(
        phase,
        `phase completed without landing the "${label}" label`,
      )
      return
    }
    await this.advanceAfter(phase, labels)
  }

  // AIDEV-NOTE: the skip must be durable LABEL state (research-skipped),
  // not just a note — gates and the phase resolver read labels only. Label
  // write failure is best-effort: notify, keep running; /implement with the
  // CLI flag still works as fallback.
  private async recordResearchSkip(ref: string): Promise<void> {
    const reason =
      'research skip confirmed by user (--skip-research), no researched label'
    this.deps.journal({ kind: 'phase-skip', at: now(), ref, reason })
    await this.deps.avenNote(ref, reason)
    const labeled = await this.deps.avenSetLabel(ref, 'research-skipped')
    if (!labeled) {
      this.deps.notify(
        `/flow ${ref}: could not set the research-skipped label — /implement will ask for --skip-research`,
        'warning',
      )
    }
  }

  private async halt(phase: Phase, reason: string): Promise<void> {
    const ref = this.state?.ref ?? ''
    const text = `flow halted at ${phase}: ${reason}`
    await this.deps.avenNote(ref, text)
    this.deps.journal({ kind: 'note', at: now(), ref, text })
    this.deps.notify(`/flow ${ref}: ${text}`, 'warning')
    this.state = null
  }

  private async sendPhasePrompt(phase: Phase): Promise<void> {
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
    this.state.currentPhase = phase
    this.deps.sendPrompt(result.prompt)
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
    const next = nextPhase(labels, this.skipResearch)
    if (next.kind === 'done') {
      this.deps.journal({
        kind: 'note',
        at: now(),
        ref,
        text: 'flow complete — all phase labels present',
      })
      this.deps.notify(`/flow ${ref}: all phases complete.`, 'info')
      this.state = null
      return
    }
    await this.sendPhasePrompt(next.phase)
  }
}

export function createFlowLoop(deps: FlowLoopDeps): FlowLoop {
  return new FlowLoopImpl(deps)
}

function now(): string {
  return new Date().toISOString()
}
