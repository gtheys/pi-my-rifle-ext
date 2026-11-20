// PMR-762F subtask 2.5 (phase 2 of PMR-C998) — behavior tests for the
// flow_submit tool. Fakes pi (capture pattern from run-attempt-tool.test.ts),
// the EventWriter, resolveHead, and readEvents, so nothing touches a real
// journal. Advisory posture: only malformed params are refused; every
// verification failure degrades to a warning on an ok result.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { buildImplementPrompt } from '../implement/prompt.ts'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import type { FlowSubmitDetails } from '../tools/flow-submit.ts'
import { registerFlowSubmitTool } from '../tools/flow-submit.ts'
import { buildValidatePrompt } from '../validate/prompt.ts'

type Execute = (
  id: string,
  params: {
    ref: string
    step: string
    ok?: boolean
    detail?: string
    output: {
      phase: 'plan' | 'implement' | 'validate' | 'feedback'
      planPath?: string
      subtaskRefs?: string[]
      command?: string
      passed?: boolean
      headSha?: string
      prNumber?: number
      prUrl?: string
      gateTargetIds?: string[]
      prMerged?: boolean
    }
  },
) => Promise<{
  isError?: boolean
  content: { text: string }[]
  details?: FlowSubmitDetails
}>

/**
 * AIDEV-NOTE: PMR-762F — narrow a captured journal event to its step-output
 * member at the type level via a runtime guard (no casts), so assertions can
 * read journal-only fields like headShaVerified.
 */
function stepOutputEvent(events: FlowRunEvent[], index: number) {
  const event = events[index]
  if (event.kind !== 'step-output') {
    throw new Error(`expected step-output at ${index}, got ${event.kind}`)
  }
  return event
}

// AIDEV-NOTE: PMR-762F — same capture pattern as run-attempt-tool.test.ts:
// grab execute off a fake pi via `as unknown as ExtensionAPI`.
function captureTool(deps: Parameters<typeof registerFlowSubmitTool>[1]) {
  let execute: Execute | undefined
  registerFlowSubmitTool(
    {
      registerTool: (tool: { execute: Execute }) => {
        execute = tool.execute
      },
    } as unknown as ExtensionAPI,
    deps,
  )
  assert.ok(execute)
  return execute
}

function memoryWriter(): { writer: EventWriter; captured: FlowRunEvent[] } {
  const captured: FlowRunEvent[] = []
  const writer = {
    record: async (event: FlowRunEvent) => {
      captured.push(event)
    },
    recordJournalOnly: async () => {},
  } as unknown as EventWriter
  return { writer, captured }
}

function throwingWriter(): EventWriter {
  return {
    record: async () => {
      throw new Error('disk gone')
    },
    recordJournalOnly: async () => {
      throw new Error('disk gone')
    },
  } as unknown as EventWriter
}

const SHA = 'a'.repeat(40)

// (a) valid submissions across all four phases journal the right step-output
// event shape and report ok + journaled.
test('plan submission journals a step-output event with plan facts', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-TEST1',
    step: 'plan-written',
    ok: true,
    output: { phase: 'plan', planPath: 'plan.md', subtaskRefs: ['PMR-A1'] },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.ok, true)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  const event = stepOutputEvent(captured, 0)
  assert.equal(event.kind, 'step-output')
  assert.equal(event.ref, 'PMR-TEST1')
  assert.equal(event.step, 'plan-written')
  assert.equal(event.phase, 'plan')
  assert.equal(event.planPath, 'plan.md')
  assert.deepEqual(event.subtaskRefs, ['PMR-A1'])
  assert.match(result.content[0].text, /journaled on PMR-TEST1/)
})

test('implement submission journals command and pass state', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  await execute('t1', {
    ref: 'PMR-TEST2',
    step: 'unit-tests-green',
    ok: true,
    output: { phase: 'implement', command: 'npm test', passed: true },
  })
  const event = stepOutputEvent(captured, 0)
  assert.equal(event.phase, 'implement')
  assert.equal(event.command, 'npm test')
  assert.equal(event.passed, true)
})

test('validate submission journals PR facts', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  await execute('t1', {
    ref: 'PMR-TEST3',
    step: 'pr-open',
    output: {
      phase: 'validate',
      prNumber: 7,
      prUrl: 'https://example.test/pr/7',
    },
  })
  const event = stepOutputEvent(captured, 0)
  assert.equal(event.phase, 'validate')
  assert.equal(event.prNumber, 7)
  assert.equal(event.prUrl, 'https://example.test/pr/7')
})

test('feedback submission journals merge outcome', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  await execute('t1', {
    ref: 'PMR-TEST4',
    step: 'pr-merged',
    output: {
      phase: 'feedback',
      prUrl: 'https://example.test/pr/7',
      prMerged: true,
    },
  })
  const event = stepOutputEvent(captured, 0)
  assert.equal(event.phase, 'feedback')
  assert.equal(event.prMerged, true)
})

// (b) malformed params -> isError result with actionable text and NO write.
test('bad ref charset is refused without journaling', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({ writer })
  const result = await execute('t1', {
    ref: 'PMR BAD!',
    step: 'ok-step',
    output: { phase: 'plan' },
  })
  assert.equal(result.isError, true)
  assert.equal(result.details?.ok, false)
  assert.equal(result.details?.journaled, false)
  assert.match(result.content[0].text, /flow_submit refused/)
  assert.match(result.content[0].text, /Invalid ref/)
  assert.match(result.content[0].text, /Re-run flow_submit/)
  assert.equal(captured.length, 0)
})

test('short headSha is refused without journaling', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({ writer })
  const result = await execute('t1', {
    ref: 'PMR-TEST5',
    step: 'short-sha',
    output: { phase: 'implement', headSha: 'abc123' },
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /40-character hex SHA/)
  assert.equal(captured.length, 0)
})

test('wrong-type fact on the phase branch is refused without journaling', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({ writer })
  // passed must be a boolean on the implement branch; this wrong-typed fact
  // is caught by buildStepOutputEvent's validateFactTypes runtime check,
  // NOT by the TypeBox schema (unions allow additional properties).
  const mismatch = await execute('t2', {
    ref: 'PMR-TEST6',
    step: 'wrong-fact-type',
    output: {
      phase: 'implement',
      command: 'npm test',
      passed: 'yes' as unknown as boolean,
    },
  })
  assert.equal(mismatch.isError, true)
  assert.match(mismatch.content[0].text, /Invalid implement fact/)
  assert.equal(captured.length, 0)
})

test('wrong-typed foreign-phase fact is refused without journaling', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({ writer })
  // TypeBox unions allow additional properties, so a wrong-typed fact on a
  // foreign phase branch reaches buildStepOutputEvent — which must reject it
  // before anything is journaled.
  const result = await execute('t1', {
    ref: 'PMR-TEST6A',
    step: 'foreign-wrong-type',
    output: { phase: 'plan', command: 42 as unknown as string },
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid plan fact "command"/)
  assert.match(result.content[0].text, /belongs to the implement phase/)
  assert.equal(result.details?.journaled, false)
  assert.equal(captured.length, 0)
})

test('correctly-typed foreign-phase fact is refused without journaling', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({ writer })
  // Even a correctly-typed fact from another phase is cross-phase evidence
  // and must be rejected, not silently journaled.
  const result = await execute('t1', {
    ref: 'PMR-TEST6B',
    step: 'foreign-typed',
    output: { phase: 'implement', planPath: '/plan.md' },
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid implement fact "planPath"/)
  assert.match(result.content[0].text, /belongs to the plan phase/)
  assert.equal(result.details?.journaled, false)
  assert.equal(captured.length, 0)
})

// (c) headSha verification: match, mismatch, unresolvable HEAD.
test('matching HEAD journals headShaVerified true', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => SHA,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-TEST7',
    step: 'sha-match',
    output: { phase: 'implement', headSha: SHA },
  })
  assert.equal(result.details?.headShaVerified, true)
  assert.equal(stepOutputEvent(captured, 0).headShaVerified, true)
  assert.doesNotMatch(result.content[0].text, /warning/)
})

test('mismatching HEAD warns and journals headShaVerified false', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => 'b'.repeat(40),
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-TEST8',
    step: 'sha-mismatch',
    output: { phase: 'implement', headSha: SHA },
  })
  assert.equal(result.details?.ok, true)
  assert.equal(result.details?.headShaVerified, false)
  assert.equal(stepOutputEvent(captured, 0).headShaVerified, false)
  assert.match(result.content[0].text, /headSha mismatch/)
})

test('unresolvable HEAD warns and journals headShaVerified false', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-TEST9',
    step: 'no-head',
    output: { phase: 'implement', headSha: SHA },
  })
  assert.equal(result.details?.headShaVerified, false)
  assert.equal(stepOutputEvent(captured, 0).headShaVerified, false)
  assert.match(result.content[0].text, /could not resolve HEAD/)
})

// (d) gateTargetIds membership check against prior gate-target events.
function gateTargetEvents(targetId: string): FlowRunEvent[] {
  const event: FlowRunEvent = {
    kind: 'gate-target',
    at: new Date().toISOString(),
    ref: 'PMR-GATE1',
    gate: 'review',
    targetId,
    baseSha: 'c'.repeat(40),
    headSha: 'd'.repeat(40),
    diffSha256: 'e'.repeat(64),
  }
  return [event]
}

test('unknown gateTargetIds produce a warning and typed details', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => gateTargetEvents('known-1'),
  })
  const result = await execute('t1', {
    ref: 'PMR-GATE1',
    step: 'gate-check',
    output: { phase: 'validate', gateTargetIds: ['known-1', 'ghost-9'] },
  })
  assert.equal(result.details?.ok, true)
  assert.deepEqual(result.details?.unknownGateTargetIds, ['ghost-9'])
  assert.match(result.content[0].text, /unknown gateTargetIds.*ghost-9/)
  assert.equal(captured.length, 1)
  assert.equal(stepOutputEvent(captured, 0).kind, 'step-output')
})

test('known gateTargetIds produce no warning', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => gateTargetEvents('known-1'),
  })
  const result = await execute('t1', {
    ref: 'PMR-GATE1',
    step: 'gate-check',
    output: { phase: 'validate', gateTargetIds: ['known-1'] },
  })
  assert.equal(result.details?.unknownGateTargetIds, undefined)
  assert.doesNotMatch(result.content[0].text, /warning/)
  assert.equal(captured.length, 1)
})

// (e) journal write failure -> ok result, journaled:false, best-effort warning.
test('journal write failure degrades to journaled false on an ok result', async () => {
  const execute = captureTool({
    writer: throwingWriter(),
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-TESTA',
    step: 'writer-throws',
    output: { phase: 'plan' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.ok, true)
  assert.equal(result.details?.journaled, false)
  assert.match(result.content[0].text, /NOT journaled/)
  assert.match(result.content[0].text, /best-effort/)
})

// (f) prompt-contains: prompts mention flow_submit.
test('implement commonRules mention flow_submit on every route', () => {
  for (const route of ['oneshot', 'plan', 'bug'] as const) {
    const prompt = buildImplementPrompt({
      mode: 'work',
      ref: 'PMR-PROMPT1',
      route,
    })
    assert.match(
      prompt,
      /flow_submit tool/,
      `route ${route} mentions flow_submit`,
    )
    assert.match(prompt, /advisory/)
  }
})

test('validate work-mode prompt mentions flow_submit as advisory', () => {
  const prompt = buildValidatePrompt({
    mode: 'work',
    ref: 'PMR-PROMPT2',
    scriptsDir: '/scripts',
  })
  assert.match(prompt, /flow_submit tool/)
  assert.match(prompt, /Advisory/)
})
