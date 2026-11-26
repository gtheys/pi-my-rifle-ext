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
// AIDEV-NOTE: PMR-XTQQ — the loop is journaled: every transition emits a
// loop-state snapshot (flow/resume.ts reads them back), and /flow re-entry
// seeds `resume` from the journal so a restart restores the blocker-retry
// budget and the validate blockers-note cutoff exactly.
import { MAX_ATTEMPTS } from '../implement/retry.ts'
import type { FlowPhase, FlowRunEvent, LoopRunStatus } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import {
  clearFlowEnv,
  type FlowEnv,
  stampFlowPhase,
  stampFlowStart,
} from './attribution.ts'
import { nextPhase, PHASE_LABEL, type Phase } from './orchestrate.ts'
import { buildPhasePrompt, type PhasePromptInput } from './phase-prompts.ts'
import { FLOW_STATES, type FlowReason, type FlowState } from './vocabulary.ts'
import { type FlowWorktree, getFlowWorktree } from './worktree-context.ts'

export interface FlowLoopDeps {
  notify(message: string, level: 'info' | 'warning'): void
  /** Best-effort journal write; must never throw. */
  journal(event: FlowRunEvent): void
  /**
   * AIDEV-NOTE: PMR-ZV9Y 2.1 — best-effort v2 state-machine emission seam
   * (`state-change`/`step-start`/`step-stop`). Optional and routed in index.ts
   * to the SAME journal() writer as `journal`, so the durable run journal and
   * the later telemetry fan-out (PMR-ZV9Y phase 4) see every v2 event. It is a
   * SEPARATE dep name on purpose: the existing loop.test.ts / flow.test.ts
   * harnesses never set it, so their exact `h.events` kind-sequence assertions
   * stay byte-identical (ISC-A-2 — the v1 loop-state stream is untouched).
   * The loop wraps the call in a try/catch, so a throwing seam must NEVER
   * propagate into a phase (ISC-A-5).
   */
  journalV2?(event: FlowRunEvent): void
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
   * yolo 5.1 — apply the `error` TYPE label on the ref (bootstrap included);
   * false = write failed. Optional so existing tests/consumers need no
   * changes. AIDEV-NOTE: `error` is a type label, deliberately outside
   * lifecycleLabelMutation, applied only for yolo runs on halt.
   */
  avenLabel?(ref: string, label: string): Promise<boolean>
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
  /**
   * AIDEV-NOTE: PMR-81SX — best-effort post-success cleanup, called ONCE in
   * advanceAfter's done branch AFTER loop-state teardown (snapshot done, state
   * null, env cleared, active ref cleared). Never called on halt/pause (those
   * fire onRunEnd — do not piggyback). The loop defensively try/catches this:
   * a throwing implementation must never break the run end. Optional so
   * existing tests/consumers need no changes. worktree is the binding captured
   * BEFORE teardown (getFlowWorktree()) — it is already cleared by the time
   * this runs; the explicit ref is also what cleanup's effects declaration
   * must carry (never the 'worktree-ops' fallback).
   */
  onFlowDone?: (
    ref: string,
    mode: 'work' | 'personal',
    worktree: FlowWorktree | undefined,
  ) => Promise<void>
  // AIDEV-NOTE: PMR-VZEV — clears the landing state (authorized +
  // humanReviewPassed) on every start so stale authorization from a
  // superseded/prior flow cannot authorize a later landing.
  resetLandingState?(): void
}

export interface FlowStartInput {
  ref: string
  /** Ref the run is tracked by (Jira key in work mode); defaults to `ref`. */
  trackRef?: string
  phase: Phase
  /** Per-run inputs for buildPhasePrompt (mode, gitRoot, workRoots, ...). */
  promptInput: Omit<PhasePromptInput, 'labels'>
  /** /flow --yolo: propagate the mode onto the prompt input + env stamp. */
  yolo?: boolean
  /**
   * AIDEV-NOTE: PMR-XTQQ phase 2 — resume seed from the journal tail
   * (flow/resume.ts). Restores blockerRetries and validateStartedAt exactly;
   * absent → today's zero-defaults (back-compat). Phase position is never
   * seeded — aven labels re-derive it.
   */
  resume?: { blockerRetries: number; validateStartedAt: string }
  /**
   * AIDEV-NOTE: PMR-ZV9Y 2.1 — v2 emission guard seed. The last state this
   * run emitted (journal tail) so a restart/resume does NOT re-emit it. When
   * absent the loop seeds from the journal itself in start()/resume (see
   * resumeV2StateFromEvents). Explicitly seeded on the index.ts resume path.
   */
  resumeState?: FlowState
  /**
   * AIDEV-NOTE: PMR-ZV9Y 2.1 — seed the plan.spec-approval pairing flag from
   * the journal tail on a cross-process resume (true when a step-start for
   * plan.spec-approval was journaled without a matching step-stop). Absent on
   * a fresh start; on a same-instance restart index.ts supplies the derived
   * value so the stop stays paired with the start. See resumeV2StateFromEvents.
   */
  resumePlanApprovalOpen?: boolean
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
  /**
   * AIDEV-NOTE: PMR-ZV9Y fix round (P1 blocker) — invalidate the loop's guarded
   * v2 emission (`lastEmittedV2`) when a v2 `state-change` for the ACTIVE ref is
   * journaled by a SEAM the loop does not run through itself (the tools).
   * `run_attempt` escalate (`waiting_human{escalation}`) and
   * `deviation_review` rerun (`waiting_machine{deviation_gate_rerun}`) journal a
   * wait through the shared fan-out writer but never journal the running return;
   * the loop's instance field would stay pinned at `running`, so the next
   * `snapshot('running')` (sendPhasePrompt / retryAfterBlockers) is
   * guard-suppressed and `pi_flow_state` stays stuck at the wait while the flow
   * is actively working (false waiting-on-human page, phantom Waiting-on-me row,
   * wait-seconds mis-attribution). index.ts calls this from the fan-out writer's
   * `onV2StateChangeObserved` observer — THE single choke point that sees every
   * journaled v2 event (see the telemetry/dispatch.ts seam map), so no journal
   * re-read. Setting `lastEmittedV2` to the value the loop just emitted is a
   * harmless no-op (the loop's own emissions pass the same observer): the update
   * is guarded by ref (a foreign run never touches this run's guard) and is
   * idempotent.
   *
   * AIDEV-NOTE: PMR-ZV9Y fix-round-2 (P2a) — the observer is MONOTONIC on the
   * event timestamp `at`. Tool v2 writes bypass `journalSerial` (run-attempt /
   * deviation go straight to `writer.record`), so an already-enqueued loop
   * `running` event can route AFTER a tool's later `waiting_human`: without a
   * recency guard route(waiting_human) sets the guard, then the late
   * route(running echo) resets it to `running` and the next differing snapshot
   * is suppressed again — the original P1 symptom in a narrow window. So an
   * external update whose `at` is older-or-equal than the last applied
   * observation is ignored. `at` is always `new Date().toISOString()` (loop
   * `now()`, the tools, run-state.recordRunEvent) — a fixed-width UTC-`Z`
   * format, so a plain lexicographic string compare is a correct chronological
   * compare (no timezone/locale drift, same precision everywhere). `lastV2At`
   * is set by BOTH this method and the loop's own `emitStateChange`; the loop's
   * own emission is never recency-blocked (it writes the guard unconditionally),
   * so a stale future-dated external write can never lock the loop out.
   */
  noteExternalV2State(ref: string, state: FlowState, at: string): void
}

class FlowLoopImpl implements FlowLoop {
  private readonly deps: FlowLoopDeps
  private readonly env: FlowEnv
  private state: FlowLoopState | null = null
  // one-shot: the first sendPhasePrompt after a resumed start must not
  // overwrite the seeded validateStartedAt (blockers-note cutoff)
  private pendingResume = false
  // AIDEV-NOTE: PMR-ZV9Y 2.1 — guarded v2 emission: the last state-machine
  // state this run emitted. emitStateChange skips when the new state equals
  // this, so running->running re-snapshots never spam the journal (plan
  // "no running→running duplicates"). Seeded on start()/resume from the
  // journal tail (last state-change, else derived via the phase-1 fold).
  private lastEmittedV2: FlowState | null = null
  // AIDEV-NOTE: PMR-ZV9Y fix-round-2 (P2a) — recency watermark for the external
  // observer. The ISO-8601 `at` of the last v2 observation applied to
  // lastEmittedV2, set by BOTH emitStateChange and noteExternalV2State. Fixed-
  // width UTC-`Z` format everywhere, so string compare == chronological compare.
  // null = nothing applied yet (the first external observation always wins).
  private lastV2At: string | null = null
  // AIDEV-NOTE: PMR-ZV9Y 2.1 — pairing guard for plan.spec-approval. The
  // spec-approval pause journals step-start; the step-stop is emitted where
  // the plan phase completes (advanceAfter). This flag keeps them paired so an
  // orphan stop never appears when a run never paused for approval. Seeded on
  // a cross-process resume from the journal tail (resumePlanApprovalOpen).
  private specApprovalStepOpen = false

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

  // AIDEV-NOTE: PMR-ZV9Y fix round (P1 blocker) + fix-round-2 (P2a) — see the
  // FlowLoop method doc. Invalidates the guarded v2 emission when a state-change
  // for the ACTIVE run is journaled through the shared fan-out observer by a tool
  // seam (not the loop's own emitStateChange path). The `state` is re-written
  // into lastEmittedV2 so the loop's next DIFFERING emission is not suppressed.
  // Ref-guarded (a foreign run never moves this run's guard), vocabulary-guarded,
  // and MONOTONIC on `at`: an observation older-or-equal than the last applied
  // one is ignored, so a late-routed loop echo cannot revert the guard to a stale
  // state (a tool write bypasses journalSerial and can route after the loop's
  // queued running event). The loop's own emissions also pass the observer:
  // writing the just-emitted state back is a harmless idempotent no-op — and the
  // echo's `at` equals lastV2At so it is recency-skipped, never a re-pin.
  noteExternalV2State(ref: string, state: FlowState, at: string): void {
    if (this.state === null) return
    if (this.state.ref !== ref) return
    if (!FLOW_STATES.includes(state)) return
    if (this.lastV2At !== null && at <= this.lastV2At) return
    this.lastEmittedV2 = state
    this.lastV2At = at
  }

  async start(input: FlowStartInput): Promise<void> {
    // AIDEV-NOTE: PMR-ZRMQ — yolo is PERSONAL-mode only. The prompt layer
    // already keeps work prompts gate-full, but the receipt-gate exemptions
    // (phase-complete.ts / spec-approve.ts) fire on the journaled yolo bit
    // regardless of mode; loop start is the single choke point covering the
    // --yolo flag, config yolo, and journaled-seed resumes alike, so refuse
    // loudly here instead of letting a work-mode run silently skip the
    // human receipt gates.
    if (input.yolo === true && input.promptInput.mode === 'work') {
      this.deps.notify(
        `/flow ${input.ref}: --yolo is personal-mode only — refusing to start a work-mode run without the receipt gates. Remove --yolo (or the yolo config) to run here.`,
        'warning',
      )
      return
    }
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
    const stamped = stampFlowStart(
      this.env,
      input.ref,
      input.phase,
      undefined,
      {
        trackRef: input.trackRef,
        mode: input.promptInput.mode,
        yolo: input.yolo,
      },
    )
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
    const resume = input.resume
    const resumed = resume !== undefined
    // AIDEV-NOTE: PMR-ZV9Y 2.1 — seed the guarded v2 state and the
    // plan.spec-approval pairing flag from the journal tail (index.ts derives
    // both via resumeV2StateFromEvents / resumePlanApprovalOpenFromEvents).
    // When resumeState is absent the guard starts from null so the first
    // snapshot('running') below emits; an explicit 'running' seed suppresses
    // the re-emit. resumePlanApprovalOpen is only overridden when supplied, so
    // a same-instance restart keeps the open start set by the earlier pause.
    if (input.resumeState !== undefined) {
      this.lastEmittedV2 = input.resumeState
    } else {
      this.lastEmittedV2 = null
    }
    // PMR-ZV9Y fix-round-2 (P2a): a fresh/superseding start resets the recency
    // watermark so a stale `at` from the previous run can never recency-block the
    // new run's external observations. The seed's own timestamp is unknown here
    // (only the state is threaded through resumeState), so null = the first
    // observation (the loop's own emit below or a tool write) always applies.
    this.lastV2At = null
    if (input.resumePlanApprovalOpen !== undefined) {
      this.specApprovalStepOpen = input.resumePlanApprovalOpen
    }
    if (resumed) {
      this.state = {
        ref: input.ref,
        currentPhase: input.phase,
        awaitingOutcome: false,
        blockerRetries: resume.blockerRetries,
        validateStartedAt: resume.validateStartedAt,
        promptInput: input.promptInput,
      }
    } else {
      this.state = {
        ref: input.ref,
        currentPhase: input.phase,
        awaitingOutcome: false,
        blockerRetries: 0,
        validateStartedAt: now(),
        promptInput: input.promptInput,
      }
    }
    // AIDEV-NOTE: PMR-ZV9Y 2.1 — spec-approval step-stop at the EARLIEST
    // faithful restart site. Spec Behaviour 3 (plan.md:68) requires the journal
    // ORDER `step-stop{plan.spec-approval}` THEN `state-change{running}`: the
    // approval wait ends when the loop is RE-ENTERED after /flow answer, and
    // `specApprovalStepOpen` (seeded from the journal tail on a cross-process
    // resume, or kept set by this same instance's earlier pause) is exactly
    // "the step is still open". Closing it HERE — before the running snapshot
    // below — (a) orders the journal as the spec says, (b) bounds
    // pi_flow_step_seconds / the Tempo span to the approval wait instead of
    // stretching it to the plan phase-complete, and (c) guarantees a stop even
    // when the restarted run HALTS before plan completes. It is
    // PHASE-INDEPENDENT on purpose: /flow answer approve moves plan-state to
    // approved so the restart can re-enter at implement, where the old
    // advanceAfter-only close (gated on `phase === 'plan'`) would never fire
    // and the step would leak. /flow answer reject routes the spec back to
    // draft (more plan work, no label) — the wait STILL ENDED, so step-stop is
    // correct there too; both answers restart the loop and neither keeps the
    // approval step open. This does NOT replace the advanceAfter close, it
    // pre-empts it: the flag is cleared here, so the same `if (phase === 'plan'
    // && this.specApprovalStepOpen)` guard in advanceAfter (kept as an
    // idempotent fallback for the same-instance pause→advance path that skips a
    // fresh start) cannot double-stop — at-most-once is guaranteed by the flag.
    if (this.specApprovalStepOpen) {
      this.emitStep('step-stop', 'plan', 'plan.spec-approval')
      this.specApprovalStepOpen = false
    }
    // AIDEV-NOTE: PMR-XTQQ — loop-state snapshot journaling: budget and
    // cutoff live on the journal so a restart restores them; cleared only
    // by terminal snapshots.
    this.pendingResume = resumed
    this.snapshot('running')
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
      await this.halt(
        phase,
        'cannot read aven labels (fail-closed)',
        'aven_read_failed',
      )
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
          // AIDEV-NOTE: PMR-ZV9Y 2.1 (ISC-7) — this branch has NO loop-state
          // snapshot, so the waiting state would be invisible to v2 without an
          // explicit emission. The next settle that advances runs
          // snapshot('running') (via sendPhasePrompt), which is a different
          // state than waiting_machine so it emits the return transition.
          this.emitStateChange('waiting_machine', 'subagent_in_flight')
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
          const text = `flow paused at plan: awaiting spec approval (plan-state=review) — approve via /flow answer ${ref} approve (human-only), then rerun /flow ${ref} (typing 'implement' as a plain message does NOT restart the flow — agent: tell the human to run /flow ${ref} before any implement/validate work)`
          await this.deps.avenNote(ref, text)
          this.deps.journal({ kind: 'note', at: now(), ref, text })
          this.deps.notify(`/flow ${ref}: ${text}`, 'info')
          // AIDEV-NOTE: PMR-ZV9Y 2.1 — spec-approval pause maps to v2
          // waiting_human{spec_approval_pending} (paused) PLUS the
          // plan.spec-approval step boundary. The matching step-stop is emitted
          // at the EARLIEST restart site — start(), when the seeded
          // specApprovalStepOpen flag says the step is still open (fix-round-3,
          // deviation #1) — ordered BEFORE the running snapshot, with the
          // advanceAfter plan phase-complete close kept as an idempotent
          // fallback for the same-instance pause→advance path. The
          // specApprovalStepOpen flag pairs them so a run that never paused
          // emits no orphan stop and at-most-once stop is journaled.
          this.snapshot('paused', 'spec_approval_pending')
          this.emitStep('step-start', 'plan', 'plan.spec-approval')
          this.specApprovalStepOpen = true
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
        'label_miss',
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
        'blocker_budget_exhausted',
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
    // AIDEV-NOTE: journal AFTER incrementing so a restart restores the
    // incremented budget, not the pre-retry one.
    this.snapshot('running')
    this.deps.notify(
      `/flow ${state.ref}: validate left review blockers — re-running implement (retry ${state.blockerRetries}/${MAX_ATTEMPTS - 1})`,
      'info',
    )
    // AIDEV-NOTE: the blockers live in the aven note, not in loop state — the
    // suffix points the retried agent at it so the retry fixes something.
    await this.sendPhasePrompt('implement', fixRoundSuffix(state.ref))
    return true
  }

  // AIDEV-NOTE: PMR-ZV9Y 2.1 — `v2reason` is the closed-enum halt reason
  // mapped onto the `state-change{halted, ...}` emission (default
  // `label_miss` — the generic halt). The free-text `reason` stays the
  // journal-note/halt-record text; it is NEVER a label value (ISC-A-1).
  private async halt(
    phase: Phase,
    reason: string,
    v2reason: FlowReason = 'label_miss',
  ): Promise<void> {
    const ref = this.state?.ref ?? ''
    const text = `flow halted at ${phase}: ${reason}`
    await this.deps.avenNote(ref, text)
    // AIDEV-NOTE: yolo 5.1 — halted yolo runs get the `error` type label,
    // best-effort and BEFORE the terminal snapshot (the journal is the
    // durable halt record; the label marks the outcome). `error` is a type
    // label, deliberately outside lifecycleLabelMutation, and only applied
    // for yolo runs. A failing/throwing label write never masks the halt:
    // it is journaled and the loop continues tearing down.
    if (this.state?.promptInput.yolo === true && this.deps.avenLabel) {
      let labeled = false
      try {
        labeled = await this.deps.avenLabel(ref, 'error')
      } catch {
        labeled = false
      }
      if (!labeled) {
        const note = `failed to apply the "error" label on ${ref} (non-fatal)`
        this.deps.journal({ kind: 'note', at: now(), ref, text: note })
      }
    }
    this.deps.journal({ kind: 'note', at: now(), ref, text })
    this.deps.notify(`/flow ${ref}: ${text}`, 'warning')
    this.snapshot('halted', v2reason)
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
      await this.halt(
        phase,
        'cannot read aven labels (fail-closed)',
        'aven_read_failed',
      )
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
      await this.halt(phase, result.reason, 'prompt_send_failed')
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
    // AIDEV-NOTE: PMR-T9ZQ 1.2 — owner identity refresh on every phase
    // prompt. PROJECTED event (deps.journal routes to the projecting
    // writer.record), unlike the journal-only 'main-session' above: the
    // parked-run resume picker reads state.owner from the projection.
    // Journaled even when the session file is unknown — pid is the liveness
    // carrier. Best-effort: the journal dep contract is "never throws" and
    // production wires it to writer.record, which swallows io errors.
    this.deps.journal({
      kind: 'owner-session',
      at: now(),
      ref: this.state.ref,
      sessionFile,
      pid: process.pid,
    })
    this.state.currentPhase = phase
    // AIDEV-NOTE: PMR-HFK1 — phase transitions re-stamp the env so children
    // spawned in later phases attribute to the phase doing the work.
    stampFlowPhase(this.env, phase)
    this.deps.onFlowEnvChange?.()
    if (phase === 'validate' && !this.pendingResume) {
      this.state.validateStartedAt = now()
    }
    this.pendingResume = false
    this.deps.sendPrompt(result.prompt + suffix)
    this.state.awaitingOutcome = true
    this.snapshot('running')
  }

  // AIDEV-NOTE: PMR-XTQQ — loop-state snapshot: journaled at start, every
  // phase prompt (awaitingOutcome=true, running), the plan-approval pause
  // (paused, awaitingOutcome=false — phase-3's pending protocol parks ONLY
  // on awaitingOutcome=true + running), every retry increment, and on the
  // terminal transitions (halted/done). Last-wins in the projection.
  private snapshot(status: LoopRunStatus, v2reason?: FlowReason): void {
    if (this.state === null) return
    this.deps.journal({
      kind: 'loop-state',
      at: now(),
      ref: this.state.ref,
      loop: {
        phase: this.state.currentPhase,
        awaitingOutcome: this.state.awaitingOutcome,
        blockerRetries: this.state.blockerRetries,
        validateStartedAt: this.state.validateStartedAt,
        status,
      },
    })
    // AIDEV-NOTE: PMR-ZV9Y 2.1 — snapshot is the v1 choke point AND the v2
    // one: every status transition maps to exactly one state-change. `v2reason`
    // is passed per-site because the choke point cannot always know it (all
    // halts map to v2 `halted` but carry different reasons — aven_read_failed,
    // blocker_budget_exhausted, prompt_send_failed, label_miss; paused maps to
    // waiting_human but only the spec-approval pause has a reason). running/done
    // carry none. The emission is guarded (see emitStateChange).
    this.emitStateChange(v2StateForStatus(status), v2reason)
  }

  // AIDEV-NOTE: PMR-ZV9Y 2.1 — guarded v2 state-change emission. Skips when the
  // new state equals the last one this instance emitted (seeded from the
  // journal tail), so the repeated snapshot('running') at every phase prompt
  // never spams running->running and a resume does not re-emit its seeded
  // state. `reason` is dropped when the state carries none. The journalV2 seam
  // is optional and wrapped, so a throwing/absent seam NEVER propagates
  // (ISC-A-5) — the loop always proceeds.
  private emitStateChange(state: FlowState, reason?: FlowReason): void {
    if (this.state === null) return
    if (this.lastEmittedV2 === state) return
    this.lastEmittedV2 = state
    const event: FlowRunEvent = {
      kind: 'state-change',
      at: now(),
      ref: this.state.ref,
      state,
    }
    // PMR-ZV9Y fix-round-2 (P2a): the loop's OWN emission advances the recency
    // watermark unconditionally (no comparison) — so a future-dated stale external
    // write can never lock the loop out of emitting. The echo of this same event
    // back through noteExternalV2State carries at === lastV2At, so it is
    // recency-skipped (older-or-equal): the idempotent no-op holds.
    this.lastV2At = event.at
    if (reason !== undefined) {
      event.reason = reason
    }
    this.emitV2(event)
  }

  // AIDEV-NOTE: PMR-ZV9Y 2.1 — journal-only v2 step boundary. step-start and
  // step-stop are NOT state-guarded (they are paired evidence, not a
  // last-wins state); they still route through the same never-throw seam.
  private emitStep(
    kind: 'step-start' | 'step-stop',
    phase: FlowPhase,
    step: string,
  ): void {
    if (this.state === null) return
    this.emitV2({
      kind,
      at: now(),
      ref: this.state.ref,
      phase,
      step,
    })
  }

  // AIDEV-NOTE: PMR-ZV9Y 2.1 — the single best-effort v2 write. journalV2 is
  // optional (older harnesses/consumers omit it → no-op) and wrapped so a
  // throwing seam is swallowed; the loop must NEVER halt on a telemetry write.
  private emitV2(event: FlowRunEvent): void {
    try {
      this.deps.journalV2?.(event)
    } catch {
      // best-effort — never-throw (ISC-A-5)
    }
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
    // AIDEV-NOTE: PMR-ZV9Y 2.1 — spec-approval step-stop (IDEMPOTENT FALLBACK
    // only). The PRIMARY close is now in start() (fix-round-3, deviation #1):
    // a restart-after-answer emits step-stop BEFORE the running snapshot. This
    // plan phase-complete close stays for the SAME-INSTANCE pause→advance path
    // that reaches advanceAfter without a fresh start() — e.g. the loop pauses
    // for approval, the human answers, and the next onSettled lands the label
    // on the still-running instance. It is guarded by the SAME
    // specApprovalStepOpen flag start() clears, so it can never double-emit: at
    // most one stop is ever journaled. `this.state` is still set here
    // (teardown happens only in the done branch below).
    if (phase === 'plan' && this.specApprovalStepOpen) {
      this.emitStep('step-stop', 'plan', 'plan.spec-approval')
      this.specApprovalStepOpen = false
    }
    const next = nextPhase(labels, this.state?.promptInput.mode)
    if (next.kind === 'done') {
      this.deps.journal({
        kind: 'note',
        at: now(),
        ref,
        text: 'flow complete — all phase labels present',
      })
      this.deps.notify(`/flow ${ref}: all phases complete.`, 'info')
      const doneState = this.state
      if (doneState === null) return
      const doneRef = doneState.ref
      const doneMode = doneState.promptInput.mode
      const doneWorktree = getFlowWorktree() ?? undefined
      this.snapshot('done')
      this.state = null
      clearFlowEnv(this.env)
      this.deps.onFlowEnvChange?.()
      this.deps.setActiveRef?.(null)
      this.deps.onRunEnd?.(ref)
      if (this.deps.onFlowDone) {
        try {
          await this.deps.onFlowDone(doneRef, doneMode, doneWorktree)
        } catch {
          // AIDEV-NOTE: PMR-81SX — cleanup is best-effort; a failure here must
          // never surface as a run failure. The worktree simply stays.
        }
      }
      return
    }
    await this.sendPhasePrompt(next.phase)
  }
}

export function createFlowLoop(deps: FlowLoopDeps): FlowLoop {
  return new FlowLoopImpl(deps)
}

// AIDEV-NOTE: PMR-ZV9Y 2.1 — the v1 `LoopRunStatus` → v2 `FlowState` map (the
// snapshot choke point's status is v1; the state-change it emits is v2).
// running→running, paused→waiting_human, halted→halted, done→done. waiting_
// machine is never reached through this map (only the subagent-in-flight
// branch emits it, and that site has no snapshot — see onSettled).
function v2StateForStatus(status: LoopRunStatus): FlowState {
  if (status === 'running') {
    return 'running'
  }
  if (status === 'paused') {
    return 'waiting_human'
  }
  if (status === 'halted') {
    return 'halted'
  }
  return 'done'
}

/**
 * AIDEV-NOTE: PMR-ZV9Y 2.1 — seed the loop's guarded v2 emission state from
 * the journal tail: the LAST `state-change` event wins (validated against the
 * closed enum — journals parse leniently, same posture as applyEvent), else
 * derived from the projected v1 loop status via the phase-1 fold + the
 * v1→v2 map. `undefined` = nothing seeded (fresh run / no journal), so the
 * first snapshot('running') emits.
 */
export function resumeV2StateFromEvents(
  events: readonly FlowRunEvent[] | null,
): FlowState | undefined {
  if (events === null) {
    return undefined
  }
  let last: FlowState | undefined
  for (const event of events) {
    if (event.kind !== 'state-change') {
      continue
    }
    if (!FLOW_STATES.includes(event.state)) {
      continue
    }
    last = event.state
  }
  if (last !== undefined) {
    return last
  }
  const projected = projectRunState(events)
  if (projected !== null && projected.loop !== undefined) {
    return v2StateForStatus(projected.loop.status)
  }
  return undefined
}

/**
 * AIDEV-NOTE: PMR-ZV9Y 2.1 — is a plan.spec-approval step open on resume? A
 * restart after the spec-approval pause must still emit the matching
 * step-stop; this flag (seeded here from the raw step events) drives the
 * pairing guard in advanceAfter so only a real, unresolved start yields a
 * stop. The step boundary is journaled-only evidence, so the scan is over the
 * raw event list, not the projection.
 */
export function resumePlanApprovalOpenFromEvents(
  events: readonly FlowRunEvent[] | null,
): boolean {
  if (events === null) {
    return false
  }
  let open = false
  for (const event of events) {
    if (event.kind !== 'step-start' && event.kind !== 'step-stop') {
      continue
    }
    if (event.phase !== 'plan' || event.step !== 'plan.spec-approval') {
      continue
    }
    if (event.kind === 'step-start') {
      open = true
    }
    if (event.kind === 'step-stop') {
      open = false
    }
  }
  return open
}

function fixRoundSuffix(ref: string): string {
  return `

FIX ROUND (automatic retry after validate): read the MOST RECENT aven note on ${ref} containing "reviewed-at:" (aven show ${ref} --full). It lists the review blockers or deviation report. Fix EVERY item in it first, then run tests and commit.`
}

function now(): string {
  return new Date().toISOString()
}
