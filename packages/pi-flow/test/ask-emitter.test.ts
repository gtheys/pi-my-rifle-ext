// AIDEV-NOTE: PMR-0NRH 2.1 — unit tests for the generic ask emitter
// (flow/ask-emitter.ts). A plain ask_user_question inside an OPEN agent turn
// journals nothing (settle-based emission never sees the wait), so the
// tool_call/tool_result(+tool_execution_end) hook pair wraps it in the SAME
// turn: state-change{waiting_human, human_ask_pending} before the ask blocks,
// state-change{running} after the answer. These tests mock only the injected
// boundaries (writer, readEvents, getActiveRef, now) and assert on the
// RECORDED event objects — never on internal state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAskEmitter } from '../flow/ask-emitter.ts'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'

/** Capturing fake writer: records every event, returns `recordResult`. */
function fakeWriter(
  opts: { recordResult?: boolean; throwOn?: (e: FlowRunEvent) => boolean } = {},
) {
  const recorded: FlowRunEvent[] = []
  const writer: EventWriter = {
    record: async (event) => {
      if (opts.throwOn?.(event)) {
        throw new Error('journal exploded')
      }
      recorded.push(event)
      if (opts.recordResult === undefined) return true
      return opts.recordResult
    },
    recordJournalOnly: async (event) => {
      recorded.push(event)
    },
  }
  return { recorded, writer }
}

function harness(
  opts: {
    activeRef?: string | null
    journal?: readonly FlowRunEvent[] | null
    /** true = leave deps.writer unset (ISC-A-2 no-op tests). */
    noWriter?: boolean
    recordResult?: boolean
    throwOn?: (e: FlowRunEvent) => boolean
  } = {},
) {
  let activeRef: string | null = 'PMR-X'
  if (opts.activeRef !== undefined) activeRef = opts.activeRef
  const capture = fakeWriter({
    recordResult: opts.recordResult,
    throwOn: opts.throwOn,
  })
  let writer: EventWriter | undefined = capture.writer
  if (opts.noWriter) writer = undefined
  const emitter = createAskEmitter({
    getActiveRef: () => activeRef,
    writer,
    readEvents: async () => opts.journal ?? [],
    now: () => '2026-11-27T00:00:00.000Z',
  })
  return { recorded: capture.recorded, emitter }
}

// --- 2. PRIMARY dedupe: nested call (parentToolCallId) is skipped outright ---

test('primary dedupe: nested ask (parentToolCallId set) journals nothing and closing it is a no-op', async () => {
  // Empty journal proves the skip is the parentToolCallId check, not the
  // journal-tail scan.
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal: [] })

  await emitter.onToolCall({
    toolName: 'ask_user_question',
    toolCallId: 'tc-parent/1',
    parentToolCallId: 'tc-parent',
  })
  assert.deepEqual(recorded, [])

  // The Map never saw the id, so the close is a no-op (defence in depth:
  // the owning tool, e.g. code_review, journals its own close).
  await emitter.onToolFinalized({ toolCallId: 'tc-parent/1' })
  assert.deepEqual(recorded, [])
})

// --- 3. SECONDARY dedupe: journal tail already reads waiting_human ---

test('secondary dedupe: non-nested open while journal tail is waiting_human journals nothing', async () => {
  const journal: FlowRunEvent[] = [
    {
      kind: 'state-change',
      at: '2026-11-26T00:00:00.000Z',
      ref: 'PMR-X',
      state: 'waiting_human',
      reason: 'subagent_ask_pending',
    },
  ]
  const { recorded, emitter } = harness({ activeRef: 'PMR-X', journal })

  await emitter.onToolCall({ toolName: 'ask_user_question', toolCallId: 'tc2' })
  assert.deepEqual(recorded, [])

  // Map stayed empty (no open remembered) → the finalize journals nothing.
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
  const closes = recorded.filter(
    (e) => e.kind === 'state-change' && e.state === 'running',
  )
  assert.equal(closes.length, 1)
})

// --- 10. failed open (record resolves false) → no Map entry → no close ---

test('failed open: record returning false is not remembered, finalize journals nothing', async () => {
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
  // The fake captured the (failed) open attempt but the emitter remembered
  // nothing, so no running close was ever attempted.
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
