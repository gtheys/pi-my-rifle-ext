import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssignmentRecord } from '@gtheys/pi-interactive-subagents'
import {
  formatCostReport,
  type PhaseStepSummary,
  summarizeStepOutputs,
} from '../flow/cost.ts'
import { computeCostRollup } from '../flow/cost-command.ts'
import type { FlowPhase, FlowRunEvent } from '../run-state.ts'

function stepOutput(
  phase: FlowPhase,
  step: string,
  ok?: boolean,
): FlowRunEvent {
  if (ok === undefined) {
    return {
      kind: 'step-output',
      at: '2026-11-19T00:00:00Z',
      ref: 'PMR-TEST',
      phase,
      step,
    }
  }
  return {
    kind: 'step-output',
    at: '2026-11-19T00:00:00Z',
    ref: 'PMR-TEST',
    phase,
    step,
    ok,
  }
}

function noteEvent(at: string, text: string): FlowRunEvent {
  return { kind: 'note', at, ref: 'PMR-TEST', text }
}

function stepSummary(
  phase: FlowPhase,
  total: number,
  ok: number,
  failed: number,
): PhaseStepSummary {
  return { phase, total, ok, failed }
}

function assignmentRecord(childId: string): AssignmentRecord {
  return {
    childId,
    name: `worker-${childId}`,
    task: 'do things',
    sessionFile: `/sessions/${childId}.jsonl`,
    cwd: '/repo',
    status: 'working',
    claim: { pid: 1, id: 'parent' },
    createdAt: '2026-11-19T00:00:00Z',
    updatedAt: '2026-11-19T00:00:00Z',
  }
}

test('summarizeStepOutputs counts ok, failed, and unset submissions per phase', () => {
  const events: FlowRunEvent[] = [
    stepOutput('implement', 'a', true),
    stepOutput('implement', 'b', false),
    stepOutput('implement', 'c'),
    stepOutput('validate', 'd', true),
  ]
  const steps = summarizeStepOutputs(events)
  assert.equal(steps.length, 2)
  assert.deepEqual(steps[0], stepSummary('implement', 3, 1, 1))
  assert.deepEqual(steps[1], stepSummary('validate', 1, 1, 0))
})

test('summarizeStepOutputs orders phases plan, implement, validate, feedback', () => {
  const events: FlowRunEvent[] = [
    stepOutput('feedback', 'a', true),
    stepOutput('validate', 'b', true),
    stepOutput('implement', 'c', true),
    stepOutput('plan', 'd', true),
  ]
  const steps = summarizeStepOutputs(events)
  assert.deepEqual(
    steps.map((summary) => summary.phase),
    ['plan', 'implement', 'validate', 'feedback'],
  )
})

test('summarizeStepOutputs ignores non-step-output events', () => {
  const events: FlowRunEvent[] = [
    noteEvent(
      '2026-11-19T00:01:00Z',
      'subagent c1 ("w") spawn — attribution env stamped',
    ),
    {
      kind: 'run-start',
      at: '2026-11-19T00:00:00Z',
      ref: 'PMR-TEST',
      mode: 'work',
    },
    stepOutput('plan', 'only-real-one', false),
  ]
  const steps = summarizeStepOutputs(events)
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0], stepSummary('plan', 1, 0, 1))
})

test('summarizeStepOutputs returns empty for empty input', () => {
  assert.deepEqual(summarizeStepOutputs([]), [])
})

// AIDEV-NOTE (PMR-C998): computeCostRollup just threads summarizeStepOutputs
// output into the rollup; these fixtures prove the thread end-to-end over
// realistic journal shapes.
test('computeCostRollup surfaces steps for a structured journal and omits them for a legacy one', async () => {
  const structured: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-19T00:00:00Z',
      ref: 'PMR-TEST',
      mode: 'work',
    },
    noteEvent(
      '2026-11-19T00:01:00Z',
      'subagent c1 ("worker-1") spawn — attribution env stamped, session="/sessions/c1.jsonl"',
    ),
    stepOutput('implement', 'a', true),
    stepOutput('implement', 'b', false),
  ]
  const structuredRollup = await computeCostRollup('PMR-TEST', {
    readRunEvents: async () => structured,
    listAssignmentRecords: () => [assignmentRecord('c1')],
    readSessionFile: () => null,
  })
  assert.equal(structuredRollup.kind, 'ok')
  if (structuredRollup.kind !== 'ok') return
  assert.deepEqual(structuredRollup.steps, [stepSummary('implement', 2, 1, 1)])

  const legacy: FlowRunEvent[] = [
    {
      kind: 'run-start',
      at: '2026-11-19T00:00:00Z',
      ref: 'PMR-TEST',
      mode: 'work',
    },
    noteEvent(
      '2026-11-19T00:01:00Z',
      'subagent c2 ("worker-2") spawn — attribution env stamped, session="/sessions/c2.jsonl"',
    ),
  ]
  const legacyRollup = await computeCostRollup('PMR-TEST', {
    readRunEvents: async () => legacy,
    listAssignmentRecords: () => [assignmentRecord('c2')],
    readSessionFile: () => null,
  })
  assert.equal(legacyRollup.kind, 'ok')
  if (legacyRollup.kind !== 'ok') return
  assert.equal(legacyRollup.steps, undefined)
})

test('formatCostReport prints the step outputs section only when steps exist', () => {
  const withSteps = formatCostReport(
    'PMR-TEST',
    [],
    [],
    [stepSummary('implement', 3, 2, 1)],
  )
  assert.equal(
    withSteps.includes('step outputs (advisory, never blocking):'),
    true,
  )
  assert.equal(
    withSteps.includes('  implement: 3 step output(s) (2 ok, 1 failed)'),
    true,
  )

  const withoutSteps = formatCostReport('PMR-TEST', [], [])
  assert.equal(withoutSteps.includes('step outputs'), false)
})
