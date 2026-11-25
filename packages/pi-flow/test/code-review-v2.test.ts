// AIDEV-NOTE: PMR-ZV9Y 2.2 — v2 state-machine emissions of the code-review
// gate (plan phase-2 mapping row "code-review ask/answer"). The blocking
// ask_user_question gate journals state-change{waiting_human,
// code_review_pending} + step-start{validate.code-review} BEFORE it waits, and
// step-stop{validate.code-review} + state-change{running} when the human
// answers — pass or fail, both end the wait. Emissions ride the tool's
// EXISTING mode-aware writer seam, so the pre-existing harnesses (which never
// pass a writer) stay byte-identical (ISC-A-2). Harness: code-review.test.ts
// (command-aware aven/herdr/git/tuicr fake + fake aven on PATH).
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { FlowRunEvent } from '../run-state.ts'
import type { EventWriter } from '../server/writer.ts'
import { registerCodeReviewTool } from '../tools/code-review.ts'
import { mkTmpDir } from './tmpdir.ts'

// productionReviewDeps wires exists to existsSync, so the herdr fixture must
// point at a REAL temp dir.
const CR_WT_DIR = mkTmpDir('pi-flow-cr-v2-wt-')
const AVEN_FAKE_DIR = mkTmpDir('pi-flow-cr-v2-bin-')
writeFileSync(path.join(AVEN_FAKE_DIR, 'aven'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(AVEN_FAKE_DIR, 'aven'), 0o755)

const REF = 'PMR-ABC1'

async function withFakeAvenPath(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${AVEN_FAKE_DIR}:${previousPath}`
  try {
    await fn()
  } finally {
    if (previousPath === '') delete process.env.PATH
    else process.env.PATH = previousPath
  }
}

type MockExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>

function gateExec(commentsStdout: string): MockExec {
  return async (cmd, args) => {
    if (cmd === 'aven') {
      return {
        code: 0,
        stdout: 'PMR-ABC1 status=todo title="feat(pi-flow): alpha gate"\n',
        stderr: '',
      }
    }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            worktrees: [
              {
                branch: 'feat/PMR-ABC1-alpha-gate',
                path: CR_WT_DIR,
                label: 'alpha',
                open_workspace_id: 'w1',
                is_linked_worktree: true,
              },
            ],
          },
        }),
        stderr: '',
      }
    }
    if (cmd === 'git' && args.includes('--git-common-dir')) {
      return { code: 0, stdout: '/repo/.git\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/PMR-ABC1-alpha-gate\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('merge-base')) {
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    if (cmd === 'herdr' && args[0] === 'tab') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }),
        stderr: '',
      }
    }
    if (cmd === 'tuicr' && args[1] === 'list') {
      return { code: 0, stdout: '[]', stderr: '' }
    }
    if (cmd === 'tuicr' && args[1] === 'comments') {
      return { code: 0, stdout: commentsStdout, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

type Execute = (
  toolCallId: string,
  params: { ref: string },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<{
  isError?: boolean
  content: Array<{ type: string; text: string }>
}>

/** Answers the gate ask in order (one entry per execute() call). */
function harness(opts: {
  answers: string[]
  comments?: string
  resolveHead?: (cwd: string) => Promise<string | null>
  throwOnKind?: FlowRunEvent['kind']
}): { execute: Execute; events: FlowRunEvent[] } {
  const events: FlowRunEvent[] = []
  const writer: EventWriter = {
    record: async (event: FlowRunEvent) => {
      if (opts.throwOnKind !== undefined && event.kind === opts.throwOnKind) {
        throw new Error('journal exploded')
      }
      events.push(event)
      return true
    },
    recordJournalOnly: async (event: FlowRunEvent) => {
      events.push(event)
    },
  }
  let execute: Execute | undefined
  const mockPi = {
    registerTool: (options: { execute: Execute }) => {
      execute = options.execute
    },
    exec: gateExec(opts.comments ?? ''),
  }
  const landingState = { authorized: null, humanReviewPassed: null }
  registerCodeReviewTool(
    mockPi as unknown as Parameters<typeof registerCodeReviewTool>[0],
    landingState,
    undefined,
    opts.resolveHead,
    writer,
  )
  if (!execute) throw new Error('code_review tool not registered')
  const registered = execute
  let asked = 0
  const gated: Execute = (id, params, signal, onUpdate) => {
    const answer = opts.answers[Math.min(asked, opts.answers.length - 1)]
    asked += 1
    return registered(id, params, signal, onUpdate, {
      cwd: '/repo',
      tools: [{ name: 'ask_user_question' }],
      ui: { notify: () => {} },
      executeTool: async () => ({
        result: { content: [{ type: 'text', text: answer }] },
      }),
    })
  }
  return { execute: gated, events }
}

// Compact view of the v2 slice of the stream for readable assertions.
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

const OPEN = [
  { state: 'waiting_human', reason: 'code_review_pending' },
  { kind: 'step-start', phase: 'validate', step: 'validate.code-review' },
]
const CLOSE = [
  { kind: 'step-stop', phase: 'validate', step: 'validate.code-review' },
  { state: 'running', reason: undefined },
]

test('pass: pending pair before the ask, close pair on the answer', async () => {
  await withFakeAvenPath(async () => {
    const h = harness({
      answers: ['User selected: pass (Recommended)'],
      resolveHead: async () => null,
    })
    const result = await h.execute(
      't1',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.notEqual(result.isError, true)
    assert.deepEqual(v2View(h.events), [...OPEN, ...CLOSE])
  })
})

test('fail: the wait closes with step-stop + state-change{running}', async () => {
  await withFakeAvenPath(async () => {
    const h = harness({
      answers: ['User selected: fail'],
      comments: 'blocker: null deref in auth.ts',
    })
    const result = await h.execute(
      't2',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.equal(result.isError, true)
    assert.deepEqual(v2View(h.events), [...OPEN, ...CLOSE])
  })
})

test('unclear answer then a re-call: one step-start pair for the whole wait', async () => {
  await withFakeAvenPath(async () => {
    // First call: the answer is unclear -> the tool errors and tells the agent
    // to re-ask. The wait is NOT over, so nothing closes and the pairing guard
    // keeps the SECOND call from re-journaling step-start/state-change.
    const h = harness({
      answers: ['User selected: Other', 'User selected: pass (Recommended)'],
      resolveHead: async () => null,
    })
    const first = await h.execute(
      't3a',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.equal(first.isError, true)
    assert.deepEqual(v2View(h.events), OPEN)
    const second = await h.execute(
      't3b',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.notEqual(second.isError, true)
    assert.deepEqual(v2View(h.events), [...OPEN, ...CLOSE])
  })
})

test('the close pair lands beside the durable pass receipt on one seam', async () => {
  await withFakeAvenPath(async () => {
    const h = harness({
      answers: ['User selected: pass (Recommended)'],
      resolveHead: async () => 'head0123',
    })
    const result = await h.execute(
      't4',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.notEqual(result.isError, true)
    // Every write — v1 command-receipt and the four v2 events — rides the
    // single injected writer seam, in journal order.
    assert.deepEqual(
      h.events.map((event) => event.kind),
      [
        'state-change',
        'step-start',
        'command-receipt',
        'step-stop',
        'state-change',
      ],
    )
  })
})

test('a throwing v2 write never fails the gate (ISC-A-5)', async () => {
  await withFakeAvenPath(async () => {
    const h = harness({
      answers: ['User selected: pass (Recommended)'],
      resolveHead: async () => null,
      throwOnKind: 'state-change',
    })
    const result = await h.execute(
      't5',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {},
    )
    assert.notEqual(result.isError, true)
    assert.match(result.content.map((c) => c.text).join('\n'), /human PASS/)
  })
})

test('ask unavailable (fail-closed refusal) journals no v2 events', async () => {
  await withFakeAvenPath(async () => {
    let execute: Execute | undefined
    const events: FlowRunEvent[] = []
    const writer: EventWriter = {
      record: async (event) => {
        events.push(event)
        return true
      },
      recordJournalOnly: async (event) => {
        events.push(event)
      },
    }
    const mockPi = {
      registerTool: (options: { execute: Execute }) => {
        execute = options.execute
      },
      exec: gateExec(''),
    }
    registerCodeReviewTool(
      mockPi as unknown as Parameters<typeof registerCodeReviewTool>[0],
      { authorized: null, humanReviewPassed: null },
      undefined,
      undefined,
      writer,
    )
    if (!execute) throw new Error('code_review tool not registered')
    const result = await execute(
      't6',
      { ref: REF },
      new AbortController().signal,
      undefined,
      {
        cwd: '/repo',
        // No ask_user_question tool: the fail-closed refusal path.
        tools: [],
        ui: { notify: () => {} },
        executeTool: async () => ({ result: { content: [] } }),
      },
    )
    assert.equal(result.isError, true)
    assert.deepEqual(events, [])
  })
})
