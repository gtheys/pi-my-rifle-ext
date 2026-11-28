// AIDEV-NOTE: PMR-0NRH 2.1 — unit tests for the generic ask emitter
// (flow/ask-emitter.ts). A plain ask_user_question inside an OPEN agent turn
// journals nothing (settle-based emission never sees the wait), so the
// tool_call/tool_result(+tool_execution_end) hook pair wraps it in the SAME
// turn: state-change{waiting_human, human_ask_pending} before the ask blocks,
// state-change{running} after the answer. These tests mock only the injected
// boundaries (writer, readEvents, getActiveRef, now) and assert on the
// RECORDED event objects — never on internal state.
//
// AIDEV-NOTE: PMR-0NRH fix round (review blocker 1) — the fake now mirrors
// production journal semantics, which the refcount/reason-checked close
// depends on: `recorded` is every write the emitter ATTEMPTED (what the tests
// assert), while the journal the emitter re-reads holds only the writes that
// LANDED (record returning true). Every journal is ALSO seeded with the
// `run-start` line production always writes first (index.ts:2218) — not because
// the emitter needs one (at HEAD it never calls projectRunState: both tail reads
// go through the module-local lastV2StateRecord, a raw state-change scan with no
// run-start precondition, which the 'P2-a: a journal with NO run-start' test
// below pins) but because the fake stays a faithful copy of a real journal, and
// `noRunStart: true` drops exactly that one line to reproduce the P2-a shape.
// The parallel-batch cases below reproduce pi's default parallel tool execution:
// every tool_call handler runs before any tool executes, so asks #2..N see
// the open wait that ask #1 just journaled and then serialize on the UI lock.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAskEmitter } from '../flow/ask-emitter.ts'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'

type ReadMode = 'ok' | 'throws' | 'null'

function harness(
  opts: {
    activeRef?: string | null
    /** Events already in the journal when the emitter reads its tail. */
    journal?: readonly FlowRunEvent[]
    /** true = leave deps.writer unset (ISC-A-2 no-op tests). */
    noWriter?: boolean
    /**
     * true = seed the fake journal with NO `run-start` line (review finding
     * P2-a). Production always writes run-start at start(), but a swallowed
     * run-start write (ISC-A-5) followed by a later successful state-change
     * write leaves exactly this shape, which projectRunState cannot fold. The
     * open could always see it; after the fix the close can too.
     */
    noRunStart?: boolean
    /** false = the write fails (record resolves false, nothing lands). */
    recordResult?: boolean
    throwOn?: (event: FlowRunEvent) => boolean
    readMode?: ReadMode
  } = {},
) {
  let activeRef: string | null = 'PMR-X'
  if (opts.activeRef !== undefined) activeRef = opts.activeRef
  const ref = activeRef ?? 'PMR-X'
  const recorded: FlowRunEvent[] = []
  // The fake journal: the run-start line production always writes first, then
  // any seeded tail, then only the writes that landed. `noRunStart` drops the
  // first line to reproduce the P2-a journal shape (a swallowed run-start write
  // followed by a later successful state-change write). No ternary per repo
  // style: build the seed conditionally then spread.
  const seed: FlowRunEvent[] = []
  if (opts.noRunStart !== true) {
    seed.push({
      kind: 'run-start',
      at: '2026-11-25T00:00:00.000Z',
      ref,
      mode: 'personal',
    })
  }
  const journal: FlowRunEvent[] = [...seed, ...(opts.journal ?? [])]
  let readMode: ReadMode = 'ok'
  if (opts.readMode !== undefined) readMode = opts.readMode

  const writer: EventWriter = {
    record: async (event) => {
      if (opts.throwOn?.(event)) {
        throw new Error('journal exploded')
      }
      recorded.push(event)
      if (opts.recordResult === undefined) {
        journal.push(event)
        return true
      }
      if (opts.recordResult) journal.push(event)
      return opts.recordResult
    },
    recordJournalOnly: async (event) => {
      recorded.push(event)
      journal.push(event)
    },
  }
  let writerRef: EventWriter | undefined = writer
  if (opts.noWriter) writerRef = undefined

  const emitter = createAskEmitter({
    getActiveRef: () => activeRef,
    writer: writerRef,
    readEvents: async () => {
      if (readMode === 'throws') throw new Error('journal unreadable')
      if (readMode === 'null') return null
      return [...journal]
    },
    now: () => '2026-11-27T00:00:00.000Z',
  })
  return {
    recorded,
    emitter,
    /** Simulate another seam journalling onto the same run's journal. */
    pushJournal: (event: FlowRunEvent) => {
      journal.push(event)
    },
    /** Simulate the journal tail becoming unreadable from here on. */
    breakReads: (mode: ReadMode) => {
      readMode = mode
    },
  }
}

/** Convenience: a journaled state-change line (as another seam would write). */
function waitEvent(
  state: 'waiting_human',
  reason: 'human_ask_pending' | 'code_review_pending' | 'subagent_ask_pending',
): FlowRunEvent {
  return {
    kind: 'state-change',
    at: '2026-11-26T00:00:00.000Z',
    ref: 'PMR-X',
    state,
    reason,
  }
}

function closesOf(recorded: readonly FlowRunEvent[]) {
  return recorded.filter(
    (event) => event.kind === 'state-change' && event.state === 'running',
  )
}

function opensOf(recorded: readonly FlowRunEvent[]) {
  return recorded.filter(
    (event) => event.kind === 'state-change' && event.state === 'waiting_human',
  )
}

// --- PARALLEL BATCH (review blocker 1: the close must be reference-counted) ---

test('parallel batch of two: one open, nothing on the first close, one running on the last', async () => {
  // Reviewer's reproduction. pi runs tool calls from one assistant message in
  // parallel (docs/extensions.md), so BOTH tool_call handlers run before
  // either ask blocks: ask #1 journals the open, ask #2 sees the waiting_human
  // tail and skips journaling — but it is still blocking the human, so its
  // close must not be allowed to clear the batch.
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-a1',
  })
  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-a2',
  })
  assert.equal(opensOf(recorded).length, 1)
  assert.equal(closesOf(recorded).length, 0)
  const open = recorded[0]
  if (open?.kind === 'state-change') {
    assert.equal(open.state, 'waiting_human')
    assert.equal(open.reason, 'human_ask_pending')
  } else {
    assert.fail('expected the batch open event')
  }

  // Ask #1 answered while ask #2 STILL blocks the human: journal nothing, or
  // the board would show running and the Waiting-on-me row would vanish.
  await emitter.onToolFinalized({ toolCallId: 'tc-a1' })
  assert.equal(recorded.length, 1)

  // Ask #2 answered: the last in-flight ask closes the wait with ONE running.
  await emitter.onToolFinalized({ toolCallId: 'tc-a2' })
  assert.equal(recorded.length, 2)
  const close = recorded[1]
  if (close?.kind === 'state-change') {
    assert.equal(close.state, 'running')
    assert.equal(close.ref, 'PMR-X')
  } else {
    assert.fail('expected the batch close event')
  }
  assert.equal(closesOf(recorded).length, 1)
})

test('parallel batch of three: one open and exactly one running only after the third close', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-b1',
  })
  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-b2',
  })
  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-b3',
  })
  assert.equal(opensOf(recorded).length, 1)

  await emitter.onToolFinalized({ toolCallId: 'tc-b1' })
  assert.equal(recorded.length, 1)
  await emitter.onToolFinalized({ toolCallId: 'tc-b2' })
  assert.equal(recorded.length, 1)
  await emitter.onToolFinalized({ toolCallId: 'tc-b3' })
  assert.equal(recorded.length, 2)
  assert.equal(closesOf(recorded).length, 1)
})

test('batched with a tool-owned wait: a code_review_pending tail suppresses our open and our close writes nothing', async () => {
  // ask_user_question batched with code_review: the gate journaled its own
  // waiting_human{code_review_pending} first, so we must journal neither an
  // open (it is already a human wait) nor a running close (that wait belongs
  // to code_review, which is still open).
  const { recorded, emitter } = harness({
    activeRef: 'PMR-X',
    journal: [waitEvent('waiting_human', 'code_review_pending')],
  })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-c1',
  })
  assert.deepEqual(recorded, [])

  await emitter.onToolFinalized({ toolCallId: 'tc-c1' })
  assert.deepEqual(recorded, [])
})

test('reason-checked close: another seam opens code_review_pending during our wait, our close journals nothing', async () => {
  const { recorded, emitter, pushJournal } = harness({
    activeRef: 'PMR-X',
    journal: [],
  })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-d1',
  })
  assert.equal(recorded.length, 1)

  // A competing wait is now the open one — its owner closes it, not us.
  pushJournal(waitEvent('waiting_human', 'code_review_pending'))
  await emitter.onToolFinalized({ toolCallId: 'tc-d1' })
  assert.equal(recorded.length, 1)
  assert.equal(closesOf(recorded).length, 0)
})

test('fail closed: readEvents throwing at close time journals no running and does not throw', async () => {
  const { recorded, emitter, breakReads } = harness({
    activeRef: 'PMR-X',
    journal: [],
  })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-e1',
  })
  assert.equal(recorded.length, 1)

  breakReads('throws')
  await emitter.onToolFinalized({ toolCallId: 'tc-e1' })
  assert.equal(closesOf(recorded).length, 0)
  assert.equal(recorded.length, 1)
})

test('fail closed: a null journal read at close time journals no running', async () => {
  const { recorded, emitter, breakReads } = harness({
    activeRef: 'PMR-X',
    journal: [],
  })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-e2',
  })
  assert.equal(recorded.length, 1)

  breakReads('null')
  await emitter.onToolFinalized({ toolCallId: 'tc-e2' })
  assert.equal(closesOf(recorded).length, 0)
  assert.equal(recorded.length, 1)
})

test('P2-a: a journal with NO run-start is both openable AND closable', async () => {
  // The reviewer proved a journal shape the emitter could OPEN but never CLOSE:
  // the open scanned raw state-change lines (resumeV2StateFromEvents, no
  // precondition) while the close folded via projectRunState, whose run-start
  // precondition is strictly stronger — so a swallowed run-start write (ISC-A-5)
  // followed by a later successful state-change write left the wait un-closable.
  // After the fix both sides derive the tail from ONE scan (lastV2StateRecord),
  // so the no-run-start journal opens AND closes.
  const { recorded, emitter } = harness({
    activeRef: 'PMR-X',
    journal: [],
    noRunStart: true,
  })

  // OPEN: with no run-start the tail scan still finds no wait -> the open lands.
  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-p2a',
  })
  assert.equal(recorded.length, 1)
  const open = recorded[0]
  if (open?.kind === 'state-change') {
    assert.equal(open.state, 'waiting_human')
    assert.equal(open.reason, 'human_ask_pending')
  } else {
    assert.fail('expected the ask open event')
  }
  // CLOSE: the SAME tail scan now finds our waiting_human{human_ask_pending}
  // (projectRunState could not — it needs a run-start) and journals running.
  await emitter.onToolFinalized({ toolCallId: 'tc-p2a' })
  assert.equal(recorded.length, 2)
  assert.equal(closesOf(recorded).length, 1)
})

test('sequential reuse: after a batch fully closes, a later ask opens and closes normally', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-f1',
  })
  await emitter.onToolFinalized({ toolCallId: 'tc-f1' })
  assert.equal(recorded.length, 2)

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-f2',
  })
  assert.equal(recorded.length, 3)
  const secondOpen = recorded[2]
  if (secondOpen?.kind === 'state-change') {
    assert.equal(secondOpen.state, 'waiting_human')
    assert.equal(secondOpen.reason, 'human_ask_pending')
  } else {
    assert.fail('expected the second ask open event')
  }

  await emitter.onToolFinalized({ toolCallId: 'tc-f2' })
  assert.equal(recorded.length, 4)
  assert.equal(closesOf(recorded).length, 2)
})

// --- 2. PRIMARY dedupe: nested call (parentToolCallId) is skipped outright ---

test('primary dedupe: nested ask (parentToolCallId set) journals nothing and closing it is a no-op', async () => {
  // An empty journal proves the skip is the parentToolCallId check, not the
  // journal-tail scan.
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-parent/1',
    parentToolCallId: 'tc-parent',
  })
  assert.deepEqual(recorded, [])

  // The id was never tracked, so the close is a no-op (defence in depth:
  // the owning tool, e.g. code_review, journals its own close).
  await emitter.onToolFinalized({ toolCallId: 'tc-parent/1' })
  assert.deepEqual(recorded, [])
})

// --- 3. SECONDARY dedupe: journal tail already reads waiting_human ---

test('secondary dedupe: non-nested open while journal tail is waiting_human journals nothing', async () => {
  const { recorded, emitter } = harness({
    activeRef: 'PMR-X',
    journal: [waitEvent('waiting_human', 'subagent_ask_pending')],
  })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc2' })
  assert.deepEqual(recorded, [])

  // The ask is tracked (it blocks the human), but the close journals nothing:
  // the tail still reads the loop-owned wait, not ours.
  await emitter.onToolFinalized({ toolCallId: 'tc2' })
  assert.deepEqual(recorded, [])
})

// --- 6. never-throw: record throwing on the open AND on the close (ISC-A-5) ---

test('never-throw: writer.record throwing on the open or the close resolves (ISC-A-5)', async () => {
  const throwOpen = harness({
    activeRef: 'PMR-X',
    journal: [],
    throwOn: (e) =>
      e.kind === 'state-change' && e.reason === 'human_ask_pending',
  })
  await throwOpen.emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc6a',
  })
  await throwOpen.emitter.onToolFinalized({ toolCallId: 'tc6a' })
  assert.deepEqual(throwOpen.recorded, [])

  const throwClose = harness({
    activeRef: 'PMR-X',
    journal: [],
    throwOn: (e) => e.kind === 'state-change' && e.state === 'running',
  })
  await throwClose.emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc6b',
  })
  assert.equal(throwClose.recorded.length, 1) // the open landed
  await throwClose.emitter.onToolFinalized({ toolCallId: 'tc6b' }) // throws inside, swallowed
  assert.equal(throwClose.recorded.length, 1) // no running record captured
})

// --- 7. unopened close → nothing journaled (defence in depth) ---

test('unopened close: finalize for an unknown toolCallId journals nothing', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolFinalized({ toolCallId: 'unknown' })
  assert.deepEqual(recorded, [])
})

// --- 8. blocked/aborted call: tool_execution_end-only close lands ---

test('blocked/aborted call: close via tool_execution_end only still journals running', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc8' })
  assert.equal(recorded.length, 1)
  // No tool_result path fired (blocked/aborted); the safety-net finalize does.
  await emitter.onToolFinalized({ toolCallId: 'tc8' })
  assert.equal(recorded.length, 2)
  const close = recorded[1]
  if (close?.kind === 'state-change') {
    assert.equal(close.state, 'running')
    assert.equal(close.ref, 'PMR-X')
  } else {
    assert.fail('expected a state-change close event')
  }
  // No orphan waiting_human: the tail now reads running.
})

// --- 9. double finalize → exactly ONE running record (first-wins) ---

test('double finalize (tool_result then tool_execution_end): exactly one running record', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc9' })
  await emitter.onToolFinalized({ toolCallId: 'tc9' }) // tool_result
  await emitter.onToolFinalized({ toolCallId: 'tc9' }) // tool_execution_end
  assert.equal(closesOf(recorded).length, 1)
})

// --- 10. failed open (record resolves false) → close journals nothing ---

test('failed open: record returning false lands nothing, so the reason-checked close journals no running', async () => {
  // The id IS tracked (an in-flight ask is tracked whether or not its open
  // landed — the refcount is what keeps a batch honest), but the failed write
  // never reached the journal, so at close time the tail is not our wait and
  // the close correctly writes nothing.
  const { recorded, emitter } = harness({
    activeRef: 'PMR-X',
    journal: [],
    recordResult: false,
  })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc10',
  })
  await emitter.onToolFinalized({ toolCallId: 'tc10' })
  // The fake captured the (failed) open attempt and no running close was ever
  // attempted.
  assert.equal(recorded.length, 1)
  const open = recorded[0]
  if (open?.kind === 'state-change') {
    assert.equal(open.state, 'waiting_human')
  } else {
    assert.fail('expected the attempted open event')
  }
})

// --- 11. non-ask tool → nothing ---

test('non-ask tool: onToolCall for bash journals nothing', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({ toolName: 'bash', toolCallId: 'tc9' })
  assert.deepEqual(recorded, [])

  await emitter.onToolFinalized({ toolCallId: 'tc9' })
  assert.deepEqual(recorded, [])
})

// --- 4. no active ref → complete no-op ---

test('no active ref: nothing journaled', async () => {
  const { recorded, emitter } = harness({ activeRef: null, journal: [] })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc4' })
  assert.deepEqual(recorded, [])

  await emitter.onToolFinalized({ toolCallId: 'tc4' })
  assert.deepEqual(recorded, [])
})

// --- 5. no writer → complete no-op, no throw (ISC-A-2) ---

test('no writer: nothing journaled and no throw (ISC-A-2)', async () => {
  const { recorded, emitter } = harness({
    activeRef: 'PMR-X',
    journal: [],
    noWriter: true,
  })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc5' })
  await emitter.onToolFinalized({ toolCallId: 'tc5' })
  assert.deepEqual(recorded, [])
})

// --- 1. open/close pair ---

test('open/close pair: non-nested ask journals waiting_human{human_ask_pending} then running', async () => {
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc1' })
  assert.equal(recorded.length, 1)
  const open = recorded[0]
  assert.equal(open?.kind, 'state-change')
  if (open?.kind === 'state-change') {
    assert.equal(open.state, 'waiting_human')
    assert.equal(open.reason, 'human_ask_pending')
    assert.equal(open.ref, 'PMR-X')
    assert.equal(open.at, '2026-11-27T00:00:00.000Z')
  }

  await emitter.onToolFinalized({ toolCallId: 'tc1' })
  assert.equal(recorded.length, 2)
  const close = recorded[1]
  assert.equal(close?.kind, 'state-change')
  if (close?.kind === 'state-change') {
    assert.equal(close.state, 'running')
    assert.equal(close.ref, 'PMR-X')
    assert.equal(close.reason, undefined)
  }
})
