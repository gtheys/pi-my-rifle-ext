// AIDEV-NOTE: PMR-0NRH 2.1 — generic ask emitter on the tool_call /
// tool_result(+tool_execution_end) hook pair. A plain ask_user_question
// issued inside an OPEN agent turn is invisible to settle-based v2 emission
// (the turn never settles while the ask blocks, so pi_flow_state keeps
// serving the last emitted value for the whole wait). This hook pair wraps
// the ask in the SAME open turn: journal state-change{waiting_human,
// human_ask_pending} on tool_call (Pi awaits the handler before executing the
// tool, so the line lands BEFORE the ask blocks) and state-change{running}
// when the call finalizes.
//
// TWO-TIER DEDUPE (the critical contract):
// - PRIMARY: skip the open outright when `parentToolCallId` is set — a nested
//   call is one made by another tool via ctx.executeTool, and such a tool
//   owns and journals its own wait (tools/code-review.ts does exactly this).
//   Nested calls re-fire the tool_call/tool_result handlers and carry
//   parentToolCallId with toolCallId assigned by Pi as `<parent id>/<n>` —
//   docs/extensions.md "Calling Other Tools". This check is deterministic and
//   does no journal I/O. It runs before ANY tracking, so a nested ask is never
//   counted here and its close is a Map miss (the owning tool closes its own
//   wait).
// - SECONDARY: for a non-nested open, scan the journal tail
//   (resumeV2StateFromEvents, last state-change wins) and skip if it already
//   reads waiting_human — covers a loop-owned wait (e.g.
//   subagent_ask_pending) and a second concurrent ask in this session. A
//   failed/unreadable journal degrades to "no open wait" (fail-open: a
//   possibly-duplicate waiting_human line is still honest evidence).
//
// AIDEV-NOTE: PMR-0NRH fix round (review blocker 1) — the dedupe above gates
// only the JOURNALING of the open, never the TRACKING of the ask, and the
// close is reference-counted and reason-checked. Why: pi runs the tool calls
// of one assistant message in PARALLEL by default — tool calls "run in
// parallel by default" (docs/extensions.md:2305) and sibling calls are
// "preflighted sequentially, then executed concurrently"
// (docs/extensions.md:979); ask_user_question declares no executionMode. In
// executeToolCallsParallel every prepareToolCall — i.e. every tool_call
// handler — therefore runs in the initial loop BEFORE Promise.all executes
// any tool. So a batch of N asks fires all N handlers up front: ask #1
// journals the open, asks #2..N hit the secondary dedupe and journal nothing,
// then the asks serialize on the shared UI lock. Ungated, ask #1's
// finalize would journal state-change{running} while ask #2 still blocked the
// human — the board flips to running, the Waiting-on-me row disappears, no
// desktop page fires, and human_ask_pending wait-seconds are under-counted.
// ask_user_question's own promptGuidelines tell the model to "make multiple
// separate ask_user_question tool calls instead of combining them", so
// batching is the encouraged shape, not a corner case.
//
// THE SEMANTICS NOW:
// 1. TRACKING (refcount + ref lookup): openAsks maps toolCallId -> ref for
//    EVERY tracked non-nested ask, inserted right after the toolName /
//    parentToolCallId / getActiveRef() / writer checks — i.e. whenever this
//    emitter is responsible for the ask — regardless of whether its open was
//    actually journaled.
// 2. REFCOUNTED CLOSE: finalize deletes the id and returns WITHOUT writing
//    while openAsks is still non-empty (other asks still block the human).
//    Only the finalize that empties the Map may close the wait.
// 3. REASON-CHECKED CLOSE: even when the Map is empty, re-read the journal
//    tail with projectRunState(events)?.currentState (CurrentStateRecord
//    carries the reason; resumeV2StateFromEvents only returns the state, which
//    is no longer enough here) and journal state-change{running} ONLY when
//    that tail is waiting_human with reason human_ask_pending, i.e. our wait
//    is the one still open. Any other reason (notably code_review_pending) or
//    any non-waiting_human tail means another seam owns the wait or it is
//    already closed — write nothing. That is what makes the batched
//    code_review case correct: a plain ask's close must not clear the gate's
//    still-open wait. The open side deliberately keeps resumeV2StateFromEvents
//    (state alone is enough to decide "a wait is already open", it scans raw
//    state-change lines so it works even on a journal whose run-start line is
//    missing, and it is the already-shipped behaviour for that decision).
// 4. FAIL CLOSED AT CLOSE: an unreadable/absent tail (readEvents rejects,
//    returns null, or a journal from which no currentState can be derived)
//    means NO running is journaled. This is the opposite of the fail-OPEN rule
//    on the open side, and the asymmetry is intentional: a false `running` is
//    the exact bug being fixed (it destroys the human wait — invisible ask,
//    no page, under-counted seconds) and cannot be undone from here, whereas a
//    stale `waiting_human` is recoverable — the loop's next
//    emitStateChange('running') is not a competing wait and still emits, so
//    the journal unsticks itself.
//
// MAP-GATED CLOSE: openAsks (toolCallId -> ref) guarantees a close can NEVER
// fire for a call this emitter did not open (defence in depth for tool-owned
// nested asks), delete-on-first-close makes tool_result-then-
// tool_execution_end emit exactly ONE running record, and an id is only
// remembered when writer.record actually returned true (a failed open must
// not produce a close).
// AIDEV-NOTE: PMR-0NRH fix round — SUPERSEDED in part by the refcount above:
// an id is now remembered for every tracked ask whether or not its open write
// landed, so the record() boolean no longer decides tracking. The property
// that note protected (a failed open must not produce an orphan close) still
// holds, now enforced one level later: the failed write never reached the
// journal, so at close time the tail does not read our wait and rule 3 above
// writes nothing.
//
// NEVER-THROW (ISC-A-5): handler bodies swallow all errors — a journal
// failure must never fail the ask or the tool call. OPTIONAL WRITER
// (ISC-A-2): deps.writer undefined = complete no-op, zero events. The
// emitter never imports or constructs a writer itself — index.ts passes THE
// single wrapped fan-out writer so onV2StateChangeObserved keeps the loop
// guard in sync (single-writer seam).

import type { FlowRunEvent } from '../run-state.ts'
import { projectRunState } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { resumeV2StateFromEvents } from './loop.ts'

export interface AskEmitterDeps {
  /** The session's active flow ref (loop.activeRef()); null = no run bound. */
  getActiveRef: () => string | null
  /** THE wrapped fan-out writer (index.ts:537). Optional = no-op (ISC-A-2). */
  writer?: EventWriter
  /** Journal read for the dedupe scan: readRunEvents(getAgentDir(), ref). */
  readEvents: (ref: string) => Promise<readonly FlowRunEvent[] | null>
  now: () => string
}

export interface AskEmitter {
  /** pi.on('tool_call', …) — journals the open before the ask blocks. */
  onToolCall: (event: {
    toolName: string
    toolCallId: string
    /** Present when another tool made this call (docs/extensions.md:2794). */
    parentToolCallId?: string
  }) => Promise<void>
  /** pi.on('tool_result'|'tool_execution_end', …) — journals the close, first-wins. */
  onToolFinalized: (event: { toolCallId: string }) => Promise<void>
}

export function createAskEmitter(deps: AskEmitterDeps): AskEmitter {
  // In-flight asks this emitter is responsible for: toolCallId -> ref. Doubles
  // as the refcount that keeps a parallel batch's close from firing early.
  const openAsks = new Map<string, string>()
  const closeAsk = async (event: { toolCallId: string }): Promise<void> => {
    try {
      const ref = openAsks.get(event.toolCallId)
      if (ref === undefined) return // never close a call this emitter did not track
      openAsks.delete(event.toolCallId)
      // REFCOUNT: another ask in the batch is still blocking the human.
      if (openAsks.size > 0) return
      if (deps.writer === undefined) return
      const events = await deps.readEvents(ref)
      // FAIL CLOSED: an unreadable tail must not buy a false `running`.
      if (events === null) return
      const tail = projectRunState(events)?.currentState
      if (tail === undefined) return
      // REASON CHECK: only close the wait this seam opened.
      if (tail.state !== 'waiting_human') return
      if (tail.reason !== 'human_ask_pending') return
      await deps.writer.record({
        kind: 'state-change',
        at: deps.now(),
        ref,
        state: 'running',
      })
    } catch {
      // never-throw (ISC-A-5)
    }
  }
  return {
    onToolCall: async (event) => {
      try {
        if (event.toolName !== 'ask_user_question') return
        // PRIMARY dedupe: a nested ask is owned by a tool that journals its
        // own wait (code_review does) — deterministic, no journal I/O, and it
        // must happen before tracking so such an ask is never counted here.
        if (event.parentToolCallId !== undefined) return
        const ref = deps.getActiveRef()
        if (ref === null) return
        if (deps.writer === undefined) return
        // Track every in-flight ask this emitter is responsible for, whether
        // or not the open below is journaled (parallel batches ask #2..N are
        // deduped on the journal yet still block the human).
        openAsks.set(event.toolCallId, ref)
        // SECONDARY dedupe (journaling only): a non-nested open while a
        // waiting_human is already journaled (loop-owned wait, or ask #2..N of
        // a parallel batch whose sibling just opened the wait).
        const events = await deps.readEvents(ref)
        if (resumeV2StateFromEvents(events) === 'waiting_human') return
        await deps.writer.record({
          kind: 'state-change',
          at: deps.now(),
          ref,
          state: 'waiting_human',
          reason: 'human_ask_pending',
        })
      } catch {
        // never-throw (ISC-A-5)
      }
    },
    onToolFinalized: closeAsk,
  }
}
