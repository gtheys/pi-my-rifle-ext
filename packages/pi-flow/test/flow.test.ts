import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
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
import { FLOW_USAGE, parseFlowArgs } from '../flow/args.ts'
import { nextPhase, PHASE_LABEL } from '../flow/orchestrate.ts'
import {
  mergeSeedInput,
  resumeSeedFromEvents,
  runInputRecord,
} from '../flow/resume.ts'
import { resolveRepoRoot } from '../herdr/sync.ts'
import flowExtension, { setAvenSessionCwd } from '../index.ts'

// --- FLOW_USAGE ---

test('FLOW_USAGE: the /flow usage surface documents --yolo', () => {
  // PMR-N181 — /flow help must discover the flag: both the trailing form
  // (<ref> --yolo) and the bare picker form (/flow --yolo), personal-only.
  assert.match(FLOW_USAGE, /\[--yolo\]/)
  assert.match(FLOW_USAGE, /\/flow --yolo/)
  assert.match(FLOW_USAGE, /personal mode only/)
})

// --- parseFlowArgs ---

test('parseFlowArgs: aven ref', () => {
  const parsed = parseFlowArgs('PMR-abc123')
  assert.deepEqual(parsed, { kind: 'aven', ref: 'PMR-abc123', yolo: false })
})

test('parseFlowArgs: jira ref normalizes', () => {
  const parsed = parseFlowArgs('dp-71')
  assert.deepEqual(parsed, { kind: 'jira', jiraId: 'DP-71', yolo: false })
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
  assert.deepEqual(parseFlowArgs('helpme'), {
    kind: 'aven',
    ref: 'helpme',
    yolo: false,
  })
  assert.deepEqual(parseFlowArgs('PMR-help'), {
    kind: 'aven',
    ref: 'PMR-help',
    yolo: false,
  })
})

test('parseFlowArgs: <ref> --yolo keeps the ref kind with yolo on', () => {
  assert.deepEqual(parseFlowArgs('PMR-abc123 --yolo'), {
    kind: 'aven',
    ref: 'PMR-abc123',
    yolo: true,
  })
  assert.deepEqual(parseFlowArgs('dp-71 --yolo'), {
    kind: 'jira',
    jiraId: 'DP-71',
    yolo: true,
  })
  assert.deepEqual(parseFlowArgs('aven:DP-71 --yolo'), {
    kind: 'aven',
    ref: 'DP-71',
    yolo: true,
  })
})

test('parseFlowArgs: bare --yolo is the picker, never a ref', () => {
  assert.deepEqual(parseFlowArgs('--yolo'), { kind: 'picker', yolo: true })
})

test('parseFlowArgs: malformed --yolo shapes are help', () => {
  // Flag-first is not a recognized shape.
  assert.equal(parseFlowArgs('--yolo PMR-abc123').kind, 'help')
  // More than one positional plus the flag is still usage.
  assert.equal(parseFlowArgs('a b --yolo').kind, 'help')
  // 'help' stays reserved in every shape.
  assert.equal(parseFlowArgs('help --yolo').kind, 'help')
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

test('nextPhase: personal review-passed -> feedback (wrap-up phase, PMR-81SX)', () => {
  assert.deepEqual(
    nextPhase(['planned', 'active', 'review-passed'], 'personal'),
    {
      kind: 'phase',
      phase: 'feedback',
    },
  )
})

test('nextPhase: work review-passed -> feedback (explicit mode)', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed'], 'work'), {
    kind: 'phase',
    phase: 'feedback',
  })
})

test('nextPhase: done label -> done (idempotent re-run)', () => {
  assert.deepEqual(nextPhase(['planned', 'active', 'review-passed', 'done']), {
    kind: 'done',
  })
  // Idempotency pin: re-running nextPhase on an already-done ticket (either
  // mode) still yields done, not a phase re-run.
  assert.deepEqual(
    nextPhase(['planned', 'active', 'review-passed', 'done'], 'personal'),
    { kind: 'done' },
  )
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
    yolo: false,
  })
  assert.deepEqual(parseFlowArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
    yolo: false,
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

// yolo plan 2.2 + review fix: the JOURNALED seed wins for yolo only while the
// journaled run is NON-TERMINAL (seed.resume present — running/paused). A
// halted/done run is a fresh start: the explicit --yolo flag (or config)
// applies and is never silently overridden by history.
test('run-input yolo: journaled yolo seed wins over the fresh --yolo value while the run is live', () => {
  const liveResume = {
    blockerRetries: 0,
    validateStartedAt: '2026-11-21T00:00:00Z',
  }
  // flag-less resume of a live yolo run stays yolo
  const yoloResume = mergeSeedInput(
    { mode: 'work', gitRoot: '/fresh', workRoots: ['/fresh'], yolo: false },
    {
      resume: liveResume,
      input: {
        mode: 'work',
        gitRoot: '/parked',
        workRoots: ['/parked-w'],
        yolo: true,
      },
    },
  )
  assert.equal(yoloResume.yolo, true)
  assert.deepEqual(runInputRecord(yoloResume), {
    mode: 'work',
    gitRoot: '/parked',
    workRoots: ['/parked-w'],
    yolo: true,
  })

  // --yolo re-invocation of a live non-yolo journaled run does NOT upgrade it
  const nonYoloSeed = mergeSeedInput(
    { mode: 'work', gitRoot: '/fresh', workRoots: ['/fresh'], yolo: true },
    {
      resume: liveResume,
      input: {
        mode: 'work',
        gitRoot: '/parked',
        workRoots: ['/parked-w'],
        yolo: false,
      },
    },
  )
  assert.equal(nonYoloSeed.yolo, false)

  // old journal: seed.input without a yolo field resolves to non-yolo
  const legacySeed = mergeSeedInput(
    { mode: 'work', gitRoot: '/fresh', workRoots: ['/fresh'], yolo: true },
    {
      resume: liveResume,
      input: { mode: 'work', gitRoot: '/parked', workRoots: ['/parked-w'] },
    },
  )
  assert.equal(legacySeed.yolo, false)
})

test('run-input yolo: terminal journal never overrides the fresh flag (review fix)', () => {
  // halted/done run: seed.input WITHOUT a resume block = terminal. The
  // explicit flag/config applies; history does not silently veto it.
  const haltedNonYolo = mergeSeedInput(
    { mode: 'work', gitRoot: '/fresh', workRoots: ['/fresh'], yolo: true },
    {
      input: {
        mode: 'work',
        gitRoot: '/parked',
        workRoots: ['/parked-w'],
        yolo: false,
      },
    },
  )
  assert.equal(haltedNonYolo.yolo, true)

  // terminal yolo journal + flag-less re-invocation starts non-yolo
  const haltedYolo = mergeSeedInput(
    { mode: 'work', gitRoot: '/fresh', workRoots: ['/fresh'], yolo: false },
    {
      input: {
        mode: 'work',
        gitRoot: '/parked',
        workRoots: ['/parked-w'],
        yolo: true,
      },
    },
  )
  assert.equal(haltedYolo.yolo, false)
})
// --- /flow handler dispatch: answer path (PMR-R5VB subtask 1.4) ---

const HANDLER_BIN = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-handler-bin-'))
const HANDLER_LOG = path.join(HANDLER_BIN, 'calls.txt')
const HANDLER_MODE = path.join(HANDLER_BIN, 'mode.txt')
// AIDEV-NOTE: PMR-YG2N 3.1 — `aven show <ref> --full` keeps serving the
// canned metadata line (the answer/spec paths parse it) and appends this
// mode file, so done-path tests can serve a canned worktree note; empty =
// nothing bound (default behavior unchanged for the existing tests).
const HANDLER_WORKTREE = path.join(HANDLER_BIN, 'worktree-note.txt')
// AIDEV-NOTE: PMR-YG2N 3.2 — `aven show <ref> --json` serves this file when
// non-empty so done-path tests can present a full label set; empty = the
// canned text line (default behavior unchanged for the existing tests).
const HANDLER_LABELS = path.join(HANDLER_BIN, 'labels.json')
writeFileSync(HANDLER_MODE, 'ok')
writeFileSync(HANDLER_WORKTREE, '')
writeFileSync(HANDLER_LABELS, '')
writeFileSync(HANDLER_LOG, '')
writeFileSync(
  path.join(HANDLER_BIN, 'aven'),
  `#!/bin/sh
printf '%s ' "$@" >> ${HANDLER_LOG}
echo >> ${HANDLER_LOG}
mode=$(cat ${HANDLER_MODE})
if [ "$1" = "show" ]; then
  is_full=""
  for a in "$@"; do
    if [ "$a" = "--full" ]; then
      is_full=1
    fi
  done
  if [ -n "$is_full" ]; then
    echo "$2 status=todo title=x"
    cat ${HANDLER_WORKTREE}
    exit 0
  fi
  has_json=""
  for a in "$@"; do
    if [ "$a" = "--json" ]; then
      has_json=1
    fi
  done
  if [ -n "$has_json" ] && [ -s ${HANDLER_LABELS} ]; then
    cat ${HANDLER_LABELS}
    exit 0
  fi
  if [ "$mode" = "error" ]; then
    exit 1
  fi
  echo "$2 status=todo title=x"
  exit 0
fi
if [ "$1" = "list" ]; then
  for a in "$@"; do
    if [ "$a" = "--ready" ]; then
      printf '%s' 'YLO_TICKETS_JSON'
      exit 0
    fi
  done
  exit 1
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
// yolo plan 1.2: serve a canned ready-ticket list for `aven list --ready
// --json` so the picker handler tests drive both plain /flow and
// /flow --yolo to a real picked-ref run path.
writeFileSync(
  path.join(HANDLER_BIN, 'aven'),
  readFileSync(path.join(HANDLER_BIN, 'aven'), 'utf8').replace(
    'YLO_TICKETS_JSON',
    JSON.stringify([
      { ref: 'YLO-1', title: 'Yolo ticket one' },
      { ref: 'YLO-2', title: 'Yolo ticket two' },
    ]),
  ),
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

/** Structural shape of the pi.on(event, handler) registrations we capture. */
type CapturedEventHandler = (event: unknown, ctx: unknown) => unknown

// AIDEV-NOTE: PMR-YG2N 4.2 — structural session_start ctx: exactly what the
// session_start handler in index.ts destructures (cwd, ui.notify,
// sessionManager.getSessionFile/getBranch). No branch entries = no binding
// restore, so firing it exercises the background sweep without the parked-run
// consumer.
interface SessionStartTestCtx {
  cwd: string
  ui: { notify: (message: string, level: string) => void }
  sessionManager: {
    getSessionFile: () => string | null
    getBranch: () => Array<{
      type: string
      customType?: string
      data?: unknown
    }>
  }
}

function sessionStartCtx(
  notifications: Array<{ message: string; level: string }>,
): SessionStartTestCtx {
  return {
    cwd: HANDLER_WS,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
    sessionManager: {
      getSessionFile: () => null,
      getBranch: () => [],
    },
  }
}

// AIDEV-NOTE: PMR-YG2N 4.2 — bounded drain; the sweep chain involves
// multiple awaited execs (including real fake-aven subprocess shells), so
// poll until the check passes. AIDEV-NOTE: PMR-EVSR — the original budget
// was 1000 setImmediate turns ("the event loop itself is the clock"), but
// the subprocess spawns only progress in WALL-CLOCK time while the turn
// budget burned through in microseconds under parallel full-suite load —
// the sweep tests then flaked with "drain budget" expirations (observed on
// PMR-SWEEP1 under 3× concurrent workspace runs). Time-bounded instead:
// short sleeps keep yielding to the event loop and the deadline is a
// generous wall-clock 10s; the condition check itself is unchanged.
async function drainUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('drainUntil: condition not met within the 10s drain budget')
}

async function settle(amount: number): Promise<void> {
  for (let i = 0; i < amount; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Structural pi.exec override shape used by the done-path tests (3.2). */
type FlowExec = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>

// AIDEV-NOTE: fake ExtensionAPI via Proxy — captures registerCommand('flow'),
// sendUserMessage, and (PMR-YG2N 4.2, additive) pi.on(event, handler)
// registrations in a Map so tests can fire session_start through the SAME
// handler instance the default extension wired. Every other registration
// method is a no-op so the full default extension wires without a live Pi
// session.
function captureFlowCommand(execOverride?: FlowExec): FlowCallCtx & {
  events: Map<string, CapturedEventHandler[]>
  fireSessionStart: (ctx: SessionStartTestCtx) => void
} {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >()
  const shortcuts = new Map<
    string,
    { description: string; handler: (ctx: unknown) => Promise<void> }
  >()
  const events = new Map<string, CapturedEventHandler[]>()
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
    exec:
      execOverride ?? (async () => ({ stdout: `${HANDLER_WS}\n`, stderr: '' })),
    on: (event: string, handler: CapturedEventHandler) => {
      // AIDEV-NOTE: PMR-YG2N 4.2 — multiple in-repo extensions register the
      // same event (widget/review/telemetry also hook session_start), so
      // keep every handler; the Map must not overwrite earlier ones.
      const existing = events.get(event)
      if (existing === undefined) {
        events.set(event, [handler])
      } else {
        existing.push(handler)
      }
    },
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
  const fireSessionStart = (ctx: SessionStartTestCtx): void => {
    const handlers = events.get('session_start')
    if (handlers === undefined) {
      throw new Error('session_start handler was not registered')
    }
    for (const handler of handlers) {
      // AIDEV-NOTE: PMR-YG2N 4.2 — best-effort fan-out mirrors production:
      // one hook failing (e.g. a non-flow hook wanting richer ctx) must not
      // stop the pi-flow session_start handler under test from running.
      try {
        handler(undefined, ctx)
      } catch {
        // non-flow hooks are out of scope for this capture
      }
    }
  }
  return { handler: def.handler, sent, shortcuts, events, fireSessionStart }
}

function flowCtx(
  notifications: Array<{ message: string; level: string }>,
  select?: (title: string, options: string[]) => Promise<string | undefined>,
): unknown {
  return {
    cwd: HANDLER_WS,
    // hasUI: true so the dashboard toggle tests reach the REAL empty-content
    // exit (collectWidgetData -> shouldShowWidget) instead of short-circuiting
    // on the !hasUI guard; the no-UI guard exit is pinned separately in
    // flow-widget.test.ts.
    hasUI: true,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
      select,
    },
  }
}

/** Pick the menu label whose value/label carries the given ref. */
function pickLabel(options: string[], ref: string): string | undefined {
  return options.find((o) => o.startsWith(ref))
}

test('flow handler: --yolo extra keeps the usage notify, no picker, no aven calls', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    const selects: Array<[string, string[]]> = []
    await handler(
      '--yolo extra',
      flowCtx(notifications, async (title, options) => {
        selects.push([title, options])
        return undefined
      }),
    )
    assert.equal(sent.length, 0)
    assert.equal(selects.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /Usage: \/flow/)
    assert.equal(readFileSync(HANDLER_LOG, 'utf8'), '')
  })
})

test('flow handler: /flow --yolo goes straight to the ready-ticket picker and runs the picked ref', async () => {
  await withHandlerEnv(async () => {
    // mode=error so the run path stops at the fail-closed labels read —
    // proves the picked ref entered the run path without spawning a run.
    writeFileSync(HANDLER_MODE, 'error')
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    const selects: Array<[string, string[]]> = []
    await handler(
      '--yolo',
      flowCtx(notifications, async (title, options) => {
        selects.push([title, options])
        return pickLabel(options, 'YLO-1')
      }),
    )
    writeFileSync(HANDLER_MODE, 'ok')
    assert.equal(sent.length, 0)
    // AIDEV-NOTE (yolo plan 1.2): EXACTLY one select — the gate-answering
    // step is skipped; the yolo shortcut lands directly on the
    // ready-ticket picker.
    assert.equal(selects.length, 1)
    assert.equal(selects[0]?.[0], 'Ready ticket — start a flow:')
    assert.ok(pickLabel(selects[0]?.[1] ?? [], 'YLO-1') !== undefined)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'warning')
    assert.match(notifications[0].message, /cannot read aven labels/)
    const calls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(calls, /show YLO-1/)
    assert.doesNotMatch(calls, /edit YLO-1/)
    assert.doesNotMatch(calls, /note YLO-1/)
  })
})

test('flow handler: /flow --yolo cancel at the ticket select stays silent, no run path', async () => {
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler(
      '--yolo',
      flowCtx(notifications, async () => undefined),
    )
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 0)
    // Gate/list aven calls happen before the select; the run path must not.
    assert.doesNotMatch(readFileSync(HANDLER_LOG, 'utf8'), /show YLO-/)
  })
})

test('flow handler: plain /flow keeps the ready-ticket picker and run path (unchanged)', async () => {
  await withHandlerEnv(async () => {
    writeFileSync(HANDLER_MODE, 'error')
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    const selects: Array<[string, string[]]> = []
    await handler(
      '',
      flowCtx(notifications, async (title, options) => {
        selects.push([title, options])
        return pickLabel(options, 'YLO-2')
      }),
    )
    writeFileSync(HANDLER_MODE, 'ok')
    assert.equal(sent.length, 0)
    assert.equal(selects.length, 1)
    assert.equal(selects[0]?.[0], 'Ready ticket — start a flow:')
    assert.equal(notifications.length, 1)
    assert.match(notifications[0].message, /cannot read aven labels/)
    const calls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(calls, /show YLO-2/)
    assert.doesNotMatch(calls, /edit YLO-2/)
    assert.doesNotMatch(calls, /note YLO-2/)
  })
})

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

// --- /flow handler done path: worktree sweep wiring (PMR-YG2N 3.2) ---

// AIDEV-NOTE: PMR-YG2N 3.2 — routed pi.exec fake for cleanupFlowWorktree,
// shaped like sweep.test.ts's makeSweepHarness: git/herdr argv routing with
// a pass-through fallback, every call appended to `calls` so absence
// assertions (no `herdr worktree remove`) are pure call-log reads.
interface CleanupExecOptions {
  wtPath: string
  wtBranch: string
  dirty: boolean
  calls: string[]
  // PMR-YG2N fix round — what `git rev-parse --show-toplevel` serves (the
  // session repo root the sweep keys on). Defaults to the install root so
  // the pre-existing fixtures keep their old (install-root) pairing.
  sessionRoot?: string
  // Exit code for `git merge-base --is-ancestor` — 1 simulates an unmerged
  // branch (kept-all outcome) for the done-branch notify test.
  mergeBaseCode?: number
}

function makeCleanupExec(options: CleanupExecOptions): FlowExec {
  return async (command, args) => {
    const argv = args.join(' ')
    options.calls.push(`${command} ${argv}`)
    if (command === 'herdr' && argv === 'worktree list') {
      const worktrees = [
        {
          path: options.wtPath,
          branch: options.wtBranch,
          label: 'flow',
          open_workspace_id: 'ws-1',
          is_linked_worktree: true,
        },
      ]
      return {
        code: 0,
        stdout: JSON.stringify({ result: { worktrees } }),
        stderr: '',
      }
    }
    if (command === 'herdr' && argv === 'agent list') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { agents: [] } }),
        stderr: '',
      }
    }
    if (command === 'herdr' && argv.startsWith('worktree remove')) {
      return { code: 0, stdout: 'removed', stderr: '' }
    }
    if (command === 'git' && args[0] === 'status') {
      if (options.dirty) {
        return { code: 0, stdout: ' M dirty.txt\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && argv === 'rev-parse --show-toplevel') {
      let root = options.sessionRoot
      if (root === undefined) {
        root = resolveRepoRoot()
      }
      return { code: 0, stdout: `${root}\n`, stderr: '' }
    }
    if (command === 'git' && args[0] === 'merge-base') {
      let mergeBaseCode = options.mergeBaseCode
      if (mergeBaseCode === undefined) {
        mergeBaseCode = 0
      }
      return { code: mergeBaseCode, stdout: '', stderr: '' }
    }
    if (command === 'git' && argv === 'worktree list --porcelain') {
      return { code: 0, stdout: `worktree ${HANDLER_WS}\n`, stderr: '' }
    }
    if (command === 'git' && argv === 'rev-parse --abbrev-ref HEAD') {
      return { code: 0, stdout: `${options.wtBranch}\n`, stderr: '' }
    }
    if (command === 'git' && argv === 'rev-parse HEAD') {
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function writeDoneLabels(ref: string, labels: string[]): void {
  writeFileSync(HANDLER_LABELS, JSON.stringify({ ref, labels }))
}

function writeWorktreeNote(wtPath: string, wtBranch: string): void {
  writeFileSync(
    HANDLER_WORKTREE,
    `note id=TESTNOTE
body<<EOF
worktree: ${wtPath} branch: ${wtBranch}
EOF
`,
  )
}

function journalPath(agentDir: string, ref: string): string {
  return path.join(agentDir, 'pi-flow', 'runs', `${ref}.journal.jsonl`)
}

// AIDEV-NOTE: PMR-YG2N 3.2 — a harness-completed flow was started by /flow
// at some point, so its journal carries run-start; seed it so the sweep
// marker has a live projection state to fold into (mirrors production).
function seedRunStart(ref: string): void {
  const jp = journalPath(HANDLER_AGENT_DIR, ref)
  mkdirSync(path.dirname(jp), { recursive: true })
  writeFileSync(
    jp,
    `${JSON.stringify({ kind: 'run-start', at: 't', ref, mode: 'personal' })}\n`,
  )
}

// AIDEV-NOTE: PMR-YG2N 4.2 — a swept ref must carry a run-input whose gitRoot
// matches the sweep's session root (resolveRepoRoot(), the same seam index.ts
// wires as sessionGitRoot), so the local filter passes before any aven exec.
function seedRunStartWithInput(ref: string, gitRoot: string): void {
  seedRunStart(ref)
  const jp = journalPath(HANDLER_AGENT_DIR, ref)
  writeFileSync(
    jp,
    readFileSync(jp, 'utf8') +
      `${JSON.stringify({
        kind: 'run-input',
        at: 't',
        ref,
        input: { mode: 'personal', gitRoot, workRoots: [] },
      })}\n`,
  )
}

function countLogLines(log: string, prefix: string): number {
  return log.split('\n').filter((line) => line.startsWith(prefix)).length
}

// --- session_start background sweep wiring (PMR-YG2N 4.2) ---

test('flow handler: session_start sweep removes journaled done ref, marker journaled (PMR-YG2N 4.2)', async () => {
  const ref = 'PMR-SWEEP1'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweep-wt-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/sweep-one')
  seedRunStartWithInput(ref, resolveRepoRoot())
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { fireSessionStart } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/sweep-one',
        dirty: false,
        calls,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    fireSessionStart(sessionStartCtx(notifications))
    await drainUntil(() => {
      const jp = journalPath(HANDLER_AGENT_DIR, ref)
      if (!existsSync(jp)) return false
      return /"kind":"worktree-sweep"/.test(readFileSync(jp, 'utf8'))
    })
    // The sweep's aven execs landed in HANDLER_LOG (presence, not order).
    const avenCalls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(avenCalls, new RegExp(`show ${ref} --json`))
    assert.match(avenCalls, new RegExp(`show ${ref} --full`))
    assert.match(avenCalls, new RegExp(`note ${ref}`))
    // The routed exec actually removed the herdr worktree.
    assert.ok(
      calls.some((call) => call.startsWith('herdr worktree remove')),
      'expected a herdr worktree remove call from the sweep',
    )
    // Sweep-sourced terminal marker so later sweeps skip the ref.
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"kind":"worktree-sweep"/)
    assert.match(journal, /"source":"sweep"/)
    assert.match(journal, /"outcome":"removed"/)
  })
  rmSync(wtDir, { recursive: true, force: true })
})

test('flow handler: concurrent session_start fires exactly one sweep (latch, PMR-YG2N 4.2)', async () => {
  const ref = 'PMR-SWEEP2'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweep2-wt-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/sweep-two')
  seedRunStartWithInput(ref, resolveRepoRoot())
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { fireSessionStart } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/sweep-two',
        dirty: false,
        calls,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    // Both handlers run synchronously up to their first await — the second
    // must hit the in-flight latch and be dropped, not queued.
    const ctx = sessionStartCtx(notifications)
    fireSessionStart(ctx)
    fireSessionStart(ctx)
    await drainUntil(() => {
      const jp = journalPath(HANDLER_AGENT_DIR, ref)
      if (!existsSync(jp)) return false
      return /"kind":"worktree-sweep"/.test(readFileSync(jp, 'utf8'))
    })
    // Let any straggler work settle before counting (still no timers).
    await settle(50)
    // One sweep's worth of aven execs, counted by argv prefix — the sweep's
    // own reads/annotate are distinguishable from session_start's unrelated
    // ensure-labels bootstrap traffic. Call-count, not timing.
    // AIDEV-NOTE: PMR-YG2N 4.2 — one sweep reads labels twice per ref: the
    // per-ref aven workspace resolution (avenArgsWithWorkspace) execs
    // `show <ref> --json` once, then readAvenLabels execs it again. A second
    // (latch-dropped) sweep would add a third --json read plus a second
    // --full read, note, and removal — the exact counts below pin ONE sweep.
    const log = readFileSync(HANDLER_LOG, 'utf8')
    assert.equal(countLogLines(log, `show ${ref} --json`), 2)
    assert.equal(countLogLines(log, `show ${ref} --full`), 1)
    assert.equal(countLogLines(log, `note ${ref} `), 1)
    const removals = calls.filter((call) =>
      call.startsWith('herdr worktree remove'),
    )
    assert.equal(removals.length, 1)
  })
  rmSync(wtDir, { recursive: true, force: true })
})

// AIDEV-NOTE: PMR-YG2N fix round regression — the sweep's sessionGitRoot is
// the SESSION repo root (git rev-parse from ctx.cwd), not the extension
// install root. A ref journaled from a foreign repo must still be swept.
test('session_start sweep keys on the session repo root, not the install root — foreign-root ref is swept (PMR-YG2N fix round)', async () => {
  const ref = 'PMR-SWEEPF'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweepf-wt-'))
  const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'pmr-yg2n-foreign-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/sweep-foreign')
  seedRunStartWithInput(ref, foreignRoot)
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { fireSessionStart } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/sweep-foreign',
        dirty: false,
        calls,
        sessionRoot: foreignRoot,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    fireSessionStart(sessionStartCtx(notifications))
    await drainUntil(() => {
      const jp = journalPath(HANDLER_AGENT_DIR, ref)
      if (!existsSync(jp)) return false
      return /"kind":"worktree-sweep"/.test(readFileSync(jp, 'utf8'))
    })
    // The sweep actually ran: aven execs in HANDLER_LOG, herdr removal in
    // the routed exec, terminal removed marker journaled.
    const avenCalls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(avenCalls, new RegExp(`show ${ref} --json`))
    assert.match(avenCalls, new RegExp(`note ${ref}`))
    assert.ok(
      calls.some((call) => call.startsWith('herdr worktree remove')),
      'expected a herdr worktree remove call from the sweep',
    )
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"source":"sweep"/)
    assert.match(journal, /"outcome":"removed"/)
  })
  rmSync(wtDir, { recursive: true, force: true })
  rmSync(foreignRoot, { recursive: true, force: true })
})

// AIDEV-NOTE: PMR-YG2N fix round regression — a ref journaled with the
// INSTALL root (the old buggy pairing) is foreign from a session whose repo
// is elsewhere, so the sweep must skip it entirely: zero aven execs, no
// marker (the old code wrongly swept it and journaled a terminal noop).
test('session_start sweep keys on the session repo root, not the install root — install-root ref from a foreign session is skipped (PMR-YG2N fix round)', async () => {
  const ref = 'PMR-SWEEPS'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweeps-wt-'))
  const foreignRoot = mkdtempSync(path.join(os.tmpdir(), 'pmr-yg2n-foreign-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/sweep-skipped')
  seedRunStartWithInput(ref, resolveRepoRoot())
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { fireSessionStart } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/sweep-skipped',
        dirty: false,
        calls,
        sessionRoot: foreignRoot,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    fireSessionStart(sessionStartCtx(notifications))
    // Let any (wrong) sweep work settle — no timers, event loop is the clock.
    await settle(200)
    // Unrelated session_start bootstrap traffic (ensure-labels) may exist;
    // what must be absent is the sweep's own traffic: the note read, the
    // annotate, and any herdr removal.
    const log = readFileSync(HANDLER_LOG, 'utf8')
    assert.ok(
      !log.includes(`show ${ref} --full`),
      'foreign-session ref must not be swept (no aven show --full)',
    )
    assert.ok(
      !log.includes(`note ${ref} `),
      'foreign-session ref must not be swept (no aven note)',
    )
    assert.ok(
      !calls.some((call) => call.startsWith('herdr worktree remove')),
      'foreign-session ref must never reach herdr worktree remove',
    )
    const jp = journalPath(HANDLER_AGENT_DIR, ref)
    if (existsSync(jp)) {
      assert.doesNotMatch(readFileSync(jp, 'utf8'), /"kind":"worktree-sweep"/)
    }
  })
  rmSync(wtDir, { recursive: true, force: true })
  rmSync(foreignRoot, { recursive: true, force: true })
})

// AIDEV-NOTE: PMR-YG2N fix round — kept-all is a deliberate KEEP (unmerged
// worktree left in place), not a deferral; the done-branch notify must not
// label it 'deferred'.
test('flow handler: done + unmerged worktree notifies kept, not deferred (PMR-YG2N fix round)', async () => {
  const ref = 'PMR-KEPT1'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-kept-wt-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/kept-one')
  seedRunStart(ref)
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/kept-one',
        dirty: false,
        calls,
        mergeBaseCode: 1,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /Worktree cleanup: kept \(/)
    assert.doesNotMatch(notifications[0].message, /Worktree cleanup: deferred/)
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"outcome":"kept-all"/)
  })
  rmSync(wtDir, { recursive: true, force: true })
})

test('flow handler: done + note-bound worktree is swept to removed (PMR-YG2N 3.2)', async () => {
  const ref = 'PMR-DONE1'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-done-wt-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/done-one')
  seedRunStart(ref)
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/done-one',
        dirty: false,
        calls,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /all phase labels present \(done\)/)
    assert.match(notifications[0].message, /Worktree cleanup: removed/)
    // The cleanup annotates the outcome via `aven note <ref>` (HANDLER_LOG).
    const avenCalls = readFileSync(HANDLER_LOG, 'utf8')
    assert.match(avenCalls, new RegExp(`note ${ref}`))
    // Journal marker with the terminal outcome so later sweeps skip the ref.
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"kind":"worktree-sweep"/)
    assert.match(journal, /"outcome":"removed"/)
    // The routed exec actually removed the herdr worktree.
    assert.ok(
      calls.some((call) => call.startsWith('herdr worktree remove')),
      'expected a herdr worktree remove call',
    )
  })
  rmSync(wtDir, { recursive: true, force: true })
})

test('flow handler: done + no worktree note ends in noop marker (PMR-YG2N 3.2)', async () => {
  const ref = 'PMR-DONE2'
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeFileSync(HANDLER_WORKTREE, '')
  seedRunStart(ref)
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /nothing to run/)
    assert.match(
      notifications[0].message,
      /Worktree cleanup: no flow worktree bound/,
    )
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"kind":"worktree-sweep"/)
    assert.match(journal, /"outcome":"noop"/)
  })
})

test('flow handler: done + note-bound dirty worktree is deferred, never removed (PMR-YG2N 3.2)', async () => {
  const ref = 'PMR-DONE3'
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-dirty-wt-'))
  writeDoneLabels(ref, ['planned', 'active', 'review-passed', 'done'])
  writeWorktreeNote(wtDir, 'feat/done-three')
  seedRunStart(ref)
  const calls: string[] = []
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand(
      makeCleanupExec({
        wtPath: wtDir,
        wtBranch: 'feat/done-three',
        dirty: true,
        calls,
      }),
    )
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    assert.equal(sent.length, 0)
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].level, 'info')
    assert.match(notifications[0].message, /Worktree cleanup: deferred/)
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.match(journal, /"kind":"worktree-sweep"/)
    assert.match(journal, /"outcome":"deferred"/)
    assert.ok(
      !calls.some((call) => call.startsWith('herdr worktree remove')),
      'dirty worktree must never reach herdr worktree remove',
    )
  })
  rmSync(wtDir, { recursive: true, force: true })
})

test('flow handler: not-done ticket still takes the run path, no sweep marker (PMR-YG2N 3.2 regression)', async () => {
  const ref = 'PMR-NOTDONE'
  writeDoneLabels(ref, ['planned'])
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    // Run path: the plan phase prompt goes through sendUserMessage.
    assert.ok(sent.length > 0, 'expected sendUserMessage on the run path')
    assert.match(sent[0], new RegExp(ref))
    const journal = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8')
    assert.doesNotMatch(journal, /"kind":"worktree-sweep"/)
    assert.match(journal, /"kind":"run-start"/)
  })
})

// AIDEV-NOTE: PMR-T9ZQ 1.2 — /flow start journals the owner identity
// (owner-session) immediately after run-start, with the closure's
// mainSessionFile (null until a session_start supplies one) and process.pid.
// The run-state projection is read back too: owner-session is a PROJECTED
// event kind, so a write that only reached the journal (the journal-only
// main-session route) would fail this pin.
function journalEvents(ref: string): Record<string, unknown>[] {
  const lines = readFileSync(journalPath(HANDLER_AGENT_DIR, ref), 'utf8').split(
    '\n',
  )
  const events: Record<string, unknown>[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    events.push(JSON.parse(trimmed) as Record<string, unknown>)
  }
  return events
}

function ownerSessionEvents(
  events: Record<string, unknown>[],
): Record<string, unknown>[] {
  return events.filter((event) => event.kind === 'owner-session')
}

test('flow handler: /flow start journals owner-session right after run-start (PMR-T9ZQ 1.2)', async () => {
  const ref = 'PMR-OWNERSTART'
  writeDoneLabels(ref, ['planned'])
  await withHandlerEnv(async () => {
    const { handler, sent } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    await handler(ref, flowCtx(notifications))
    assert.ok(sent.length > 0, 'expected sendUserMessage on the run path')
    const events = journalEvents(ref)
    const kinds = events.map((event) => String(event.kind))
    const owners = ownerSessionEvents(events)
    assert.ok(
      owners.length >= 1,
      `expected an owner-session event, got kinds: ${String(kinds)}`,
    )
    const first = owners[0]
    if (first === undefined) return
    assert.equal(first.ref, ref)
    assert.equal(first.pid, process.pid)
    // No session_start fired in this harness → the closure has no main
    // session file yet, and a nullable sessionFile is exactly the contract.
    assert.equal(first.sessionFile, null)
    const runStart = kinds.indexOf('run-start')
    const firstOwner = kinds.indexOf('owner-session')
    assert.equal(
      firstOwner,
      runStart + 1,
      'owner-session lands immediately after run-start',
    )
    // Projected: the run-state file carries the owner record.
    const statePath = path.join(
      HANDLER_AGENT_DIR,
      'pi-flow',
      'runs',
      `${ref}.json`,
    )
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    const owner = state.owner as Record<string, unknown> | undefined
    assert.equal(owner?.pid, process.pid)
    assert.equal(owner?.sessionFile, null)
  })
})

test('flow handler: owner-session carries the session_start main session file (PMR-T9ZQ 1.2)', async () => {
  const ref = 'PMR-OWNERFILE'
  const sessionFile = '/s/2026-11-22T07-00-00-000Z_cccccccc-dddd.jsonl'
  writeDoneLabels(ref, ['planned'])
  await withHandlerEnv(async () => {
    const { handler, sent, fireSessionStart } = captureFlowCommand()
    const notifications: Array<{ message: string; level: string }> = []
    // session_start supplies mainSessionFile synchronously; the /flow start
    // write site must pick up the closure's current value.
    fireSessionStart({
      cwd: HANDLER_WS,
      ui: {
        notify: (message: string, level: string) =>
          notifications.push({ message, level }),
      },
      sessionManager: {
        getSessionFile: () => sessionFile,
        getBranch: () => [],
      },
    })
    await handler(ref, flowCtx(notifications))
    assert.ok(sent.length > 0, 'expected sendUserMessage on the run path')
    const owners = ownerSessionEvents(journalEvents(ref))
    assert.equal(owners.length >= 1, true, 'expected an owner-session event')
    const first = owners[0]
    if (first === undefined) return
    assert.equal(first.sessionFile, sessionFile)
    assert.equal(first.pid, process.pid)
  })
})
