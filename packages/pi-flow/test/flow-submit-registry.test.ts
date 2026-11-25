// PMR-ZV9Y subtask 1.2 — flow_submit step-registry advisory behavior.
// Contract: an unregistered step label (on a phase that HAS a non-empty
// registry: plan, validate) still SUCCEEDS and journals, but the tool
// response carries an advisory hint listing the registered names for that
// phase. A registered step gets no hint. Phases whose registry is empty by
// design (implement, feedback — free-form step labels are the documented
// contract there) get no hint. Advisory posture only: never rejects.
//
// Patterns (fake-pi capture + memoryWriter) copied from
// flow-submit-tool.test.ts so nothing touches a real journal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import type { FlowSubmitDetails } from '../tools/flow-submit.ts'
import { registerFlowSubmitTool } from '../tools/flow-submit.ts'

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
      return true
    },
    recordJournalOnly: async () => {},
  } as unknown as EventWriter
  return { writer, captured }
}

// A registered validate name (validate.code-review) → success, NO hint.
test('registered validate step journals with no advisory hint', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-REG1',
    step: 'validate.code-review',
    output: { phase: 'validate', prUrl: 'https://example.test/pr/1' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.ok, true)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  assert.match(result.content[0].text, /journaled on PMR-REG1/)
  assert.doesNotMatch(result.content[0].text, /advisory/i)
  assert.doesNotMatch(result.content[0].text, /registered names/i)
})

// An unregistered validate label → success + journal + advisory hint
// naming the registered validate step names.
test('unregistered validate step journals but returns an advisory hint', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-REG2',
    step: 'gate-evidence',
    output: { phase: 'validate', prUrl: 'https://example.test/pr/2' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.ok, true)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  assert.match(result.content[0].text, /journaled on PMR-REG2/)
  assert.match(result.content[0].text, /advisory/i)
  assert.match(result.content[0].text, /not in the validate step registry/i)
  assert.match(result.content[0].text, /registered names/i)
  assert.match(result.content[0].text, /validate\.code-review/)
  assert.match(result.content[0].text, /validate\.deviation/)
  assert.match(result.content[0].text, /validate\.spec-diff/)
  assert.match(result.content[0].text, /validate\.aven-notes/)
  assert.doesNotMatch(result.content[0].text, /refused/i)
})

// A registered plan name (plan.spec-approval) → success, NO hint.
test('registered plan step journals with no advisory hint', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-REG3',
    step: 'plan.spec-approval',
    output: { phase: 'plan', planPath: 'plan.md' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  assert.doesNotMatch(result.content[0].text, /advisory/i)
  assert.doesNotMatch(result.content[0].text, /registered names/i)
})

// An unregistered plan label → success + hint naming plan.spec-approval.
test('unregistered plan step journals but returns an advisory hint', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-REG4',
    step: 'plan-written',
    output: { phase: 'plan', planPath: 'plan.md' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  assert.match(result.content[0].text, /advisory/i)
  assert.match(result.content[0].text, /plan\.spec-approval/)
})

// implement/feedback registries are empty by design (free-form step labels are
// the documented contract there) → free-form submission gets NO advisory noise.
test('implement free-form step is not nagged (empty registry by design)', async () => {
  const { writer, captured } = memoryWriter()
  const execute = captureTool({
    writer,
    resolveHead: async () => null,
    readEvents: async () => [],
  })
  const result = await execute('t1', {
    ref: 'PMR-REG5',
    step: 'unit-tests-green',
    output: { phase: 'implement', command: 'npm test', passed: true },
  })
  assert.equal(result.isError, undefined)
  assert.equal(result.details?.journaled, true)
  assert.equal(captured.length, 1)
  assert.doesNotMatch(result.content[0].text, /advisory/i)
})
