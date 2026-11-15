import assert from 'node:assert/strict'
import {
  chmodSync,
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
}

// AIDEV-NOTE: fake ExtensionAPI via Proxy — captures registerCommand('flow')
// and sendUserMessage; every other registration method is a no-op so the
// full default extension wires without a live Pi session.
function captureFlowCommand(): FlowCallCtx {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const sent: string[] = []
  const base = {
    registerCommand: (
      name: string,
      def: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands.set(name, def)
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
  return { handler: def.handler, sent }
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
