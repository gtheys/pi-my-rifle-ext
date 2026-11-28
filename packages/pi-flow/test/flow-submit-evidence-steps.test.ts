// PMR-S7FQ — evidence-only registered step names for the flow_submit boundaries
// the prompts already ask an agent to journal, in the phases that ACTUALLY warn.
//
// Contract pinned here:
//  1. `plan.route-confirmed`, `validate.review-tool` and `validate.land` are
//     REGISTERED names, so an honest flow_submit for those boundaries no longer
//     draws the "not in the <phase> step registry" advisory.
//  2. They are EVIDENCE-ONLY: no tool emits a machine step-start/step-stop pair
//     for them (same documented shape as validate.spec-diff /
//     validate.aven-notes), so registering them adds no boundary and no new
//     Prometheus step window.
//  3. The advisory stays alive for names that are NOT registered — a genuinely
//     malformed step label must still surface (silencing everything is the
//     failure mode this ticket warns about).
//  4. `implement` and `feedback` registries stay EMPTY on purpose.
//     flow/step-output.ts:301-308 only hints when the phase registry is
//     non-empty, so those phases are hint-free by design (option (b) is
//     already in force there); populating them would TURN THE ADVISORY ON for
//     every free-form implement label and increase the noise this ticket exists
//     to remove.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { scanStepWindows } from '../flow/state-metrics.ts'
import { buildStepOutputEvent } from '../flow/step-output.ts'
import { isRegisteredStep, STEP_REGISTRY } from '../flow/steps.ts'
import type { FlowPhase, FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import type { FlowSubmitDetails } from '../tools/flow-submit.ts'
import { registerFlowSubmitTool } from '../tools/flow-submit.ts'

// The three names this ticket registers, with the prompt boundary each covers.
const EVIDENCE_ONLY_NAMES = [
  ['plan', 'plan.route-confirmed'],
  ['validate', 'validate.review-tool'],
  ['validate', 'validate.land'],
] as const

// Names observed in the PMR-R77R flow (the ticket's evidence). They stay
// UNREGISTERED — the registry is a bounded closed enum (ISC-A-1), so free-form
// variants keep warning instead of every phrasing being added.
const OBSERVED_UNREGISTERED: ReadonlyArray<readonly [FlowPhase, string]> = [
  ['plan', 'plan-oneshot-route-confirmed'],
  ['validate', 'validate.review-gate-blockers-0-routed-to-implement'],
  ['validate', 'validate.landed-merge-main'],
]

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

/** Minimal phase-legal fact set for a submission (facts are phase-keyed). */
function phaseFacts(phase: FlowPhase): {
  planPath?: string
  command?: string
  passed?: boolean
  prUrl?: string
} {
  if (phase === 'plan') {
    return { planPath: 'plan.md' }
  }
  if (phase === 'implement') {
    return { command: 'bun run test', passed: true }
  }
  if (phase === 'validate') {
    return { prUrl: 'https://example.test/pr/1' }
  }
  return {}
}

// --- 1. the names are registered -------------------------------------------

test('PMR-S7FQ: the evidence-only names are registered for their phase', () => {
  for (const [phase, step] of EVIDENCE_ONLY_NAMES) {
    assert.equal(
      isRegisteredStep(phase, step),
      true,
      `${step} must be registered under ${phase}`,
    )
    assert.ok(
      (STEP_REGISTRY[phase] as readonly string[]).includes(step),
      `${step} must appear in STEP_REGISTRY.${phase} (the advisory hint lists it)`,
    )
  }
})

// ISC-A-1 / ISC-A-2: the registry stays a bounded closed enum over exactly the
// four phases, and the additions are the ONLY ones (no open-ended vocabulary).
test('PMR-S7FQ: the closed enum stays bounded to four phases', () => {
  assert.deepEqual(Object.keys(STEP_REGISTRY).sort(), [
    'feedback',
    'implement',
    'plan',
    'validate',
  ])
  for (const phase of Object.keys(STEP_REGISTRY) as FlowPhase[]) {
    const names = STEP_REGISTRY[phase] as readonly string[]
    for (const name of names) {
      assert.match(
        name,
        /^[a-z]+\.[A-Za-z0-9._-]{1,63}$/,
        `${name} must match the step-name charset`,
      )
      assert.ok(name.startsWith(`${phase}.`), `${name} must be phase-prefixed`)
    }
  }
})

// --- 2. registered evidence-only names are no longer nagged ----------------

test('PMR-S7FQ: flow_submit on a registered evidence-only name carries no advisory', () => {
  for (const [phase, step] of EVIDENCE_ONLY_NAMES) {
    const built = buildStepOutputEvent({
      ref: 'PMR-EV1',
      phase,
      step,
      ok: true,
      ...phaseFacts(phase),
    })
    assert.equal(built.ok, true)
    if (built.ok !== true) continue
    assert.equal(
      built.hint,
      undefined,
      `${step} must not draw the registry advisory`,
    )
  }
})

test('PMR-S7FQ: the tool result text for validate.land / validate.review-tool has no advisory', async () => {
  for (const step of ['validate.review-tool', 'validate.land']) {
    const { writer, captured } = memoryWriter()
    const execute = captureTool({
      writer,
      resolveHead: async () => null,
      readEvents: async () => [],
    })
    const result = await execute('t1', {
      ref: 'PMR-S7FQ',
      step,
      output: { phase: 'validate', prUrl: 'https://example.test/pr/9' },
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.details?.ok, true)
    assert.equal(result.details?.journaled, true)
    assert.equal(captured.length, 1)
    assert.match(result.content[0].text, /journaled on PMR-S7FQ/)
    assert.doesNotMatch(result.content[0].text, /advisory/i)
    assert.doesNotMatch(result.content[0].text, /registered names/i)
  }
})

// --- 3. the advisory survives for unregistered names ----------------------

test('PMR-S7FQ: unregistered names in a non-empty registry still warn', () => {
  for (const [phase, step] of OBSERVED_UNREGISTERED) {
    const built = buildStepOutputEvent({
      ref: 'PMR-EV2',
      phase,
      step,
      ok: true,
      ...phaseFacts(phase),
    })
    assert.equal(built.ok, true, `${step} must still journal`)
    if (built.ok !== true) continue
    assert.ok(built.hint !== undefined, `${step} must still draw the advisory`)
    assert.match(built.hint ?? '', /not in the .* step registry/)
    // The hint lists the registered vocabulary, so the agent can self-correct.
    assert.match(built.hint ?? '', new RegExp(step.replace(/\./g, '\\.')))
    for (const name of STEP_REGISTRY[phase] as readonly string[]) {
      assert.match(built.hint ?? '', new RegExp(name.replace(/\./g, '\\.')))
    }
  }
})

// --- 4. implement/feedback stay hint-free (empty registry by design) ------

test('PMR-S7FQ: implement/feedback registries stay empty and are never nagged', () => {
  assert.deepEqual(
    [...STEP_REGISTRY.implement],
    [],
    'implement stays free-form',
  )
  assert.deepEqual([...STEP_REGISTRY.feedback], [], 'feedback stays free-form')
  for (const phase of ['implement', 'feedback'] as FlowPhase[]) {
    const built = buildStepOutputEvent({
      ref: 'PMR-EV3',
      phase,
      step: 'implement.tests-green-and-committed',
      ok: true,
      ...phaseFacts(phase),
    })
    assert.equal(built.ok, true)
    if (built.ok !== true) continue
    assert.equal(
      built.hint,
      undefined,
      `an empty ${phase} registry must suppress the advisory (flow/step-output.ts:301-308)`,
    )
  }
})

// --- 5. evidence-only means NO machine boundary ---------------------------

// Registering a name must not fabricate a Prometheus step window: flow_submit
// journals a `step-output` event, while scanStepWindows only reads
// step-start/step-stop (flow/state-metrics.ts). So an evidence-only name never
// reaches the pi_flow_step label surface, exactly like spec-diff/aven-notes.
test('PMR-S7FQ: an evidence-only submission creates no Prometheus step window', () => {
  const built = buildStepOutputEvent({
    ref: 'PMR-EV4',
    phase: 'validate',
    step: 'validate.land',
    ok: true,
    prUrl: 'https://example.test/pr/1',
  })
  assert.equal(built.ok, true)
  if (built.ok !== true) return
  const scan = scanStepWindows([built.event as unknown as FlowRunEvent])
  assert.equal(scan.seconds.size, 0)
  assert.deepEqual(scan.open, [])
})
