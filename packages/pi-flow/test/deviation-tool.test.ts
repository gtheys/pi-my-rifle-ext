import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  deviationResultToToolResult,
  deviationReviewPromptFrom,
  registerDeviationReviewTool,
} from '../tools/deviation.ts'
import { DEVIATION_VERDICT_HEADING } from '../validate/deviation-gate.ts'

type CapturedTool = { name: string; description: string }

function makeMockPi() {
  const tools: CapturedTool[] = []
  const mockPi = {
    registerTool: (options: unknown) => {
      tools.push(options as CapturedTool)
    },
    on: () => () => {},
  } as unknown as ExtensionAPI
  return { tools, mockPi }
}

function textOf(result: {
  content: { type: string; text?: string }[]
}): string {
  const block = result.content[0]
  if (
    block !== undefined &&
    block.type === 'text' &&
    block.text !== undefined
  ) {
    return block.text
  }
  return ''
}

// --- prompt composition pass-through ---

const BASE_PARAMS = {
  mode: 'personal' as const,
  ref: 'PMR-TEST1',
  spec: 'The feature must persist user settings across restarts.',
  diff: 'diff --git a/settings.ts\n+save()',
  commitMessages: 'feat: settings persistence',
  avenNotes: 'interview: user wants settings saved',
}

test('deviationReviewPromptFrom passes spec, diff and why-inputs through', () => {
  const prompt = deviationReviewPromptFrom(BASE_PARAMS)
  assert.match(prompt, /fresh-context spec-deviation reviewer/)
  assert.ok(prompt.includes(BASE_PARAMS.spec))
  assert.ok(prompt.includes(BASE_PARAMS.diff))
  assert.ok(prompt.includes(BASE_PARAMS.commitMessages))
  assert.ok(prompt.includes(BASE_PARAMS.avenNotes))
  assert.match(prompt, /Mode: personal\./)
})

test('deviationReviewPromptFrom empty why-inputs degrade to placeholders', () => {
  const prompt = deviationReviewPromptFrom({
    ...BASE_PARAMS,
    commitMessages: '',
    avenNotes: '',
  })
  assert.match(prompt, /\(none recorded\)/)
})

test('deviationReviewPromptFrom thin spec triggers the insufficient-spec route', () => {
  const prompt = deviationReviewPromptFrom({ ...BASE_PARAMS, spec: 'short' })
  assert.match(prompt, /INSUFFICIENT SPEC/)
})

// --- result mapping (parse-error-is-error contract) ---

const OK_ARTIFACT = [
  'review prose',
  DEVIATION_VERDICT_HEADING,
  'deviations_count: 1',
  '- deviation: extra retry | why: guessed (inferred: commit says retry) | a.ts:12',
].join('\n')

test('deviationResultToToolResult: parsed artifact returns ok details', () => {
  const result = deviationResultToToolResult(OK_ARTIFACT)
  assert.notEqual(result.isError, true)
  assert.equal(result.details.ok, true)
  if (result.details.ok) {
    assert.equal(result.details.deviationsCount, 1)
    assert.equal(result.details.deviations.length, 1)
  }
  assert.match(textOf(result), /1 deviation/)
})

test('deviationResultToToolResult: zero deviations routes to validate-complete', () => {
  const result = deviationResultToToolResult(
    `${DEVIATION_VERDICT_HEADING}\ndeviations_count: 0\n`,
  )
  assert.notEqual(result.isError, true)
  assert.match(textOf(result), /0 deviations from spec/)
})

test('deviationResultToToolResult: malformed artifact is an isError result, never 0', () => {
  const result = deviationResultToToolResult(
    'looks fine, no deviations found at all',
  )
  assert.equal(result.isError, true)
  assert.equal(result.details.ok, false)
  if (!result.details.ok)
    assert.match(result.details.reason, /deviations_count/)
  assert.match(textOf(result), /NEVER treat this as 0/)
})

// --- registration ---

test('registers the deviation_review tool with description and params', () => {
  const { tools, mockPi } = makeMockPi()
  registerDeviationReviewTool(mockPi)
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.name, 'deviation_review')
  assert.match(tools[0]?.description ?? '', /deviation/)
})
