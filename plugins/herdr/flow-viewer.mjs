#!/usr/bin/env node
// AIDEV-NOTE: Herdr flow-viewer pane launcher (pattern ported from
// pi-workflows plugins/herdr/viewer.mjs). The pane receives PI_FLOW_REF and
// PI_FLOW_RUN_FILE from the Pi session (herdr/viewer.ts) — it resolves
// NOTHING itself, starts no server, and never shells out except to label its
// own pane. Failures stay on screen and name the failure in the pane label;
// a dead pane is never a blank pane.
import { spawnSync } from 'node:child_process'
import { readFileSync, watchFile } from 'node:fs'
import { EOL } from 'node:os'

const FAILURE_LABEL_LIMIT = 60
const WATCH_INTERVAL_MS = 1_000

// A closed pane (or a piped test) closes stdout; exit quietly instead of an
// unhandled EPIPE from the watcher.
process.on('error', () => process.exit(0))
process.stdout?.on?.('error', () => process.exit(0))

// ── ANSI escapes (declared before first use — renderOnce runs at top level) ──
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

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

renderOnce()
watchFile(runFile, { interval: WATCH_INTERVAL_MS }, () => {
  renderOnce()
})

function renderOnce() {
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
  renderText(`flow · ${ref}`, renderState(state))
}

function renderState(state) {
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
  lines.push(`RPIV flow · ${state.ref ?? ref}`)
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

function renderText(title, body) {
  const colored = body
    .split(EOL)
    .map((line) =>
      line.startsWith('[x]')
        ? `${GREEN}${line.slice(0, 3)}${RESET}${line.slice(3)}`
        : line.includes('<- running')
          ? `${YELLOW}${line}${RESET}`
          : line.startsWith('  -') || line.startsWith('updated:')
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
