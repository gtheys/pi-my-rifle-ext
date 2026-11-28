// AIDEV-NOTE: PMR-ZV9Y 2.2 — v2 state-machine emissions of the deviation gate
// (plan phase-2 mapping row "deviation ... + rerun branches"). Pinning the
// gate target journals step-start{validate.deviation}; an accepted verdict
// closes it with step-stop; every verdict-invalidating re-run branch
// (gate-integrity mismatch/stale, diff_lines_read mismatch, artifact parse
// failure) journals state-change{waiting_machine, deviation_gate_rerun}.
// Emissions ride the tool's EXISTING mode-aware writer seam (the same
// writer.record that journals gate-target/gate-decision), so the pre-existing
// deviation tests stay byte-identical (ISC-A-2).
//
// The reviewer spawn is injected (deps.review) because the post-reviewer
// branches are otherwise unreachable without a live subagent mux — the same
// production-defaults/injected-seam pattern as registerRunAttemptTool's deps.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { SubagentResult } from '@gtheys/pi-interactive-subagents'
import {
  clearFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { registerDeviationReviewTool } from '../tools/deviation.ts'
import { DEVIATION_VERDICT_HEADING } from '../validate/deviation-gate.ts'
import { mkTmpDir } from './tmpdir.ts'

const REF = 'PMR-V2DEV'
const WT = mkTmpDir('pi-flow-dev-v2-wt-')
// AIDEV-NOTE: PMR-ZV9Y 2.2 — pin the gate's mode derivation: deriveGateMode
// merges the GLOBAL pi-flow config, whose workRoots differ per machine, so an
// empty project-layer workRoots list makes the fake worktree resolve to
// 'personal' deterministically instead of by luck of the runner's config.
mkdirSync(path.join(WT, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(WT, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [] }),
)
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MOVED = 'c'.repeat(40)

type ExecResult = { code: number; stdout: string; stderr?: string }
type FakeExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<ExecResult>

function fakeExec(opts: { headAfterReview?: string }): FakeExec {
  let headCalls = 0
  return async (cmd, args) => {
    const key = args.join(' ')
    if (cmd === 'aven') {
      return { code: 0, stdout: `${REF} status=active title="dev gate"\n` }
    }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return { code: 0, stdout: JSON.stringify({ result: { worktrees: [] } }) }
    }
    if (cmd === 'git' && args.includes('--git-common-dir')) {
      return { code: 0, stdout: '/repo/.git' }
    }
    if (cmd === 'git' && args.includes('--show-toplevel')) {
      return { code: 0, stdout: `${WT}\n` }
    }
    if (cmd === 'git' && key.includes('rev-parse --abbrev-ref HEAD')) {
      return { code: 0, stdout: 'feat/x\n' }
    }
    if (cmd === 'git' && key === 'config branch.feat/x.flowbase') {
      return { code: 0, stdout: 'develop\n' }
    }
    if (cmd === 'git' && key === 'config branch.feat/x.flowbasesha') {
      return { code: 0, stdout: `${BASE}\n` }
    }
    if (cmd === 'git' && key === 'merge-base HEAD develop') {
      return { code: 0, stdout: `${BASE}\n` }
    }
    if (cmd === 'git' && key === 'rev-parse HEAD') {
      headCalls += 1
      // The FIRST call is range resolution; the second is the gate's
      // staleness recheck (verifyGateWithExec) — only that one may differ.
      if (headCalls > 1 && opts.headAfterReview !== undefined) {
        return { code: 0, stdout: `${opts.headAfterReview}\n` }
      }
      return { code: 0, stdout: `${HEAD}\n` }
    }
    if (cmd === 'git' && key.includes('rev-list --count')) {
      return { code: 0, stdout: '1\n' }
    }
    if (cmd === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/x.ts b/x.ts\n+save()\n' }
    }
    if (cmd === 'git' && args[0] === 'log') {
      return { code: 0, stdout: 'feat: dev gate wiring\n' }
    }
    return { code: 1, stdout: '', stderr: `unexpected exec: ${cmd} ${key}` }
  }
}

function artifact(range: string, body: string): SubagentResult {
  return {
    name: 'Deviation check',
    task: 'deviation review',
    summary: `${range}\n${DEVIATION_VERDICT_HEADING}\n${body}`,
    exitCode: 0,
    elapsed: 1,
  }
}

function harness(opts: {
  review: (prompt: string) => Promise<SubagentResult>
  exec?: FakeExec
  /** when set, writer.record throws on these kinds (never-throw probe). */
  throwOnKinds?: FlowRunEvent['kind'][]
}): { events: FlowRunEvent[]; run: () => Promise<{ isError?: boolean }> } {
  const events: FlowRunEvent[] = []
  const writer: EventWriter = {
    record: async (event: FlowRunEvent) => {
      if (opts.throwOnKinds?.includes(event.kind)) {
        throw new Error('journal exploded')
      }
      events.push(event)
      return true
    },
    recordJournalOnly: async (event: FlowRunEvent) => {
      events.push(event)
    },
  }
  let execute:
    | ((
        id: string,
        params: unknown,
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ isError?: boolean }>)
    | undefined
  const mockPi = {
    registerTool: (options: { execute: typeof execute }) => {
      execute = options.execute
    },
    on: () => () => {},
    exec: opts.exec ?? fakeExec({}),
  } as unknown as ExtensionAPI
  registerDeviationReviewTool(mockPi, writer, {
    review: async (_ctx, prompt) => opts.review(prompt),
  })
  if (!execute) throw new Error('deviation_review tool not registered')
  const registered = execute
  const run = async () => {
    setActiveFlowRef(REF)
    setFlowWorktree(WT, 'feat/x')
    try {
      return await registered(
        'call',
        {
          mode: 'personal',
          ref: REF,
          spec: 'The feature must persist user settings across restarts.',
          avenNotes: '',
        },
        new AbortController().signal,
        undefined,
        { cwd: '/repo' },
      )
    } finally {
      setActiveFlowRef(null)
      clearFlowWorktree()
    }
  }
  return { events, run }
}

function v2View(events: FlowRunEvent[]) {
  const view: unknown[] = []
  for (const event of events) {
    if (event.kind === 'state-change') {
      view.push({ state: event.state, reason: event.reason })
    } else if (event.kind === 'step-start' || event.kind === 'step-stop') {
      view.push({ kind: event.kind, phase: event.phase, step: event.step })
    }
  }
  return view
}

function gateDecisions(events: FlowRunEvent[]) {
  return events.filter(
    (event): event is Extract<FlowRunEvent, { kind: 'gate-decision' }> =>
      event.kind === 'gate-decision',
  )
}

const PINNED = {
  kind: 'step-start',
  phase: 'validate',
  step: 'validate.deviation',
}
const VERDICT = {
  kind: 'step-stop',
  phase: 'validate',
  step: 'validate.deviation',
}
const RERUN = { state: 'waiting_machine', reason: 'deviation_gate_rerun' }
const ECHO = `reviewed_range: ${BASE}..${HEAD}`

test('accepted verdict journals step-start then step-stop', async () => {
  const h = harness({
    review: async () => artifact(ECHO, 'deviations_count: 0\n'),
  })
  const result = await h.run()
  assert.notEqual(result.isError, true)
  assert.deepEqual(v2View(h.events), [PINNED, VERDICT])
  // The v1 gate evidence stream is untouched: gate-target and gate-decision
  // still bracket the step events on the SAME writer.
  assert.deepEqual(
    h.events.map((event) => event.kind),
    ['gate-target', 'step-start', 'gate-decision', 'step-stop'],
  )
})

test('artifact parse failure journals the rerun wait, not a step-stop', async () => {
  const h = harness({
    review: async () => artifact(ECHO, 'no count line at all\n'),
  })
  const result = await h.run()
  assert.equal(result.isError, true)
  assert.deepEqual(v2View(h.events), [PINNED, RERUN])
})

// AIDEV-NOTE: PMR-SPND — verdict semantics of the journaled gate-decision:
// pass = the gate ran, parsed strictly, found 0 deviations; fail = ran,
// parsed, found >0; event presence records successful execution/parsing, so
// a parse failure must journal NO gate-decision (never a pass).
test('deviations found journal a fail gate-decision, never a pass', async () => {
  const h = harness({
    review: async () =>
      artifact(
        ECHO,
        'deviations_count: 2\n' +
          '- deviation: skipped retry budget | why: spec demands it (inferred: no retry in diff) | src/retry.ts:12\n' +
          '- deviation: missing audit note | why: D5 requires it (inferred: absent from the log) | src/audit.ts:40\n',
      ),
  })
  const result = await h.run()
  assert.notEqual(result.isError, true)
  const decisions = gateDecisions(h.events)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.status, 'fail')
})

test('a clean zero-deviation verdict journals a pass gate-decision', async () => {
  const h = harness({
    review: async () => artifact(ECHO, 'deviations_count: 0\n'),
  })
  const result = await h.run()
  assert.notEqual(result.isError, true)
  const decisions = gateDecisions(h.events)
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0]?.status, 'pass')
})

test('a parse failure journals no gate-decision at all', async () => {
  const h = harness({
    review: async () => artifact(ECHO, 'no count line at all\n'),
  })
  const result = await h.run()
  assert.equal(result.isError, true)
  assert.deepEqual(gateDecisions(h.events), [])
})

test('reviewer that echoed the wrong range journals the rerun wait', async () => {
  const h = harness({
    review: async () =>
      artifact(
        `reviewed_range: ${'d'.repeat(40)}..${HEAD}`,
        'deviations_count: 0\n',
      ),
  })
  const result = await h.run()
  assert.equal(result.isError, true)
  assert.deepEqual(v2View(h.events), [PINNED, RERUN])
})

test('a moved HEAD (stale verdict) journals the rerun wait', async () => {
  const h = harness({
    exec: fakeExec({ headAfterReview: MOVED }),
    review: async () => artifact(ECHO, 'deviations_count: 0\n'),
  })
  const result = await h.run()
  assert.equal(result.isError, true)
  assert.deepEqual(v2View(h.events), [PINNED, RERUN])
})

test('re-run after a failed attempt journals no duplicate step-start', async () => {
  let calls = 0
  const h = harness({
    review: async () => {
      calls += 1
      if (calls === 1) return artifact(ECHO, 'no count line at all\n')
      return artifact(ECHO, 'deviations_count: 0\n')
    },
  })
  const failed = await h.run()
  assert.equal(failed.isError, true)
  const retried = await h.run()
  assert.notEqual(retried.isError, true)
  assert.deepEqual(v2View(h.events), [PINNED, RERUN, VERDICT])
})

test('a throwing v2 write never fails the gate (ISC-A-5)', async () => {
  const h = harness({
    review: async () => artifact(ECHO, 'deviations_count: 0\n'),
    throwOnKinds: ['step-start', 'step-stop'],
  })
  const result = await h.run()
  assert.notEqual(result.isError, true)
})
