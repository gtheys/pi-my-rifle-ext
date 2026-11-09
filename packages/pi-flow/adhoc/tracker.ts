// AIDEV-NOTE: time + cost tracking for the standalone commands that run
// OUTSIDE a /flow run (/brainstorm, /pr-quality, /review). Flow runs are
// tracked through the run journal; these have no journal, so a tiny in-memory
// tracker records a window per run and pushes `pi_flow_adhoc_*` metrics
// (Pushgateway job `pi-flow-adhoc`, group `run=<id>`) on every update. The
// metric names differ from the flow ones ON PURPOSE so the flow dashboards
// (which select pi_flow_run_* without a job filter) never pick them up.
//
// Cost model:
//  - main-session commands (brainstorm, pr-quality): the main session's
//    usage between the command and the LAST agent_settled while the run is
//    open. pr-quality closes after its first settle (one triage turn);
//    brainstorm stays open (it is a conversation) until another ad-hoc
//    command, a flow run or session shutdown. Chat after a brainstorm that
//    is not part of it is therefore counted — known limit.
//  - worker commands (review): the reviewer subagent's whole session file.
//
// Disabled while a flow is active (PI_FLOW_REF set): the flow journal already
// accounts for everything in that run. Never throws.
import { summarizeEntriesUsage } from '@gtheys/pi-interactive-subagents'
import { parseSessionEntries } from '../flow/cost.ts'

export type AdhocKind = 'brainstorm' | 'pr-quality' | 'review'

export interface AdhocWorker {
  sessionFile: string
  role: string
}

export interface AdhocRun {
  id: string
  kind: AdhocKind
  target: string
  startMs: number
  endMs: number
  mainSessionFile: string | null
  workers: AdhocWorker[]
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function labels(values: Record<string, string>): string {
  const parts: string[] = []
  for (const key of Object.keys(values)) {
    parts.push(`${key}="${esc(values[key])}"`)
  }
  return parts.join(',')
}

function entryMs(entry: unknown): number | null {
  if (entry === null || typeof entry !== 'object') return null
  const raw = (entry as Record<string, unknown>).timestamp
  if (typeof raw !== 'string') return null
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return ms
}

export function adhocRunId(
  kind: AdhocKind,
  target: string,
  startMs: number,
): string {
  const slug = target
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const stamp = new Date(startMs)
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, '')
  if (slug.length === 0) return `${kind}-${stamp}`
  return `${kind}-${slug}-${stamp}`
}

export interface AdhocSessionRow {
  role: string
  session: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Usage rows for one run. Unreadable sessions / no usage add no row. */
export function summarizeAdhoc(
  run: AdhocRun,
  readSession: (file: string) => string | null,
): AdhocSessionRow[] {
  const rows: AdhocSessionRow[] = []
  const add = (role: string, session: string, entries: readonly unknown[]) => {
    const summary = summarizeEntriesUsage(entries)
    if (!summary.sawUsage) return
    const t = summary.totals
    rows.push({
      role,
      session,
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      cost: t.cost,
    })
  }
  if (run.mainSessionFile !== null) {
    const raw = readSession(run.mainSessionFile)
    if (raw !== null) {
      const inWindow = parseSessionEntries(raw).filter((entry) => {
        const ms = entryMs(entry)
        return ms !== null && ms >= run.startMs && ms <= run.endMs
      })
      add('main', 'main', inWindow)
    }
  }
  run.workers.forEach((worker, index) => {
    const raw = readSession(worker.sessionFile)
    if (raw === null) return
    add(worker.role, `${worker.role}-${index + 1}`, parseSessionEntries(raw))
  })
  return rows
}

/** Span attributes for the run's trace span (strings only, like every span). */
export function adhocSpanAttributes(
  run: AdhocRun,
  rows: readonly AdhocSessionRow[],
): Record<string, string> {
  let cost = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const row of rows) {
    cost += row.cost
    input += row.input
    output += row.output
    cacheRead += row.cacheRead
    cacheWrite += row.cacheWrite
  }
  const attrs: Record<string, string> = {
    'adhoc.run': run.id,
    'adhoc.kind': run.kind,
    'adhoc.target': run.target,
    'adhoc.duration_s': String(Math.max(0, (run.endMs - run.startMs) / 1000)),
    'adhoc.cost_usd': String(cost),
    'adhoc.tokens.input': String(input),
    'adhoc.tokens.output': String(output),
    'adhoc.tokens.cache_read': String(cacheRead),
    'adhoc.tokens.cache_write': String(cacheWrite),
  }
  const reviewer = run.workers[0]
  if (reviewer !== undefined) attrs['adhoc.session_file'] = reviewer.sessionFile
  return attrs
}

/** Prometheus exposition for one run. Pure; unreadable sessions add nothing. */
export function buildAdhocBody(
  run: AdhocRun,
  readSession: (file: string) => string | null,
): string {
  const base = { run: run.id, kind: run.kind, target: run.target }
  const lines: string[] = []
  lines.push(
    `pi_flow_adhoc_start_seconds{${labels(base)}} ${run.startMs / 1000}`,
  )
  const seconds = Math.max(0, (run.endMs - run.startMs) / 1000)
  lines.push(`pi_flow_adhoc_duration_seconds{${labels(base)}} ${seconds}`)
  for (const row of summarizeAdhoc(run, readSession)) {
    const rowLabels = { ...base, role: row.role, session: row.session }
    lines.push(`pi_flow_adhoc_cost_usd{${labels(rowLabels)}} ${row.cost}`)
    const kinds: Array<[string, number]> = [
      ['input', row.input],
      ['output', row.output],
      ['cacheRead', row.cacheRead],
      ['cacheWrite', row.cacheWrite],
    ]
    for (const [type, value] of kinds) {
      lines.push(
        `pi_flow_adhoc_tokens_total{${labels({ ...rowLabels, type })}} ${value}`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

export interface AdhocDeps {
  now: () => number
  getSessionFile: () => string | null
  readSession: (file: string) => string | null
  /** Replace the Pushgateway group for the run. Failures are swallowed. */
  push: (runId: string, body: string) => Promise<unknown>
  /** True while a /flow run is active: tracking is skipped. */
  flowActive: () => boolean
  /**
   * Trace hooks (telemetry). begin: a main-session run opened, so spans made
   * from now on nest under it. end: the run closed — export its span ONCE
   * (never update in place; Tempo keeps both copies of a re-sent span id).
   * A worker run only ever gets end (its work happened in another process).
   */
  trace?: {
    begin: (run: AdhocRun) => void
    end: (run: AdhocRun, attributes: Record<string, string>) => void
  }
}

export interface AdhocTracker {
  beginMain: (
    kind: AdhocKind,
    target: string,
    singleTurn: boolean,
  ) => AdhocRun | null
  beginWorker: (kind: AdhocKind, target: string) => AdhocRun | null
  addWorker: (run: AdhocRun | null, worker: AdhocWorker) => void
  finish: (run: AdhocRun | null) => Promise<void>
  /** agent_settled: extend the open main-session run and push. */
  settled: () => Promise<void>
  /** Close the open main-session run (flow start / session shutdown). */
  closeMain: () => Promise<void>
}

export function createAdhocTracker(deps: AdhocDeps): AdhocTracker {
  let mainRun: AdhocRun | null = null
  let mainSingleTurn = false

  function endTrace(run: AdhocRun): void {
    if (deps.trace === undefined) return
    try {
      deps.trace.end(
        run,
        adhocSpanAttributes(run, summarizeAdhoc(run, deps.readSession)),
      )
    } catch {
      // best-effort by design
    }
  }

  async function pushRun(run: AdhocRun): Promise<void> {
    try {
      await deps.push(run.id, buildAdhocBody(run, deps.readSession))
    } catch {
      // best-effort by design
    }
  }

  function newRun(kind: AdhocKind, target: string, main: boolean): AdhocRun {
    const startMs = deps.now()
    let mainSessionFile: string | null = null
    if (main) mainSessionFile = deps.getSessionFile()
    return {
      id: adhocRunId(kind, target, startMs),
      kind,
      target,
      startMs,
      endMs: startMs,
      mainSessionFile,
      workers: [],
    }
  }

  async function closeMain(): Promise<void> {
    const run = mainRun
    mainRun = null
    if (run !== null) {
      run.endMs = deps.now()
      endTrace(run)
      await pushRun(run)
    }
  }

  return {
    beginMain(kind, target, singleTurn) {
      if (deps.flowActive()) return null
      void closeMain()
      mainRun = newRun(kind, target, true)
      mainSingleTurn = singleTurn
      deps.trace?.begin(mainRun)
      void pushRun(mainRun)
      return mainRun
    },
    beginWorker(kind, target) {
      if (deps.flowActive()) return null
      return newRun(kind, target, false)
    },
    addWorker(run, worker) {
      if (run === null || worker.sessionFile.length === 0) return
      run.workers.push(worker)
    },
    async finish(run) {
      if (run === null) return
      run.endMs = deps.now()
      endTrace(run)
      await pushRun(run)
    },
    async settled() {
      if (mainRun === null) return
      mainRun.endMs = deps.now()
      await pushRun(mainRun)
      if (mainSingleTurn) {
        endTrace(mainRun)
        mainRun = null
      }
    },
    closeMain,
  }
}

// AIDEV-NOTE: module-level handle so the command modules (phase-command,
// pr-quality, review) can report without threading a dependency through
// every registration. index.ts configures it once; unconfigured = no-ops.
let current: AdhocTracker | null = null

export function configureAdhoc(tracker: AdhocTracker | null): void {
  current = tracker
}

export function adhocBeginMain(
  kind: AdhocKind,
  target: string,
  singleTurn: boolean,
): AdhocRun | null {
  if (current === null) return null
  return current.beginMain(kind, target, singleTurn)
}

export function adhocBeginWorker(
  kind: AdhocKind,
  target: string,
): AdhocRun | null {
  if (current === null) return null
  return current.beginWorker(kind, target)
}

export function adhocAddWorker(
  run: AdhocRun | null,
  worker: AdhocWorker,
): void {
  current?.addWorker(run, worker)
}

export function adhocFinish(run: AdhocRun | null): Promise<void> {
  if (current === null) return Promise.resolve()
  return current.finish(run)
}

export function adhocSettled(): Promise<void> {
  if (current === null) return Promise.resolve()
  return current.settled()
}

export function adhocCloseMain(): Promise<void> {
  if (current === null) return Promise.resolve()
  return current.closeMain()
}
