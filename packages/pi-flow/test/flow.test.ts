import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { answerUsageText } from '../flow/answer.ts'
import { parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL } from '../flow/orchestrate.ts'
import {
  mergeSeedInput,
  resumeSeedFromEvents,
  runInputRecord,
} from '../flow/resume.ts'
import flowExtension, { setAvenSessionCwd } from '../index.ts'

// --- parseFlowArgs ---

test('parseFlowArgs: aven ref', () => {
  const parsed = parseFlowArgs('PMR-abc123')
  assert.deepEqual(parsed, { kind: 'aven', ref: 'PMR-abc123' })
})

test('parseFlowArgs: jira ref normalizes', () => {
  const parsed = parseFlowArgs('dp-71')
  assert.deepEqual(parsed, { kind: 'jira', jiraId: 'DP-71' })
})

test('parseFlowArgs: empty is help', () => {
  assert.equal(parseFlowArgs('').kind, 'help')
  assert.equal(parseFlowArgs('  ').kind, 'help')
})

test('parseFlowArgs: extra positional args are help', () => {
  assert.equal(parseFlowArgs('a b').kind, 'help')
})

test('parseFlowArgs: bare help token is usage, not an aven ref (PMR-N0W6)', () => {
  assert.equal(parseFlowArgs('help').kind, 'help')
  assert.equal(parseFlowArgs('HELP').kind, 'help')
  assert.equal(parseFlowArgs('Help').kind, 'help')
  // Only the exact token is reserved — similar strings still parse as refs.
  assert.deepEqual(parseFlowArgs('helpme'), { kind: 'aven', ref: 'helpme' })
  assert.deepEqual(parseFlowArgs('PMR-help'), { kind: 'aven', ref: 'PMR-help' })
})

// --- nextPhase (pure resolver, mapping table; PIV lifecycle, PMR-Z2K7) ---

test('nextPhase: no labels -> plan', () => {
  assert.deepEqual(nextPhase([]), { kind: 'phase', phase: 'plan' })
})

test('nextPhase: planned -> implement', () => {
  assert.deepEqual(nextPhase(['planned']), {
    kind: 'phase',
    phase: 'implement',
  })
})

test('nextPhase: active -> validate', () => {
  assert.deepEqual(nextPhase(['planned', 'active']), {
    kind: 'phase',
    phase: 'validate',
  })
})

test('nextPhase: review-passed -> feedback', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed']), {
    kind: 'phase',
    phase: 'feedback',
  })
})

test('nextPhase: personal review-passed -> done (feedback folded into validate)', () => {
  assert.deepEqual(
    nextPhase(['planned', 'active', 'review-passed'], 'personal'),
    { kind: 'done' },
  )
})

test('nextPhase: work review-passed -> feedback (explicit mode)', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed'], 'work'), {
    kind: 'phase',
    phase: 'feedback',
  })
})

test('nextPhase: done label -> done', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed', 'done']), {
    kind: 'done',
  })
})

test('nextPhase: mid-flow kill resumes at implement without duplicates', () => {
  // Labels as they exist after a kill during implement (plan done,
  // active not yet set). Re-running yields implement, then the same labels
  // again yield implement — idempotent, no phase is skipped or repeated.
  const labels = ['planned']
  const first = nextPhase(labels)
  const second = nextPhase(labels)
  assert.deepEqual(first, { kind: 'phase', phase: 'implement' })
  assert.deepEqual(second, { kind: 'phase', phase: 'implement' })
})

test('nextPhase: legacy research-era labels do not affect resolution', () => {
  assert.deepEqual(nextPhase(['researched', 'research-skipped']), {
    kind: 'phase',
    phase: 'plan',
  })
  assert.deepEqual(nextPhase(['researched', 'research-skipped', 'planned']), {
    kind: 'phase',
    phase: 'implement',
  })
})

test('PHASE_LABEL maps every phase to its lifecycle label', () => {
  assert.equal(PHASE_LABEL.plan, 'planned')
  assert.equal(PHASE_LABEL.implement, 'active')
  assert.equal(PHASE_LABEL.validate, 'review-passed')
  assert.equal(PHASE_LABEL.feedback, 'done')
})

test('parseFlowArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parseFlowArgs('aven:DP-71'), {
    kind: 'aven',
    ref: 'DP-71',
  })
  assert.deepEqual(parseFlowArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})

// --- resumeSeedFromEvents (PMR-XTQQ phase 2: /flow resume seeding) ---

test('resume seed: parked loop-state + run-input seeds budget, cutoff, and input', async () => {
  const cutoff = '2026-11-14T10:00:00.000Z'
  const events = [
    {
      kind: 'run-start' as const,
      at: 't',
      ref: 'R',
      mode: 'personal' as const,
    },
    {
      kind: 'run-input' as const,
      at: 't',
      ref: 'R',
      input: { mode: 'personal' as const, gitRoot: '/repo', workRoots: [] },
    },
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: true,
        blockerRetries: 1,
        validateStartedAt: cutoff,
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => true)
  assert.deepEqual(seed.resume, {
    blockerRetries: 1,
    validateStartedAt: cutoff,
  })
  assert.deepEqual(seed.input, {
    mode: 'personal',
    gitRoot: '/repo',
    workRoots: [],
  })
})

test('resume seed: latest loop-state and run-input win (journal tail)', async () => {
  const events = [
    {
      kind: 'loop-state' as const,
      at: 't1',
      ref: 'R',
      loop: {
        phase: 'plan' as const,
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'old',
        status: 'running' as const,
      },
    },
    {
      kind: 'loop-state' as const,
      at: 't2',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: true,
        blockerRetries: 2,
        validateStartedAt: 'new',
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => true)
  assert.deepEqual(seed.resume, {
    blockerRetries: 2,
    validateStartedAt: 'new',
  })
})

test('resume seed: terminal snapshots never seed', async () => {
  const events = [
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'validate' as const,
        awaitingOutcome: false,
        blockerRetries: 2,
        validateStartedAt: 'cutoff',
        status: 'halted' as const,
      },
    },
  ]
  assert.deepEqual(
    resumeSeedFromEvents(events, () => true),
    {},
  )
})

test('resume seed: journaled run-input ignored when its gitRoot vanished', async () => {
  const events = [
    {
      kind: 'run-input' as const,
      at: 't',
      ref: 'R',
      input: {
        mode: 'personal' as const,
        gitRoot: '/gone/worktree',
        workRoots: [],
      },
    },
    {
      kind: 'loop-state' as const,
      at: 't',
      ref: 'R',
      loop: {
        phase: 'plan' as const,
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: 'cutoff',
        status: 'running' as const,
      },
    },
  ]
  const seed = resumeSeedFromEvents(events, () => false)
  assert.equal(seed.input, undefined)
  assert.notEqual(seed.resume, undefined)
})

test('resume seed: empty or missing journal seeds nothing', async () => {
  assert.deepEqual(
    resumeSeedFromEvents(null, () => true),
    {},
  )
  assert.deepEqual(
    resumeSeedFromEvents([], () => true),
    {},
  )
})

// --- /flow run-input journaling content (PMR-XTQQ 2.2; call site: the
// --- /flow command handler in index.ts, via mergeSeedInput + runInputRecord)

test('run-input: seed override wins; journal carries only the serializable subset', () => {
  const promptInput = {
    mode: 'personal' as const,
    gitRoot: '/repo',
    workRoots: ['/fresh'],
    labels: ['planned'] as readonly string[],
    findTicketRef: () => null,
  }
  const seeded = mergeSeedInput(promptInput, {
    input: { mode: 'work', gitRoot: '/parked', workRoots: ['/parked-w'] },
  })
  // The journaled record: journaled scalars win, closures/labels never leak.
  assert.deepEqual(runInputRecord(seeded), {
    mode: 'work',
    gitRoot: '/parked',
    workRoots: ['/parked-w'],
  })
  // The merged promptInput keeps its non-journaled fields.
  assert.equal(seeded.labels, promptInput.labels)
})

test('run-input: no seed keeps the freshly rebuilt promptInput as-is', () => {
  const promptInput = {
    mode: 'personal' as const,
    gitRoot: '/repo',
    workRoots: ['/fresh'],
  }
  assert.equal(mergeSeedInput(promptInput, {}), promptInput)
  assert.deepEqual(runInputRecord(promptInput), {
    mode: 'personal',
    gitRoot: '/repo',
    workRoots: ['/fresh'],
  })
})
// --- /flow handler dispatch: answer path (PMR-R5VB subtask 1.4) ---

const HANDLER_BIN = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-handler-bin-'))
const HANDLER_LOG = path.join(HANDLER_BIN, 'calls.txt')
const HANDLER_MODE = path.join(HANDLER_BIN, 'mode.txt')
writeFileSync(HANDLER_MODE, 'ok')
writeFileSync(HANDLER_LOG, '')
writeFileSync(
  path.join(HANDLER_BIN, 'aven'),
  `#!/bin/sh
printf '%s ' "$@" >> ${HANDLER_LOG}
echo >> ${HANDLER_LOG}
mode=$(cat ${HANDLER_MODE})
if [ "$1" = "show" ]; then
  if [ "$mode" = "error" ]; then
    exit 1
  fi
  echo "$2 status=todo title=x"
  exit 0
fi
if [ "$1" = "edit" ]; then
  echo "updated $2"
  exit 0
fi
if [ "$1" = "note" ]; then
  exit 0
fi
exit 1
`,
)
chmodSync(path.join(HANDLER_BIN, 'aven'), 0o755)

const HANDLER_WS = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-handler-ws-'))
// PMR-XTQQ: keep the handler tests hermetic — the merged /flow run path
// ensures the durable run server before reading aven labels; the kill switch
// (project override config) skips the daemon spawn in these tests.
mkdirSync(path.join(HANDLER_WS, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(HANDLER_WS, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], runServer: { enabled: false } }),
)
const HANDLER_AGENT_DIR = mkdtempSync(
  path.join(os.tmpdir(), 'pi-flow-handler-agent-'),
)

after(() => {
  rmSync(HANDLER_BIN, { recursive: true, force: true })
  rmSync(HANDLER_WS, { recursive: true, force: true })
  rmSync(HANDLER_AGENT_DIR, { recursive: true, force: true })
})

function withHandlerEnv(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PATH = `${HANDLER_BIN}:${previousPath ?? ''}`
  process.env.PI_CODING_AGENT_DIR = HANDLER_AGENT_DIR
  setAvenSessionCwd(HANDLER_WS)
  return fn().finally(() => {
    if (previousPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = previousPath
    }
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
    writeFileSync(HANDLER_LOG, '')
  })
}

interface FlowCallCtx {
  handler: (args: string, ctx: unknown) => Promise<void>
  sent: string[]
  shortcuts: Map<
    string,
    { description: string; handler: (ctx: unknown) => Promise<void> }
  >
}

// AIDEV-NOTE: fake ExtensionAPI via Proxy — captures registerCommand('flow')
// and sendUserMessage; every other registration method is a no-op so the
// full default extension wires without a live Pi session.
function captureFlowCommand(): FlowCallCtx {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const shortcuts = new Map<
    string,
    { description: string; handler: (ctx: unknown) => Promise<void> }
  >()
  const sent: string[] = []
  const base = {
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, def)
    },
    // Captures registerShortcut calls so shortcut/command parity (same toggle
    // path) can be asserted. Note: the /hotkeys no-collision check (alt+shift+d
    // verified free among Pi built-ins and in-repo extensions) is a manual
    // check that cannot run under node --test.
    registerShortcut: (
      key: string,
      def: { description: string; handler: (ctx: unknown) => Promise<void> },
    ) => {
      shortcuts.set(key, def)
    },
    sendUserMessage: (message: string) => {
      sent.push(message)
    },
    exec: async () => ({ stdout: `${HANDLER_WS}\n`, stderr: '' }),
  }
  const pi = new Proxy(base, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target]
      }
      return () => {}
    },
  }) as unknown as ExtensionAPI
  flowExtension(pi)
  const def = commands.get('flow')
  if (def === undefined) {
    throw new Error('/flow command was not registered')
  }
  return { handler: def.handler, sent, shortcuts }
}

function flowCtx(
  notifications: Array<{ message: string; level: string }>,
): unknown {
  return {
    cwd: HANDLER_WS,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
  }
}

test('flow handler: answer routes to answer path, never sendUserMessage', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('answer PMR-XXX approve', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /PMR-XXX spec=approve recorded/)
    const calls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(calls, /edit PMR-XXX/)
    assert.match(calls, /spec-answer=approve/)
    assert.match(calls, /note PMR-XXX/)
    const journal = readFileSync(
      path.join(HANDLER_AGENT_DIR, 'pi-flow', 'runs', 'PMR-XXX.journal.jsonl'),
      'utf8',
    )
    assert.match(journal, /"kind":"gate-answer"/)
    assert.match(journal, /"gate":"spec-review"/)
  })
})

test('flow handler: answer bad choice and bare answer show usage, no writes', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('answer PMR-XXX maybe', flowCtx(notifications))
    await handler('answer', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 2)
    assert.equal(notifications[0].message, answerUsageText)
    assert.equal(notifications[0].level, 'info')
    assert.equal(notifications[1].message, answerUsageText)
    assert.equal(readFileSync(HANDLER_LOG, 'utf8'), '')
  })
})

test('flow handler: answer with invalid ref charset warns, no writes', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('answer bad!ref approve', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'warning')
    assert.match(notifications[0].message, /invalid ref/)
    assert.equal(readFileSync(HANDLER_LOG, 'utf8'), '')
  })
})

test('flow handler: plain ref takes the run path (aven labels read), no answer writes', async () => {
  await withHandlerEnv(async () => {
    writeFileSync(HANDLER_MODE, 'error')
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('PMR-XXX', flowCtx(notifications))
    writeFileSync(HANDLER_MODE, 'ok')
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'warning')
    assert.match(notifications[0].message, /cannot read aven labels/)
    const calls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(calls, /show PMR-XXX/)
    assert.doesNotMatch(calls, /edit PMR-XXX/)
    assert.doesNotMatch(calls, /note PMR-XXX/)
  })
})

// AIDEV-NOTE (PMR-C3B6): the '/flow dashboard' literal reservation lives in the
// handler BEFORE parseFlowArgs — these cases pin the branch, its case
// insensitivity, and that 'dashboard <extra>' still falls through to usage.
test('flow handler: dashboard toggles with no content, never sendUserMessage', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('dashboard', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /No flow content to show/)
  })
})

// alt+shift+d must reach the same no-content notify path as the /flow dashboard
// command — parity is delegated to toggleFlowDashboardPin. Pinned-path state
// is covered by the Phase 3 widget toggle unit tests; not duplicated here.
// Note: /hotkeys no-collision for alt+shift+d (checked against Pi built-ins
// and in-repo extensions; alt+d was Pi's tui.editor.deleteWordForward) is a
// manual check that cannot run under node --test.
test('flow shortcut: alt+shift+d toggles dashboard, same no-content path as command', async () => {
  await withHandlerEnv(async () => {
    const { shortcuts } = captureFlowCommand()
    const altShiftD = shortcuts.get('alt+shift+d')
    assert.ok(altShiftD, 'alt+shift+d shortcut was not registered')
    assert.equal(altShiftD.description, 'Toggle the flow dashboard widget')
    const notifications: Array<{ message: string; level: string }> = []
    await altShiftD.handler(flowCtx(notifications))
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /No flow content to show/)
  })
})

test("flow handler: 'dashboard extra' does not toggle, falls through to usage", async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('dashboard extra', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.doesNotMatch(notifications[0].message, /dashboard/i)
    assert.match(notifications[0].message, /Usage: \/flow/)
  })
})

test('flow handler: dashboard toggle is case-insensitive', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler('DASHBOARD', flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /No flow content to show/)
  })
})
