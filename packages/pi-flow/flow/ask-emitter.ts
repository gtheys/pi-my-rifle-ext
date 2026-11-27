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
//   does no journal I/O.
// - SECONDARY: for a non-nested open, scan the journal tail
//   (resumeV2StateFromEvents, last state-change wins) and skip if it already
//   reads waiting_human — covers a loop-owned wait (e.g.
//   subagent_ask_pending) and a second concurrent ask in this session. A
//   failed/unreadable journal degrades to "no open wait" (fail-open: a
//   possibly-duplicate waiting_human line is still honest evidence).
//
// MAP-GATED CLOSE: openAsks (toolCallId -> ref) guarantees a close can NEVER
// fire for a call this emitter did not open (defence in depth for tool-owned
// nested asks), delete-on-first-close makes tool_result-then-
// tool_execution_end emit exactly ONE running record, and an id is only
// remembered when writer.record actually returned true (a failed open must
// not produce a close).
//
// NEVER-THROW (ISC-A-5): handler bodies swallow all errors — a journal
// failure must never fail the ask or the tool call. OPTIONAL WRITER
// (ISC-A-2): deps.writer undefined = complete no-op, zero events. The
// emitter never imports or constructs a writer itself — index.ts passes THE
// single wrapped fan-out writer so onV2StateChangeObserved keeps the loop
// guard in sync (single-writer seam).

import type { FlowRunEvent } from '../run-state.ts'
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
  const openAsks = new Map<string, string>() // toolCallId -> ref
  const closeAsk = async (event: { toolCallId: string }): Promise<void> => {
    try {
      const ref = openAsks.get(event.toolCallId)
      if (ref === undefined) return // never close a call this emitter did not open
      openAsks.delete(event.toolCallId)
      if (deps.writer === undefined) return
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
        // own wait (code_review does) — deterministic, no journal I/O.
        if (event.parentToolCallId !== undefined) return
        const ref = deps.getActiveRef()
        if (ref === null) return
        if (deps.writer === undefined) return
        // SECONDARY dedupe: a non-nested open while a waiting_human is
        // already journaled (loop-owned wait, or a concurrent ask in this
        // session).
        const events = await deps.readEvents(ref)
        if (resumeV2StateFromEvents(events) === 'waiting_human') return
        const journaled = await deps.writer.record({
          kind: 'state-change',
          at: deps.now(),
          ref,
          state: 'waiting_human',
          reason: 'human_ask_pending',
        })
        if (journaled) openAsks.set(event.toolCallId, ref)
      } catch {
        // never-throw (ISC-A-5)
      }
    },
    onToolFinalized: closeAsk,
  }
}
