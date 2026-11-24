// AIDEV-NOTE (PMR-MSDJ 2.3): tests for flow/reconcile-command.ts — the manual
// `/flow-reconcile-push` surface. The semantics table pinned here (plan
// PMR-V36Y 2.3 + orchestrator decision 2026-11-24, option B):
//
//   | mode     | PI_FLOW_PUSHGATEWAY_URL | behaviour                                  |
//   |----------|-------------------------|--------------------------------------------|
//   | real run | unset                   | ERROR text, zero journal/aven/gateway io   |
//   | real run | set                     | runReconcilePass(deps, {dryRun: false})    |
//   | dry-run  | set                     | runReconcilePass(deps, {dryRun: true})     |
//   | dry-run  | unset                   | gateway-less candidate scan, zero pushes   |
//
// aven failure behaves identically in both dry-run flavors: exactly one
// warning notify (the engine's own fail-closed warning, routed through the
// command's warn sink the way `index.ts` wires it) plus a report banner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { GroupBodyResult } from '../flow/push.ts'
import {
  type ReconcileDeps,
  type ReconcileReport,
  runReconcilePass,
} from '../flow/reconcile.ts'
import {
  formatReconcileReport,
  parseReconcileArgs,
  type ReconcileCommandDeps,
  registerReconcileCommand,
  runReconcileCommand,
} from '../flow/reconcile-command.ts'
import type { FlowRunEvent, LoopRunStatus } from '../run-state.ts'

const REF_A = 'PMR-AAAA'
const REF_B = 'PMR-BBBB'
const TRACK_A = 'DP-236'
const TRACK_B = 'DP-300'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function haltedEvents(ref: string, trackRef: string): FlowRunEvent[] {
  const at = '2026-11-24T06:00:00.000Z'
  const start: FlowRunEvent = {
    kind: 'run-start',
    at,
    ref,
    mode: 'work',
    trackRef,
  }
  const loop: FlowRunEvent = {
    kind: 'loop-state',
    at,
    ref,
    loop: {
      phase: 'plan',
      awaitingOutcome: false,
      blockerRetries: 0,
      validateStartedAt: at,
      status: 'halted' as LoopRunStatus,
    },
  }
  return [start, loop]
}

function haltedBody(trackRef: string): string {
  const lines = [
    `pi_flow_run_cost_usd{agent="main",job="pi-flow",mode="work",ref="${trackRef}",phase="plan",subtask=""} 0.5`,
    `pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="flow halted at plan",ref="${trackRef}"} 1`,
    `pi_flow_run_status{job="pi-flow",mode="work",ref="${trackRef}",status="halted"} 1`,
  ]
  return `${lines.join('\n')}\n`
}

interface EngineRecording {
  deps: ReconcileDeps
  warns: string[]
  fetches: string[]
  pushes: Array<{ trackRef: string; mode: string; body: string }>
  stats: { tickets: number; journal: number; events: number }
}

interface EngineOptions {
  ticketStatus?: Map<string, string> | null
  pushOk?: boolean
  fetchFailures?: string[]
  /** return an empty group body for every ref (already-clean / lost group) */
  emptyBodies?: boolean
  refs?: string[]
}

/** Fake ENGINE deps: records every gateway + journal call. */
function fakeEngine(options: EngineOptions = {}): EngineRecording {
  const refs = options.refs ?? [REF_A, REF_B]
  const warns: string[] = []
  const fetches: string[] = []
  const pushes: Array<{ trackRef: string; mode: string; body: string }> = []
  const stats = { tickets: 0, journal: 0, events: 0 }
  const deps: ReconcileDeps = {
    async listJournalRefs() {
      stats.journal += 1
      return refs
    },
    async readRunEvents(ref: string) {
      stats.events += 1
      if (ref === REF_A) return haltedEvents(REF_A, TRACK_A)
      if (ref === REF_B) return haltedEvents(REF_B, TRACK_B)
      return null
    },
    async listTicketStatuses() {
      stats.tickets += 1
      if (options.ticketStatus === undefined) {
        return new Map([
          [REF_A, 'done'],
          [REF_B, 'canceled'],
        ])
      }
      return options.ticketStatus
    },
    // PMR-MSDJ fix round (P2-1) FIXTURE ADAPTATION, not a behavior change:
    // `ReconcileDeps` gained the bounded single-ref confirmation. Every
    // fixture here answers the listing with the candidate refs PRESENT, so
    // the engine must never probe — throwing keeps an unexpected probe loud.
    async ticketStatusOf(ref: string) {
      throw new Error(`unexpected ticketStatusOf(${ref})`)
    },
    async fetchGroupBody(
      trackRef: string,
      _mode: 'work' | 'personal',
    ): Promise<GroupBodyResult> {
      fetches.push(trackRef)
      if (options.emptyBodies === true) return { ok: true, body: '' }
      if (options.fetchFailures?.includes(trackRef)) {
        return { ok: false, error: 'pushgateway responded 500 Server Error' }
      }
      return { ok: true, body: haltedBody(trackRef) }
    },
    async pushTombstone(
      trackRef: string,
      mode: 'work' | 'personal',
      body: string,
    ) {
      pushes.push({ trackRef, mode, body })
      if (options.pushOk === false) {
        return { ok: false, error: 'pushgateway responded 400 Bad Request' }
      }
      return { ok: true }
    },
    warn(message: string) {
      warns.push(message)
    },
  }
  return { deps, warns, fetches, pushes, stats }
}

interface Capture {
  notes: Array<{ message: string; level: string }>
  out: (message: string, level: 'info' | 'warning' | 'error') => void
  readonly text: string
  warnings: () => number
}

function capture(): Capture {
  const notes: Array<{ message: string; level: string }> = []
  return {
    notes,
    out: (message, level) => {
      notes.push({ message, level })
    },
    get text() {
      return notes.map((note) => note.message).join('\n')
    },
    warnings: () => notes.filter((note) => note.level === 'warning').length,
  }
}

/**
 * Command deps for a machine WHERE THE URL IS SET. `createEngineDeps` hands
 * back the fake engine with its `warn` re-routed into the capture sink — the
 * exact shape `index.ts` wires (`ctx.ui.notify(..., 'warning')`), so a test
 * counts the warnings a user actually sees.
 */
function gatewayDeps(
  engine: EngineRecording,
): ReconcileCommandDeps & { gatewayCalls: number } {
  let gatewayCalls = 0
  return {
    get gatewayCalls() {
      return gatewayCalls
    },
    createEngineDeps: (warn) => {
      gatewayCalls += 1
      return { ...engine.deps, warn }
    },
    listJournalRefs: engine.deps.listJournalRefs,
    readRunEvents: engine.deps.readRunEvents,
    listTicketStatuses: engine.deps.listTicketStatuses,
  }
}

/** Command deps for a machine WITHOUT the URL: the gateway factory says null. */
function noGatewayDeps(options: EngineOptions = {}) {
  const engine = fakeEngine(options)
  let gatewayCalls = 0
  const deps: ReconcileCommandDeps = {
    createEngineDeps: () => {
      gatewayCalls += 1
      return null
    },
    listJournalRefs: engine.deps.listJournalRefs,
    readRunEvents: engine.deps.readRunEvents,
    listTicketStatuses: engine.deps.listTicketStatuses,
  }
  return { deps, engine, gatewayCalls: () => gatewayCalls }
}

// ---------------------------------------------------------------------------
// parseReconcileArgs
// ---------------------------------------------------------------------------

test('parseReconcileArgs: bare is a real run, --dry-run is a dry run', () => {
  assert.deepEqual(parseReconcileArgs(''), { kind: 'run' })
  assert.deepEqual(parseReconcileArgs('   '), { kind: 'run' })
  assert.deepEqual(parseReconcileArgs('--dry-run'), { kind: 'dry-run' })
  assert.deepEqual(parseReconcileArgs(' --dry-run '), { kind: 'dry-run' })
})

test('parseReconcileArgs: a positional ref or an unknown flag asks for help', () => {
  // the pass is global — a ref argument is a user error, never a filter
  assert.deepEqual(parseReconcileArgs(REF_A), { kind: 'help' })
  assert.deepEqual(parseReconcileArgs('--dry-run --push'), { kind: 'help' })
  assert.deepEqual(parseReconcileArgs('--dry-runish'), { kind: 'help' })
  assert.deepEqual(parseReconcileArgs('--help'), { kind: 'help' })
})

// ---------------------------------------------------------------------------
// help + the real-run gate
// ---------------------------------------------------------------------------

test('runReconcileCommand: help prints usage and reaches no io at all', async () => {
  const { deps, engine, gatewayCalls } = noGatewayDeps()
  const target = capture()
  await runReconcileCommand(deps, { kind: 'help' }, target.out)
  assert.match(target.text, /Usage: \/flow-reconcile-push \[--dry-run\]/)
  assert.equal(gatewayCalls(), 0)
  assert.deepEqual(
    target.notes.map((note) => note.level),
    ['info'],
  )
  assert.equal(engine.stats.journal, 0)
})

test('runReconcileCommand: a real run without the gateway URL errors, io untouched', async () => {
  const { deps, engine, gatewayCalls } = noGatewayDeps()
  const target = capture()
  await runReconcileCommand(deps, { kind: 'run' }, target.out)
  assert.equal(target.notes.length, 1)
  assert.equal(target.notes[0].level, 'error')
  assert.match(target.notes[0].message, /PI_FLOW_PUSHGATEWAY_URL/)
  assert.equal(gatewayCalls(), 1)
  // the journal/aven half is never read on the error path
  assert.equal(engine.stats.journal, 0)
  assert.equal(engine.stats.events, 0)
  assert.equal(engine.stats.tickets, 0)
})

// ---------------------------------------------------------------------------
// dry-run without a gateway ⇒ gateway-less candidate scan
// ---------------------------------------------------------------------------

test('runReconcileCommand: --dry-run without the URL lists candidates and pushes nothing', async () => {
  const { deps, engine, gatewayCalls } = noGatewayDeps()
  const target = capture()
  await runReconcileCommand(deps, { kind: 'dry-run' }, target.out)
  assert.match(target.text, /DRY RUN — nothing pushed/)
  assert.match(
    target.text,
    /PI_FLOW_PUSHGATEWAY_URL unset — candidates only, groups not inspected/,
  )
  assert.match(
    target.text,
    /PMR-AAAA \(ticket done\) journal=halted → would tombstone/,
  )
  assert.match(
    target.text,
    /PMR-BBBB \(ticket canceled\) journal=halted → would tombstone/,
  )
  assert.match(target.text, /scanned=2 candidates=2 stale=2/)
  assert.equal(gatewayCalls(), 1)
  // the gateway half was never reachable: the scan uses journal/aven seams only
  assert.deepEqual(engine.fetches, [])
  assert.deepEqual(engine.pushes, [])
})

test('runReconcileCommand: gateway-less dry-run leaves a live ticket out of the stale list', async () => {
  const { deps } = noGatewayDeps({ ticketStatus: new Map([[REF_A, 'active']]) })
  const target = capture()
  await runReconcileCommand(deps, { kind: 'dry-run' }, target.out)
  // PMR-AAAA stays live (ticket active) ⇒ counted in `candidates`, not listed
  // as stale; PMR-BBBB is MISSING from the map ⇒ stale (approved rule).
  assert.equal(/PMR-AAAA/.test(target.text), false)
  assert.match(target.text, /PMR-BBBB \(ticket missing\) journal=halted/)
  assert.match(target.text, /scanned=2 candidates=2 stale=1/)
})

test('runReconcileCommand: gateway-less dry-run with no candidates says so', async () => {
  const { deps } = noGatewayDeps({ refs: [] })
  const target = capture()
  await runReconcileCommand(deps, { kind: 'dry-run' }, target.out)
  assert.match(target.text, /scanned=0 candidates=0 stale=0/)
  assert.equal(target.warnings(), 0)
})

// ---------------------------------------------------------------------------
// the gateway path: same engine, never a second implementation
// ---------------------------------------------------------------------------

test('runReconcileCommand: dry-run with the URL set never calls pushTombstone', async () => {
  const engine = fakeEngine()
  const target = capture()
  await runReconcileCommand(
    gatewayDeps(engine),
    { kind: 'dry-run' },
    target.out,
  )
  assert.deepEqual(engine.pushes, [])
  assert.deepEqual(engine.fetches, [TRACK_A, TRACK_B])
  assert.match(target.text, /DRY RUN — nothing pushed/)
  assert.match(target.text, /→ would tombstone/)
})

test('runReconcileCommand: real run tombstones the work track refs in work mode', async () => {
  const engine = fakeEngine()
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.deepEqual(
    engine.pushes.map((push) => `${push.trackRef}|${push.mode}`),
    [`${TRACK_A}|work`, `${TRACK_B}|work`],
  )
  assert.match(
    target.text,
    /PMR-AAAA \(ticket done\) journal=halted → tombstoned/,
  )
  assert.match(target.text, /tombstoned=2 skipped=0/)
  assert.equal(
    /DRY RUN/.test(target.text),
    false,
    'a real run must not claim to be a dry run',
  )
})

test('runReconcileCommand: a real POST body is the tombstone, not the fetched group', async () => {
  const engine = fakeEngine()
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.match(engine.pushes[0].body, /status="stale"/)
  assert.equal(/halt_reason/.test(engine.pushes[0].body), false)
  assert.match(engine.pushes[0].body, /pi_flow_run_cost_usd/)
})

test('runReconcileCommand: GET failure renders the skip reason per ref', async () => {
  const engine = fakeEngine({ fetchFailures: [TRACK_B] })
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.match(
    target.text,
    /PMR-AAAA \(ticket done\) journal=halted → tombstoned/,
  )
  assert.match(
    target.text,
    /PMR-BBBB \(ticket canceled\) journal=halted → skipped: pushgateway responded 500 Server Error/,
  )
  assert.match(target.text, /tombstoned=1 skipped=1/)
})

test('runReconcileCommand: POST failure warns per ref and stays bounded', async () => {
  const engine = fakeEngine({ pushOk: false })
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.match(target.text, /→ skipped: pushgateway responded 400 Bad Request/)
  // 2 per-ref push warnings + the summary is info, not a third warning
  assert.equal(target.warnings(), 2)
})

test('runReconcileCommand: an already-clean group skips silently per ref', async () => {
  const engine = fakeEngine({ emptyBodies: true })
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.deepEqual(engine.pushes, [])
  assert.match(target.text, /→ skipped: already clean/)
})

// ---------------------------------------------------------------------------
// aven failure: one warning + a banner, in BOTH dry-run flavors
// ---------------------------------------------------------------------------

test('runReconcileCommand: aven failure with the URL set warns once and banners', async () => {
  const engine = fakeEngine({ ticketStatus: null })
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  assert.match(target.text, /aven=failed/)
  assert.match(target.text, /aven FAILED/)
  assert.equal(target.warnings(), 1)
  assert.deepEqual(engine.pushes, [])
  assert.deepEqual(engine.fetches, [])
})

test('runReconcileCommand: aven failure in the gateway-less dry-run warns once too', async () => {
  const { deps } = noGatewayDeps({ ticketStatus: null })
  const target = capture()
  await runReconcileCommand(deps, { kind: 'dry-run' }, target.out)
  assert.match(target.text, /aven FAILED/)
  assert.match(target.text, /aven=failed/)
  assert.equal(target.warnings(), 1)
  assert.equal(/→ would tombstone/.test(target.text), false)
})

// ---------------------------------------------------------------------------
// formatReconcileReport (pure render, asserted directly too)
// ---------------------------------------------------------------------------

test('formatReconcileReport: renders the summary, per-ref outcomes and headers', () => {
  const report: ReconcileReport = {
    scanned: 3,
    candidates: 2,
    stale: [
      { ref: REF_A, journalStatus: 'halted', ticketStatus: 'done' },
      { ref: REF_B, journalStatus: 'paused', ticketStatus: undefined },
    ],
    tombstoned: [REF_A],
    skipped: [{ ref: REF_B, reason: 'already clean' }],
    avenFailed: false,
    dryRun: false,
  }
  const text = formatReconcileReport(report, 'gateway')
  const lines = text.split('\n')
  assert.match(
    lines[0],
    /scanned=3 candidates=2 stale=2 tombstoned=1 skipped=1/,
  )
  assert.match(lines[1], /PMR-AAAA \(ticket done\) journal=halted → tombstoned/)
  assert.match(
    lines[2],
    /PMR-BBBB \(ticket missing\) journal=paused → skipped: already clean/,
  )
  assert.equal(/DRY RUN/.test(text), false)
})

test('formatReconcileReport: dry-run + gateway-less headers come first', () => {
  const report: ReconcileReport = {
    scanned: 1,
    candidates: 1,
    stale: [{ ref: REF_A, journalStatus: 'halted', ticketStatus: 'todo' }],
    tombstoned: [],
    skipped: [],
    avenFailed: false,
    dryRun: true,
  }
  const lines = formatReconcileReport(report, 'no-gateway').split('\n')
  assert.equal(lines[0], 'DRY RUN — nothing pushed')
  assert.equal(
    lines[1],
    'PI_FLOW_PUSHGATEWAY_URL unset — candidates only, groups not inspected',
  )
  assert.match(lines[3], /would tombstone/)
})

// ---------------------------------------------------------------------------
// the command and the engine agree (no parallel truth)
// ---------------------------------------------------------------------------

test('runReconcileCommand: gateway path reports EXACTLY what runReconcilePass returns', async () => {
  const engine = fakeEngine()
  const target = capture()
  await runReconcileCommand(gatewayDeps(engine), { kind: 'run' }, target.out)
  const direct = await runReconcilePass(fakeEngine().deps, { dryRun: false })
  const summary = target.text
    .split('\n')
    .find((line) => /scanned=\d+/.test(line)) as string
  assert.match(
    summary,
    new RegExp(
      `scanned=${direct.scanned} candidates=${direct.candidates} stale=${direct.stale.length}`,
    ),
  )
})

// ---------------------------------------------------------------------------
// registration glue
// ---------------------------------------------------------------------------

test('registerReconcileCommand registers flow-reconcile-push wired to ctx.ui.notify', async () => {
  const commands = new Map<
    string,
    {
      description: string
      handler: (args: string, ctx: unknown) => Promise<void>
    }
  >()
  const pi = {
    registerCommand: (
      name: string,
      def: {
        description: string
        handler: (args: string, ctx: unknown) => Promise<void>
      },
    ) => {
      commands.set(name, def)
    },
  } as unknown as ExtensionAPI
  const engine = fakeEngine()
  registerReconcileCommand(pi, {
    createEngineDeps: (warn) => ({ ...engine.deps, warn }),
    listJournalRefs: engine.deps.listJournalRefs,
    readRunEvents: engine.deps.readRunEvents,
    listTicketStatuses: engine.deps.listTicketStatuses,
  })
  const def = commands.get('flow-reconcile-push')
  assert.ok(def !== undefined)
  assert.match(def.description, /tombstone/i)
  const notes: Array<{ message: string; level: string }> = []
  const ctx = {
    ui: {
      notify: (message: string, level: 'info' | 'warning' | 'error') => {
        notes.push({ message, level })
      },
    },
  }
  await def.handler('--dry-run', ctx)
  const text = notes.map((note) => note.message).join('\n')
  assert.match(text, /DRY RUN — nothing pushed/)
  assert.deepEqual(engine.pushes, [])
  await def.handler('', ctx)
  assert.equal(engine.pushes.length, 2, 'the real run must push')
})
