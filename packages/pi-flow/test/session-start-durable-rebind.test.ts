// AIDEV-NOTE: PMR-DRKH — session_start durable rebind tests. The derive/heal
// IO is injected through the DurableRebindDeps seam on the extension factory,
// mirroring how consumer deps are stubbed in flow.test.ts.
// AIDEV-NOTE: PMR-T9ZQ 3.1 — the OLD automatic-takeover pins (single
// candidate auto-binds + heals; multiple → notify-only warning) are
// INTENTIONALLY rewritten: cross-session resume is now consent-gated by the
// picker. Two harness upgrades carry that contract:
//   1. the fake ctx carries `hasUI` + a DEFERRED async `ui.select` (a
//      SelectGate) — the handler stalls on the answer, which is exactly how
//      "nothing is bound/healed/consumed/injected before consent" is pinned;
//   2. the consumer runs for real against the temp PI_CODING_AGENT_DIR, so
//      each test seeds a genuine pending record + parked journal. That pins
//      "resume consumes exactly once" AND "a declined session never renames
//      the pending record" (the gate strictly precedes consumePending).
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { recoveryCommand } from '../flow/binding-heal.ts'
import type { ParkedCandidate } from '../flow/durable-refs.ts'
import {
  getActiveFlowRef,
  getFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import flowExtension, { type DurableRebindDeps } from '../index.ts'
import { PENDING_SCHEMA } from '../server/pending.ts'

const NONE_LABEL = 'None — leave this session clean'

interface Notify {
  message: string
  level: string
}

interface SelectCall {
  title: string
  options: string[]
}

type BranchEntry = {
  type: string
  customType?: string
  data?: unknown
}

type CapturedEventHandler = (event: unknown, ctx: unknown) => unknown

// A deferred ctx.ui.select: every call is recorded and stays unresolved
// until the test answers (or rejects) it, so assertions made between
// "select was shown" and "answer was given" observe the ungated state.
interface SelectGate {
  calls: SelectCall[]
  select: (title: string, options: string[]) => Promise<string | undefined>
  answer: (value: string | undefined) => void
  reject: (err: Error) => void
}

function selectGate(): SelectGate {
  const calls: SelectCall[] = []
  const pending: Array<{
    resolve: (value: string | undefined) => void
    reject: (err: Error) => void
  }> = []
  return {
    calls,
    select: (title, options) => {
      calls.push({ title, options })
      return new Promise<string | undefined>((resolve, rejectFn) => {
        pending.push({ resolve, reject: rejectFn })
      })
    },
    answer: (value) => {
      const slot = pending.shift()
      if (slot === undefined) {
        throw new Error('selectGate.answer: no pending select call')
      }
      slot.resolve(value)
    },
    reject: (err) => {
      const slot = pending.shift()
      if (slot === undefined) {
        throw new Error('selectGate.reject: no pending select call')
      }
      slot.reject(err)
    },
  }
}

interface Harness {
  sent: string[]
  fireSessionStart: (ctx: unknown) => void
  /** Fires the agent_settled handlers (boundRef !== null path must stay
   * today's behavior — the consumer latch is pinned through this). */
  fireAgentSettled: (ctx: unknown) => void
}

function captureExtension(durable: DurableRebindDeps): Harness {
  const events = new Map<string, CapturedEventHandler[]>()
  const sent: string[] = []
  const base = {
    registerCommand: () => {},
    registerShortcut: () => {},
    registerTool: () => {},
    sendUserMessage: (message: string) => {
      sent.push(message)
    },
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    on: (event: string, handler: CapturedEventHandler) => {
      const existing = events.get(event)
      if (existing === undefined) {
        events.set(event, [handler])
      } else {
        existing.push(handler)
      }
    },
    appendEntry: () => {},
  }
  const pi = new Proxy(base, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof typeof target]
      }
      return () => {}
    },
  }) as unknown as ExtensionAPI
  flowExtension(pi, durable)
  const handlers = events.get('session_start')
  if (handlers === undefined) {
    throw new Error('session_start handler was not registered')
  }
  const settleHandlers = events.get('agent_settled') ?? []
  const fanOut = (list: CapturedEventHandler[], ctx: unknown): void => {
    for (const handler of list) {
      try {
        handler(undefined, ctx)
      } catch {
        // best-effort fan-out, mirrors production capture in flow.test.ts
      }
    }
  }
  return {
    sent,
    fireSessionStart: (ctx) => {
      fanOut(handlers, ctx)
    },
    fireAgentSettled: (ctx) => {
      fanOut(settleHandlers, ctx)
    },
  }
}

async function drainUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('drainUntil: condition not met within the 5s drain budget')
}

async function settleMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function sessionStartCtx(
  cwd: string,
  notifications: Notify[],
  gate: SelectGate,
  opts: { hasUI: boolean; branch?: BranchEntry[] },
): unknown {
  return {
    cwd,
    hasUI: opts.hasUI,
    ui: {
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
      select: gate.select,
    },
    sessionManager: {
      getSessionFile: () => null,
      getBranch: () => opts.branch ?? [],
    },
  }
}

// AIDEV-NOTE: only rebind/resume-path notifications are in scope here — the
// other session_start hooks (ensureLabels, sweep, widget, telemetry)
// legitimately notify in aven-less/CI environments, and that noise is not
// this feature's output. Every pi-flow resume message names a flow command or
// the binding, so this filter is exact for the assertions below.
function rebindNotifications(notifications: Notify[]): Notify[] {
  return notifications.filter((n) => {
    return (
      n.message.includes('flow binding') ||
      n.message.includes('resume declined') ||
      n.message.includes('recover with') ||
      n.message.includes('resumed parked run') ||
      n.message.includes('/flow ')
    )
  })
}

function parkedCandidate(
  ref: string,
  overrides?: Partial<ParkedCandidate>,
): ParkedCandidate {
  const base: ParkedCandidate = {
    ref,
    phase: 'implement',
    status: 'running',
    updatedAt: '2026-11-20T11:55:00.000Z',
    hasWorktree: true,
  }
  if (overrides === undefined) {
    return base
  }
  return { ...base, ...overrides }
}

function healOk(ref: string) {
  return {
    ok: true as const,
    worktree: {
      ref,
      path: `/tmp/wt-${ref}`,
      branch: `flow/${ref}`,
      source: 'note' as const,
    },
    healed: true,
  }
}

// Fail-fast accessors: the tests below always run after a drainUntil the
// call/message exists, so a miss is a harness bug, not a soft assertion.
function selectOption(gate: SelectGate, index: number): string {
  const call = gate.calls[0]
  if (call === undefined) {
    throw new Error('selectOption: no select call was recorded')
  }
  const option = call.options[index]
  if (option === undefined) {
    throw new Error(`selectOption: no option at index ${index}`)
  }
  return option
}

function firstRebind(notifications: Notify[]): Notify {
  const found = rebindNotifications(notifications)[0]
  if (found === undefined) {
    throw new Error('firstRebind: no rebind notification yet')
  }
  return found
}

function firstRebindWarning(notifications: Notify[]): Notify {
  const found = rebindNotifications(notifications).find((n) => {
    return n.level === 'warning'
  })
  if (found === undefined) {
    throw new Error('firstRebindWarning: no warning notification yet')
  }
  return found
}

// AIDEV-NOTE: production consumer seeding — resumeParkedRun runs against the
// REAL fs (PI_CODING_AGENT_DIR points at the temp agent dir), so a
// consumed-once / never-consumed-on-decline pin needs a genuine pending
// record plus a journal whose latest loop-state is parked (isStillParked's
// verify closure), exactly like run-server-reinject.integration.test.ts.
function seedParkedRun(agentDir: string, ref: string): void {
  const runsDir = join(agentDir, 'pi-flow', 'runs')
  const pendingDir = join(agentDir, 'pi-flow', 'pending')
  mkdirSync(runsDir, { recursive: true })
  mkdirSync(pendingDir, { recursive: true })
  const journal = [
    {
      kind: 'run-start',
      at: '2026-11-20T11:54:00.000Z',
      ref,
      mode: 'work',
    },
    {
      kind: 'loop-state',
      at: '2026-11-20T11:55:00.000Z',
      ref,
      loop: {
        phase: 'implement',
        awaitingOutcome: true,
        blockerRetries: 0,
        validateStartedAt: '2026-11-20T11:55:00.000Z',
        status: 'running',
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')
  writeFileSync(join(runsDir, `${ref}.journal.jsonl`), `${journal}\n`)
  const record = {
    schema: PENDING_SCHEMA,
    ref,
    phase: 'implement',
    createdAt: '2026-11-20T11:55:00.000Z',
    sourceAt: '2026-11-20T11:55:00.000Z',
  }
  writeFileSync(join(pendingDir, `${ref}.json`), `${JSON.stringify(record)}\n`)
}

function pendingFile(agentDir: string, ref: string): string {
  return join(agentDir, 'pi-flow', 'pending', `${ref}.json`)
}

function consumedFile(agentDir: string, ref: string): string {
  return join(agentDir, 'pi-flow', 'pending', `${ref}.consumed.json`)
}

function noHeal(): DurableRebindDeps['heal'] {
  return async () => {
    throw new Error('heal must not run before a resume is consented')
  }
}

describe('session_start durable rebind (PMR-DRKH + PMR-T9ZQ picker gate)', () => {
  let root: string
  let agentDir: string
  let previousAgentDir: string | undefined

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-flow-rebind-'))
    agentDir = join(root, 'agent')
    mkdirSync(agentDir, { recursive: true })
    previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
  })

  after(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('zero candidates: silent — no select, no notify, no binding, heal never called', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [],
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    assert.deepEqual(gate.calls, [])
    assert.deepEqual(rebindNotifications(notifications), [])
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
  })

  it('a throwing candidate scan stays silent and clean (no prompt, no binding)', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => {
        throw new Error('pending dir unreadable')
      },
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    assert.deepEqual(gate.calls, [])
    assert.deepEqual(rebindNotifications(notifications), [])
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
  })

  it('(a) one candidate + UI: consent menu with ref/phase/status/age + owner hint, NOTHING bound/healed/injected before the answer', async () => {
    setActiveFlowRef(null)
    let healCalls = 0
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [
        parkedCandidate('PMR-AAAA', {
          owner: {
            sessionFile: '/tmp/owner.jsonl',
            pid: process.pid,
            at: '2026-11-20T11:56:00.000Z',
          },
        }),
      ],
      heal: async () => {
        healCalls += 1
        return healOk('PMR-AAAA')
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    // stalled on the answer: zero side effects is the whole point of the gate
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    assert.deepEqual(rebindNotifications(notifications), [])
    assert.equal(gate.calls[0]?.options.length, 2)
    const row = selectOption(gate, 0)
    const noneRow = selectOption(gate, 1)
    assert.match(row, /^Resume PMR-AAAA — implement, running, updated /)
    assert.ok(
      row.includes('owner session appears alive'),
      `expected an owner-liveness hint, got: ${row}`,
    )
    assert.equal(noneRow, NONE_LABEL)
    gate.answer(noneRow)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
  })

  it('(b) resume-on-yes arms in order: bind → heal(hasWorktree) → config sync → consume pending once + send /flow', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-CCCC'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    const order: string[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [parkedCandidate(ref)],
      heal: async (healRef) => {
        // pinned: the binding is restored BEFORE the heal runs, and the
        // pending record is still untouched (heal strictly precedes
        // consumePending's rename)
        order.push(
          `heal:${healRef}:active=${getActiveFlowRef()}:pending=${existsSync(pendingFile(agentDir, ref))}`,
        )
        setActiveFlowRef(healRef)
        setFlowWorktree('/tmp/wt-cccc', `flow/${healRef}`)
        return healOk(healRef)
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(selectOption(gate, 0))
    await drainUntil(() => harness.sent.length > 0)
    assert.deepEqual(order, [`heal:${ref}:active=${ref}:pending=true`])
    assert.equal(getActiveFlowRef(), ref)
    const binding = getFlowWorktree()
    assert.notEqual(binding, null)
    assert.equal(binding?.ref, ref)
    assert.deepEqual(harness.sent, [`/flow ${ref}`])
    assert.equal(existsSync(pendingFile(agentDir, ref)), false)
    assert.equal(existsSync(consumedFile(agentDir, ref)), true)
    const messages = rebindNotifications(notifications).map((n) => n.message)
    const text = messages.join('\n')
    assert.ok(text.includes('restored flow binding'), text)
    assert.ok(text.includes('resumed parked run'), text)
    assert.equal(recoveryCommand(ref), `/flow ${ref}`)
    // latch pin: the armed ref is latched, so even a freshly re-parked
    // record (a daemon re-write) is not re-consumed in this process.
    seedParkedRun(agentDir, ref)
    const before = harness.sent.length
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, selectGate(), { hasUI: true }),
    )
    await settleMs(150)
    assert.equal(harness.sent.length, before, 'resume latch blocks re-entry')
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
  })

  // The arm sequence's config sync is observable through the consumer's kill
  // switch: with runServer.enabled false in the SESSION project config, the
  // armed ref must restore + heal but never consume/inject — which only
  // holds if the sync really ran before resumeParkedRun (JKD6RFC0MYY3N29C).
  it('resume-on-yes syncs the runServer kill switch before the consumer runs', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-KILL'
    const ws = mkdtempSync(join(root, 'killswitch-'))
    mkdirSync(join(ws, '.pi', 'pi-flow'), { recursive: true })
    writeFileSync(
      join(ws, '.pi', 'pi-flow', 'config.json'),
      JSON.stringify({ workRoots: [], runServer: { enabled: false } }),
    )
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => [parkedCandidate(ref)],
      heal: async () => {
        healCalls += 1
        return healOk(ref)
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(ws, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(selectOption(gate, 0))
    await drainUntil(() => healCalls > 0)
    await settleMs(150)
    assert.equal(getActiveFlowRef(), ref)
    assert.deepEqual(harness.sent, [], 'disabled consumer never runs')
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
  })

  it('(c) decline via the None row: one info line, clean session, pending record NEVER consumed', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-D1'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => [parkedCandidate(ref)],
      heal: async () => {
        healCalls += 1
        return healOk(ref)
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    // gate ordering: a declined session never renames the pending record
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
    assert.equal(existsSync(consumedFile(agentDir, ref)), false)
    assert.equal(rebindNotifications(notifications).length, 1)
    const line = firstRebind(notifications)
    assert.equal(line.level, 'info')
    assert.ok(line.message.includes(`/flow ${ref}`), line.message)
  })

  it('(c) Esc/cancel declines the same way, listing every candidate', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [
        parkedCandidate('PMR-ESC1'),
        parkedCandidate('PMR-ESC2'),
      ],
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    assert.equal(gate.calls[0]?.options.length, 3)
    gate.answer(undefined)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    const line = firstRebind(notifications)
    assert.equal(line.level, 'info')
    assert.ok(line.message.includes('/flow PMR-ESC1'), line.message)
    assert.ok(line.message.includes('/flow PMR-ESC2'), line.message)
  })

  it('(c) headless startup: never prompts, never binds — notify-only fallback lines per candidate', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [
        parkedCandidate('PMR-H1'),
        parkedCandidate('PMR-H2', { hasWorktree: false }),
      ],
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: false }),
    )
    await drainUntil(() => rebindNotifications(notifications).length >= 2)
    assert.deepEqual(gate.calls, [], 'no select without UI')
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    const text = rebindNotifications(notifications)
      .map((n) => n.message)
      .join('\n')
    assert.ok(text.includes('recover with /flow PMR-H1'), text)
    assert.ok(text.includes('recover with /flow PMR-H2'), text)
  })

  it('(c) a throwing select fails CLOSED: recovery lines only, session stays clean', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => [parkedCandidate('PMR-THROW')],
      heal: async () => {
        healCalls += 1
        return healOk('PMR-THROW')
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.reject(new Error('no dialog implementation in this mode'))
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    const text = rebindNotifications(notifications)
      .map((n) => n.message)
      .join('\n')
    assert.ok(text.includes('recover with /flow PMR-THROW'), text)
  })

  it('(d) own-session (PMR-PJM0) restore: binds + auto-resumes with NO select call', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-SELF'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let deriveCalls = 0
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => {
        deriveCalls += 1
        return [parkedCandidate(ref)]
      },
      heal: async () => {
        healCalls += 1
        return healOk(ref)
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, {
        hasUI: true,
        branch: [
          {
            type: 'custom',
            customType: 'pi-flow-binding',
            data: { ref, worktree: null },
          },
        ],
      }),
    )
    await drainUntil(() => harness.sent.length > 0)
    assert.equal(
      deriveCalls,
      0,
      'the own-session path never derives candidates',
    )
    assert.equal(healCalls, 0, 'the own-session path never heals')
    assert.deepEqual(gate.calls, [], 'the own-session path never prompts')
    assert.equal(getActiveFlowRef(), ref)
    assert.deepEqual(harness.sent, [`/flow ${ref}`])
    const text = rebindNotifications(notifications)
      .map((n) => n.message)
      .join('\n')
    assert.ok(text.includes('restored flow binding'), text)
    assert.ok(!text.includes('heal'), text)
  })

  it('(e) hasWorktree=false + consent: heal never runs and no heal-warning text appears', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-NOHEAL'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => [
        parkedCandidate(ref, { hasWorktree: false }),
      ],
      heal: async () => {
        healCalls += 1
        return { ok: false, reason: 'must not run', recovery: '/flow x' }
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(selectOption(gate, 0))
    await drainUntil(() => harness.sent.length > 0)
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), ref)
    const text = rebindNotifications(notifications)
      .map((n) => n.message)
      .join('\n')
    assert.ok(text.includes('restored flow binding'), text)
    assert.ok(!text.includes('heal'), text)
  })

  // AIDEV-NOTE: PMR-T9ZQ 3.2 — the agent_settled belt-and-braces gate. The
  // shared ask latch is module-level, so every settle test first fires a
  // ZERO-candidate session_start: the PMR-DRKH else-branch re-arms the latch
  // to 'idle' (the accepted same-process restart case) and a silent plan
  // leaves it there. The late candidate then appears only at settle time —
  // exactly the daemon-parked-it-moments-later incident shape.
  it('(f) settle with a late candidate prompts exactly once across two settles', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    const harness = captureExtension({
      deriveCandidates: async () => candidates,
      heal: noHeal(),
    })
    // startup: nothing parked yet -> silent, latch stays 'idle'
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    assert.deepEqual(gate.calls, [])
    // the daemon parks the run mid-session: the FIRST settle asks
    candidates = [parkedCandidate('PMR-LATE')]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    // the SECOND settle must not re-ask (latch 'done')
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(200)
    assert.equal(gate.calls.length, 1)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    assert.equal(rebindNotifications(notifications).length, 1)
  })

  it('(f) settle resume-with-consent arms the run: bind + heal + consume + send /flow', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-SETTLE'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    let healCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => candidates,
      heal: async (healRef) => {
        healCalls += 1
        setFlowWorktree(`/tmp/wt-${healRef}`, `flow/${healRef}`)
        return healOk(healRef)
      },
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    assert.equal(healCalls, 0)
    candidates = [parkedCandidate(ref)]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    // stalled on the answer: the settle path bound/healed/injected nothing
    assert.equal(healCalls, 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    gate.answer(selectOption(gate, 0))
    await drainUntil(() => harness.sent.length > 0)
    assert.equal(healCalls, 1, 'the consented settle arm heals a worktree run')
    assert.equal(getActiveFlowRef(), ref)
    assert.deepEqual(harness.sent, [`/flow ${ref}`])
    assert.equal(existsSync(pendingFile(agentDir, ref)), false)
    assert.equal(existsSync(consumedFile(agentDir, ref)), true)
    const text = rebindNotifications(notifications)
      .map((n) => n.message)
      .join('\n')
    assert.ok(text.includes('restored flow binding'), text)
    assert.ok(text.includes('resumed parked run'), text)
  })

  it('(f) settle decline leaves the pending record unconsumed and sends nothing', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-SETDEC'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    const harness = captureExtension({
      deriveCandidates: async () => candidates,
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    candidates = [parkedCandidate(ref)]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    // gate precedes consumePending: the record is untouched
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
    assert.equal(existsSync(consumedFile(agentDir, ref)), false)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
  })

  it('(f) no double-prompt when a settle fires while the startup picker is open', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-OPEN'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let deriveCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => {
        deriveCalls += 1
        return [parkedCandidate(ref)]
      },
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    assert.equal(deriveCalls, 1, 'the startup scan ran once')
    // latch is 'asking' here: the settle path must not stack a second menu,
    // and must not even re-scan (the latch is the sync gate)
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(200)
    assert.equal(gate.calls.length, 1)
    assert.equal(deriveCalls, 1, 'a settle during an open ask scans nothing')
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
    // and the completed ask stays spent for later settles
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(150)
    assert.equal(gate.calls.length, 1)
    assert.equal(deriveCalls, 1)
  })

  it('(f) a headless settle never asks: notify-only fallback, once per process', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-HEADSET'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    const harness = captureExtension({
      deriveCandidates: async () => candidates,
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    candidates = [parkedCandidate(ref)]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: false }),
    )
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.deepEqual(gate.calls, [], 'no select without UI')
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
    // the fallback counts as the once-per-process ask: a second settle must
    // not re-print the recovery lines
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: false }),
    )
    await settleMs(150)
    assert.equal(rebindNotifications(notifications).length, 1)
  })

  it('(f) a session already driving a flow is never prompted on settle', async () => {
    // A /flow started IN this session sets the live binding but not boundRef
    // (which only tracks the session_start restore), and a halted run keeps
    // its binding + parked record. Without the live-binding check the
    // belt-and-braces gate would offer a session its OWN run (and adopting it
    // would drop the worktree binding back to null). The latch is armed here
    // through a zero-candidate session_start, so this pins the live-binding
    // check itself rather than a leftover 'done'.
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    let deriveCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => {
        deriveCalls += 1
        return candidates
      },
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    assert.equal(deriveCalls, 1, 'the startup scan ran once')
    // the session starts its own run: live binding set, boundRef still null
    setActiveFlowRef('PMR-DRIVING')
    setFlowWorktree('/tmp/wt-driving', 'flow/PMR-DRIVING')
    candidates = [parkedCandidate('PMR-DRIVING')]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(200)
    assert.equal(deriveCalls, 1, 'a bound session never scans for candidates')
    assert.deepEqual(gate.calls, [])
    assert.deepEqual(harness.sent, [])
    assert.deepEqual(rebindNotifications(notifications), [])
    assert.equal(getFlowWorktree()?.path, '/tmp/wt-driving')
    setActiveFlowRef(null)
  })

  it('(f) a settle whose scan outlives the startup ask never prompts twice', async () => {
    // The latch is checked synchronously at the settle door, but the scan is
    // async: this drives the window where the startup ask opens AND finishes
    // while the settle's scan is still running. Without the post-scan
    // re-check the settle would spend a second ask (askResumeThenArm only
    // guards 'asking', never 'done').
    setActiveFlowRef(null)
    const ref = 'PMR-RACE'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    let deriveCalls = 0
    const harness = captureExtension({
      deriveCandidates: async () => {
        deriveCalls += 1
        if (deriveCalls === 1) {
          return [parkedCandidate(ref)]
        }
        await settleMs(250)
        return [parkedCandidate(ref)]
      },
      heal: noHeal(),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    // same tick: the startup scan is still in flight, so the settle passes
    // the door check and starts its own (slow) scan
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    // the slow settle scan lands after the startup ask completed
    await settleMs(400)
    assert.equal(deriveCalls, 2, 'both scans ran')
    assert.equal(gate.calls.length, 1, 'exactly one menu in the process')
    assert.equal(getActiveFlowRef(), null)
    assert.deepEqual(harness.sent, [])
    assert.equal(existsSync(pendingFile(agentDir, ref)), true)
    assert.equal(rebindNotifications(notifications).length, 1)
  })

  it('(f) zero-candidate settles do not consume the once-per-process ask', async () => {
    setActiveFlowRef(null)
    const gate = selectGate()
    const notifications: Notify[] = []
    let candidates: ParkedCandidate[] = []
    const harness = captureExtension({
      deriveCandidates: async () => candidates,
      heal: noHeal(),
    })
    // A settle with NOTHING parked stays silent and must NOT spend the
    // once-per-process ask: the latch only flips around a real menu, so a
    // candidate that parks later still gets its prompt (this is the whole
    // point of the belt-and-braces path).
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(100)
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await settleMs(150)
    assert.deepEqual(gate.calls, [])
    candidates = [parkedCandidate('PMR-AFTER')]
    harness.fireAgentSettled(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(NONE_LABEL)
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(getActiveFlowRef(), null)
  })

  it('(e) a heal failure AFTER consent still warns with the reason and the recovery command', async () => {
    setActiveFlowRef(null)
    const ref = 'PMR-HEALFAIL'
    seedParkedRun(agentDir, ref)
    const gate = selectGate()
    const notifications: Notify[] = []
    const harness = captureExtension({
      deriveCandidates: async () => [parkedCandidate(ref)],
      heal: async () => ({
        ok: false,
        reason: 'worktree gone',
        recovery: `/flow ${ref}`,
      }),
    })
    harness.fireSessionStart(
      sessionStartCtx(root, notifications, gate, { hasUI: true }),
    )
    await drainUntil(() => gate.calls.length > 0)
    gate.answer(selectOption(gate, 0))
    await drainUntil(() => rebindNotifications(notifications).length > 0)
    assert.equal(getActiveFlowRef(), ref)
    const warned = firstRebindWarning(notifications)
    assert.ok(warned.message.includes('worktree gone'), warned.message)
    assert.ok(warned.message.includes(`/flow ${ref}`), warned.message)
  })
})
