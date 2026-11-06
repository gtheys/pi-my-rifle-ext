import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Exec } from '../shared/diff-base.ts'
import {
  deviationResultToToolResult,
  deviationReviewPromptFrom,
  registerDeviationReviewTool,
  resolveDeviationRange,
  verifyDeviationGateResult,
} from '../tools/deviation.ts'
import { DEVIATION_VERDICT_HEADING } from '../validate/deviation-gate.ts'
import {
  buildGateTarget,
  type GateTarget,
  reviewedRangeLine,
} from '../validate/gate-target.ts'

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

const RESOLVED = {
  diff: 'diff --git a/settings.ts\n+save()',
  commitMessages: 'feat: settings persistence',
}

// --- prompt composition pass-through ---

const BASE_PARAMS = {
  mode: 'personal' as const,
  ref: 'PMR-TEST1',
  spec: 'The feature must persist user settings across restarts.',
  avenNotes: 'interview: user wants settings saved',
}

test('deviationReviewPromptFrom passes spec, diff and why-inputs through', () => {
  const prompt = deviationReviewPromptFrom(BASE_PARAMS, RESOLVED)
  assert.match(prompt, /fresh-context spec-deviation reviewer/)
  assert.ok(prompt.includes(BASE_PARAMS.spec))
  assert.ok(prompt.includes(RESOLVED.diff))
  assert.ok(prompt.includes(RESOLVED.commitMessages))
  assert.ok(prompt.includes(BASE_PARAMS.avenNotes))
  assert.match(prompt, /Mode: personal\./)
})

test('deviationReviewPromptFrom empty why-inputs degrade to placeholders', () => {
  const prompt = deviationReviewPromptFrom(
    { ...BASE_PARAMS, avenNotes: '' },
    { ...RESOLVED, commitMessages: '' },
  )
  assert.match(prompt, /\(none recorded\)/)
})

test('deviationReviewPromptFrom thin spec triggers the insufficient-spec route', () => {
  const prompt = deviationReviewPromptFrom(
    { ...BASE_PARAMS, spec: 'short' },
    RESOLVED,
  )
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

// --- self-resolved range (PMR-R4AP) ---

function gitFake(
  map: Record<string, { stdout?: string; code?: number }>,
): Exec {
  return async (_cmd, args) => {
    const hit = map[args.join(' ')]
    if (hit === undefined) return { stdout: '', code: 1 }
    return { stdout: hit.stdout ?? '', code: hit.code ?? 0 }
  }
}

const GOOD_GIT = {
  'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' },
  'config branch.feat/x.flowbase': { stdout: 'develop\n' },
  'config branch.feat/x.flowbasesha': { stdout: 'bbb\n' },
  'merge-base HEAD bbb': { stdout: 'bbb\n' },
  'rev-parse HEAD': { stdout: 'ccc\n' },
  'rev-list --count bbb..HEAD': { stdout: '2\n' },
  'diff bbb..HEAD': { stdout: 'diff --git a/x\n+y\n' },
  'log bbb..HEAD': { stdout: 'commit ccc\n    feat: y\n' },
}

test('resolveDeviationRange resolves base, diff and commits itself', async () => {
  const r = await resolveDeviationRange(gitFake(GOOD_GIT), '/w')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.flowRange.baseSha, 'bbb')
    assert.equal(r.value.flowRange.range, 'bbb..HEAD')
    assert.match(r.value.diff, /diff --git/)
    assert.match(r.value.commitMessages, /feat: y/)
  }
})

test('resolveDeviationRange errors when flow base is not recorded', async () => {
  const r = await resolveDeviationRange(
    gitFake({ 'rev-parse --abbrev-ref HEAD': { stdout: 'feat/x\n' } }),
    '/w',
  )
  assert.equal(r.ok, false)
})

test('resolveDeviationRange errors on empty range', async () => {
  const r = await resolveDeviationRange(
    gitFake({ ...GOOD_GIT, 'rev-parse HEAD': { stdout: 'bbb\n' } }),
    '/w',
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /empty range/)
})

test('resolveDeviationRange errors on empty diff', async () => {
  const r = await resolveDeviationRange(
    gitFake({ ...GOOD_GIT, 'diff bbb..HEAD': { stdout: '  \n' } }),
    '/w',
  )
  assert.equal(r.ok, false)
})

test('tool schema has no diff/commitMessages params', () => {
  const { tools, mockPi } = makeMockPi()
  registerDeviationReviewTool(mockPi)
  const params = JSON.stringify(
    (tools[0] as unknown as { parameters: unknown }).parameters,
  )
  assert.doesNotMatch(params, /"diff"|commitMessages/)
})

// --- PMR-6EEW gate integrity: pinned target + echo contract ---

const PIN_BASE = 'a'.repeat(40)
const PIN_HEAD = 'b'.repeat(40)

function pinnedTarget(): GateTarget {
  const built = buildGateTarget({
    gate: 'deviation',
    ref: BASE_PARAMS.ref,
    baseSha: PIN_BASE,
    headSha: PIN_HEAD,
    diff: RESOLVED.diff,
  })
  if (!('diffSha256' in built))
    throw new Error('fixture target failed to build')
  return built
}

test('deviationReviewPromptFrom embeds the pinned range when a target is supplied', () => {
  const withPin = deviationReviewPromptFrom(
    BASE_PARAMS,
    RESOLVED,
    pinnedTarget(),
  )
  assert.match(withPin, /Pinned review target/)
  assert.match(withPin, /reviewed_range: a{40}\.\.b{40}/)
  assert.ok(withPin.includes(reviewedRangeLine(pinnedTarget())))

  const legacy = deviationReviewPromptFrom(BASE_PARAMS, RESOLVED, null)
  assert.ok(!/[0-9a-f]{40}\.\.[0-9a-f]{40}/.test(legacy))
  assert.match(legacy, /no pin supplied/)
})

test('verifyDeviationGateResult passes on exact echo with unchanged HEAD', async () => {
  const exec = gitFake({ 'rev-parse HEAD': { stdout: `${PIN_HEAD}\n` } })
  const v = await verifyDeviationGateResult(
    exec,
    '/w',
    pinnedTarget(),
    `reviewed_range: ${PIN_BASE}..${PIN_HEAD}\ndeviations_count: 0`,
  )
  assert.deepEqual(v, { ok: true, status: 'pass' })
})

test('verifyDeviationGateResult rejects a reviewer that echoed a different range', async () => {
  const exec = gitFake({ 'rev-parse HEAD': { stdout: `${PIN_HEAD}\n` } })
  const v = await verifyDeviationGateResult(
    exec,
    '/w',
    pinnedTarget(),
    `reviewed_range: ${PIN_BASE}..${'c'.repeat(40)}`,
  )
  assert.ok(!v.ok)
  assert.equal(v.status, 'target-mismatch')
})

test('verifyDeviationGateResult rejects a stale verdict when HEAD moved', async () => {
  const exec = gitFake({ 'rev-parse HEAD': { stdout: `${'d'.repeat(40)}\n` } })
  const v = await verifyDeviationGateResult(
    exec,
    '/w',
    pinnedTarget(),
    `reviewed_range: ${PIN_BASE}..${PIN_HEAD}`,
  )
  assert.ok(!v.ok)
  assert.equal(v.status, 'stale')
})

test('verifyDeviationGateResult fails closed when HEAD cannot be re-resolved', async () => {
  const exec = gitFake({ 'rev-parse HEAD': { code: 1 } })
  const v = await verifyDeviationGateResult(
    exec,
    '/w',
    pinnedTarget(),
    `reviewed_range: ${PIN_BASE}..${PIN_HEAD}`,
  )
  assert.ok(!v.ok)
  assert.equal(v.status, 'fail')
})
