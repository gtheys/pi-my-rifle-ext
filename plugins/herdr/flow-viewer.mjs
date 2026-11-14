#!/usr/bin/env node
// AIDEV-NOTE: Herdr flow-viewer pane launcher (pattern ported from
// pi-workflows plugins/herdr/viewer.mjs). The pane receives PI_FLOW_REF and
// PI_FLOW_RUN_FILE from the Pi session (herdr/viewer.ts) — it resolves
// NOTHING itself, starts no server, and never shells out except to label its
// own pane. Failures stay on screen and name the failure in the pane label;
// a dead pane is never a blank pane.
import { spawnSync } from 'node:child_process'
import { readFileSync, watch, watchFile } from 'node:fs'
import { EOL } from 'node:os'
import { fileURLToPath } from 'node:url'

const FAILURE_LABEL_LIMIT = 60
const WATCH_INTERVAL_MS = 1_000
const DEBOUNCE_MS = 150
const ACTIVITY_EVENT_LIMIT = 8
const ACTIVITY_TEXT_LIMIT = 60

const JOURNAL_KINDS = new Set([
  'run-start',
  'phase-start',
  'phase-complete',
  'gate-target',
  'gate-decision',
  'subtask-ranges',
  'main-session',
  'note',
])

// A closed pane (or a piped test) closes stdout; exit quietly instead of an
// unhandled EPIPE from the watcher.
process.on('error', () => process.exit(0))
process.stdout?.on?.('error', () => process.exit(0))

// ── ANSI escapes (pure render helpers below use these; tests import them) ──
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

// ── main-module guard ──
// AIDEV-NOTE: only the pane process (spawned directly by herdr) runs the
// execution prelude below; importing this module from tests must execute
// nothing. Pure helpers (renderState, renderText) are exported for unit tests.
// The `flow · <ref>` renamePane call stays BEFORE the first render inside the
// guard — that label is the dedupe key scanned in `herdr api snapshot`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

function main() {
  const ref = process.env.PI_FLOW_REF ?? ''
  const runFile = process.env.PI_FLOW_RUN_FILE ?? ''
  const paneId = process.env.HERDR_PANE_ID ?? ''

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ref)) {
    failWithoutPane('PI_FLOW_REF is missing or invalid.')
  }

  if (!/^\//.test(runFile)) {
    failWithoutPane('PI_FLOW_RUN_FILE is missing or not an absolute path.')
  }

  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(paneId)) {
    failWithoutPane('HERDR_PANE_ID is missing or invalid.')
  }

  // Label the pane BEFORE rendering: the label is the dedupe key the Pi session
  // scans for in `herdr api snapshot`, so it must exist even if rendering dies.
  renamePane(paneId, `flow · ${ref}`)

  renderOnce(ref, runFile)
  // AIDEV-NOTE: fs.watch is safe here because it lives in the pane process,
  // not Pi's extension process — see pi-interactive-subagents subagent-done.ts
  // ("fs.watch was removed after it wedged child startup ... Do not re-add
  // without a startup regression test") and pr-quality/index.ts ("fs.watch
  // reliability issues"). The watchFile interval polls below are a PERMANENT
  // fallback, never remove them; fs.watch only buys sub-second latency.
  const render = createDebouncedRender(() => renderOnce(ref, runFile), DEBOUNCE_MS)
  watchFile(runFile, { interval: WATCH_INTERVAL_MS }, () => {
    render()
  })
  const journalFile = journalFileFor(runFile)
  if (journalFile !== '') {
    watchFile(journalFile, { interval: WATCH_INTERVAL_MS }, () => {
      render()
    })
    try {
      watch(journalFile, () => {
        render()
      })
    } catch {
      // The journal may not exist yet or fs.watch may be unsupported here;
      // degrade silently to interval-only polling. Never crash the pane.
    }
  }
}

// AIDEV-NOTE: trailing-edge debounce shared by all watcher callbacks (fs.watch
// event + both watchFile polls) so a burst of journal appends coalesces into a
// single render. Exported pure factory so tests can pass a tiny delayMs.
export function createDebouncedRender(renderFn, delayMs) {
  let timer = null
  return () => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      renderFn()
    }, delayMs)
    timer.unref?.()
  }
}

function renderOnce(ref, runFile) {
  let raw
  try {
    raw = readFileSync(runFile, 'utf8')
  } catch (error) {
    renderText(
      `flow · ${ref}`,
      [
        `No run-state file at ${runFile}.`,
        `Start the flow first: /flow ${ref}`,
        `(${error instanceof Error ? error.message : String(error)})`,
      ].join(EOL),
    )
    return
  }
  let state
  try {
    state = JSON.parse(raw)
  } catch (error) {
    renderText(
      `flow · ${ref}`,
      `Run-state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }
  // AIDEV-NOTE: journal is optional — a missing/unreadable journal renders the
  // projection-only view with no error and no activity section.
  const journalFile = journalFileFor(runFile)
  let activity = ''
  if (journalFile !== '') {
    let journalRaw
    try {
      journalRaw = readFileSync(journalFile, 'utf8')
    } catch {
      journalRaw = ''
    }
    activity = renderActivity(parseJournal(journalRaw))
  }
  let body = renderState(state, ref)
  if (activity !== '') {
    body = `${body}${EOL}${EOL}${activity}`
  }
  renderText(`flow · ${ref}`, body)
}

// AIDEV-NOTE: journal path derived from the run-state file (sibling
// *.journal.jsonl). Subtask 1.5 replaces this with env plumbing — keep the
// swap to this one helper.
export function journalFileFor(runFile) {
  if (runFile.endsWith('.json')) {
    return `${runFile.slice(0, -'.json'.length)}.journal.jsonl`
  }
  return ''
}


// AIDEV-NOTE: pure parser for the flow journal JSONL (FlowRunEvent lines,
// packages/pi-flow/run-state.ts). Torn/invalid lines and unknown kinds are
// skipped for forward-compat, mirroring how the projection ignores unknown
// events. Base run state still comes ONLY from the projection file.
export function parseJournal(raw) {
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') {
      continue
    }
    if (!JOURNAL_KINDS.has(event.kind)) {
      continue
    }
    events.push(event)
  }
  return events
}


function activityClock(at) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return '??:??'
  }
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function activityLine(event) {
  const clock = activityClock(event.at)
  const time = `[${clock}]`
  if (event.kind === 'note') {
    const text = typeof event.text === 'string' ? event.text : ''
    return `${time} note ${text.slice(0, ACTIVITY_TEXT_LIMIT)}`
  }
  if (event.kind === 'phase-start') {
    return `${time} phase-start ${event.phase ?? '?'}`
  }
  if (event.kind === 'phase-complete') {
    return `${time} phase-complete ${event.phase ?? '?'} (${event.label ?? ''})`
  }
  if (event.kind === 'gate-target') {
    return `${time} gate-target ${event.gate ?? '?'} ${event.targetId ?? ''}`
  }
  if (event.kind === 'gate-decision') {
    return `${time} gate-decision ${event.gate ?? '?'} ${event.status ?? '?'}`
  }
  if (event.kind === 'subtask-ranges') {
    return `${time} subtask-ranges ${event.gate ?? '?'}`
  }
  if (event.kind === 'main-session') {
    return `${time} main-session`
  }
  if (event.kind === 'run-start') {
    return `${time} run-start`
  }
  return `${time} ${event.kind}`
}

// AIDEV-NOTE: bounded activity section — at most the last 8 events, oldest
// first, one line each, note text clipped to 60 chars. Returns '' when there
// is nothing to show (journal-less runs render projection-only).
export function renderActivity(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return ''
  }
  const recent = events.slice(-ACTIVITY_EVENT_LIMIT)
  const lines = ['activity:']
  for (const event of recent) {
    lines.push(`  ${activityLine(event)}`)
  }
  return lines.join(EOL)
}

export function renderState(state, fallbackRef = '') {
  const phases = ['research', 'plan', 'implement', 'validate', 'feedback']
  const labels = {
    research: 'researched',
    plan: 'planned',
    implement: 'active',
    validate: 'review-passed',
    feedback: 'done',
  }
  const completed = Array.isArray(state.completedPhases) ? state.completedPhases : []
  const lines = []
  lines.push(`RPIV flow · ${state.ref ?? fallbackRef}`)
  lines.push(`mode: ${state.mode ?? '?'}   started: ${state.startedAt ?? '?'}`)
  lines.push('')
  for (const phase of phases) {
    const mark = completed.includes(phase) ? '[x]' : '[ ]'
    const active = state.currentPhase === phase ? ' <- running' : ''
    lines.push(`${mark} ${phase.padEnd(11)} (${labels[phase]})${active}`)
  }
  if (state.researchSkipNote) {
    lines.push('')
    lines.push(`research skipped: ${state.researchSkipNote}`)
  }
  if (Array.isArray(state.notes) && state.notes.length > 0) {
    lines.push('')
    lines.push('notes:')
    for (const note of state.notes) {
      lines.push(`  - ${note.at} ${note.text}`)
    }
  }
  lines.push('')
  lines.push(`updated: ${state.updatedAt ?? '?'}`)
  return lines.join(EOL)
}

// ── terminal rendering (minimal ANSI, no deps) ──

export function renderText(title, body) {
  const colored = body
    .split(EOL)
    .map((line) =>
      line.startsWith('[x]')
        ? `${GREEN}${line.slice(0, 3)}${RESET}${line.slice(3)}`
        : line.includes('<- running')
          ? `${YELLOW}${line}${RESET}`
          : line.startsWith('  -') || line.startsWith('  [') || line.startsWith('updated:')
            ? `${DIM}${line}${RESET}`
            : line,
    )
    .join(EOL)
  process.stdout.write(`${BOLD}${title}${RESET}${EOL}${EOL}${colored}${EOL}`)
}

function renamePane(id, label) {
  const result = spawnSync('herdr', ['pane', 'rename', id, label], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.error !== undefined && result.error !== null) {
    // herdr CLI missing — keep rendering anyway; dedupe just won't work.
    process.stderr.write(`Could not label the pane (herdr CLI missing): ${result.error.message}\n`)
    return
  }
  if (result.status !== 0) {
    process.stderr.write(
      `Could not label the Herdr viewer pane: ${bounded(result.stderr) || 'unknown error'}\n`,
    )
  }
}

function failWithoutPane(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function bounded(value) {
  const compact = (value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/ +/gu, ' ')
    .trim()
  return compact.length <= FAILURE_LABEL_LIMIT
    ? compact
    : `${compact.slice(0, FAILURE_LABEL_LIMIT - 1)}…`
}
