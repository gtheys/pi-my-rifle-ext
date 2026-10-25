import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AIDEV-NOTE: mock-herdr PATH shim fixture (PMR-X8MS). Materializes a fake
// `herdr` binary into a mkdtemp bin dir; tests prepend that dir to PATH so
// production code's runHerdr = execFileSync('herdr') hits the shim with zero
// production-code changes. State (panes/tabs/agents) persists in state.json
// inside the shim dir because every execFileSync is a fresh process.
// Contract mirrors pi-extension/subagents/herdr.ts + spawn.ts/surface.ts:
// raw-text verbs vs {id,result} envelope verbs; `pane get` on a missing pane
// exits 1 with an error envelope (herdrPaneAlive keys off exitCode === 1);
// wait-output polls the pane log for the regex and exits 1 on timeout.

/** The shim script. CommonJS — the file has no extension, so node defaults it. */
const SHIM_SCRIPT = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')

const MOCK_VERSION = '0.9.1'
const dir = __dirname
const statePath = path.join(dir, 'state.json')
const panesDir = path.join(dir, 'panes')

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    return { next: 1, panes: {}, tabs: {}, agents: {}, focused: null }
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state))
}

function logPath(paneId) {
  return path.join(panesDir, paneId.replace(/[:/]/g, '_') + '.log')
}

function appendLog(paneId, text) {
  fs.appendFileSync(logPath(paneId), text)
}

function readLog(paneId) {
  try {
    return fs.readFileSync(logPath(paneId), 'utf8')
  } catch {
    return ''
  }
}

function out(result) {
  process.stdout.write(JSON.stringify({ id: 1, result }) + '\\n')
}

function fail(code, message, exitCode) {
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\\n')
  process.exit(exitCode)
}

function parseFlags(argv) {
  const flags = {}
  const positional = []
  let onlyPositional = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (onlyPositional || !arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      onlyPositional = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      // A following --flag is not a value — treat this one as boolean.
      flags[arg.slice(2)] = true
    } else {
      flags[arg.slice(2)] = value
      i++
    }
  }
  return { flags, positional }
}

function tailLines(text, lines) {
  const split = text.split('\\n')
  if (split.length <= lines) return text
  return split.slice(-lines).join('\\n')
}

function paneRecord(state, paneId) {
  return state.panes[paneId]
}

function requirePane(state, paneId) {
  const record = state.panes[paneId]
  if (!record) {
    fail('pane_not_found', 'pane ' + paneId + ' not found', 1)
  }
  return record
}

function createTab(state, flags) {
  const n = state.next
  state.next = n + 1
  const tabId = 't' + n
  const paneId = 't' + n + ':p' + n
  const workspaceId = String(flags.workspace ?? 'w1')
  state.tabs[tabId] = {
    tab_id: tabId,
    workspace_id: workspaceId,
    label: String(flags.label ?? ''),
    cwd: String(flags.cwd ?? '/tmp'),
  }
  state.panes[paneId] = {
    pane_id: paneId,
    tab_id: tabId,
    workspace_id: workspaceId,
    agent: null,
  }
  return { tabId, paneId, workspaceId }
}

const argv = process.argv.slice(2)

if (!fs.existsSync(panesDir)) {
  fs.mkdirSync(panesDir, { recursive: true })
}
const state = loadState()
const { flags, positional } = parseFlags(argv)
const verb0 = positional[0]
const verb1 = positional[1]

// --version and status --json: raw text, preflight contract.
if (argv[0] === '--version') {
  process.stdout.write('herdr ' + MOCK_VERSION + '\\n')
  process.exit(0)
}
if (verb0 === 'status') {
  process.stdout.write(
    JSON.stringify({
      client: { version: MOCK_VERSION },
      server: { status: 'ok', running: true, version: MOCK_VERSION },
    }) + '\\n',
  )
  process.exit(0)
}

if (verb0 === 'tab' && verb1 === 'create') {
  const created = createTab(state, flags)
  saveState(state)
  out({
    root_pane: {
      pane_id: created.paneId,
      tab_id: created.tabId,
      workspace_id: created.workspaceId,
    },
    tab: {
      tab_id: created.tabId,
      workspace_id: created.workspaceId,
      label: String(flags.label ?? ''),
      cwd: String(flags.cwd ?? '/tmp'),
    },
  })
  process.exit(0)
}
if (verb0 === 'tab' && verb1 === 'list') {
  const workspaceId = String(flags.workspace ?? '')
  const tabs = Object.values(state.tabs).filter((t) => {
    return workspaceId === '' || t.workspace_id === workspaceId
  })
  out({ tabs })
  process.exit(0)
}
if (verb0 === 'tab' && verb1 === 'close') {
  const tabId = positional[2]
  if (!state.tabs[tabId]) {
    fail('tab_not_found', 'tab ' + tabId + ' not found', 1)
  }
  delete state.tabs[tabId]
  for (const [paneId, record] of Object.entries(state.panes)) {
    if (record.tab_id === tabId) {
      delete state.panes[paneId]
    }
  }
  saveState(state)
  process.exit(0)
}
if (verb0 === 'tab' && verb1 === 'focus') {
  state.focused = positional[2] ?? null
  saveState(state)
  process.exit(0)
}

if (verb0 === 'workspace' && verb1 === 'focus') {
  state.focused = positional[2] ?? null
  saveState(state)
  process.exit(0)
}

if (verb0 === 'pane' && verb1 === 'list') {
  out({ panes: Object.values(state.panes) })
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'get') {
  const paneId = positional[2]
  if (!state.panes[paneId]) {
    fail('pane_not_found', 'pane ' + paneId + ' not found', 1)
  }
  out({ pane: state.panes[paneId] })
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'layout') {
  const paneId = String(flags.pane ?? positional[2])
  requirePane(state, paneId)
  out({ pane_id: paneId, layout: 'single', panes: [state.panes[paneId]] })
  process.exit(0)
}
// AIDEV-NOTE: pane split mirrors the itest gate (PMR-RNW2): attach the
// new pane to the referenced pane's tab, else the most recently created tab.
if (verb0 === 'pane' && verb1 === 'split') {
  const n = state.next
  state.next = n + 1
  const paneId = 't' + n + ':p' + n
  const refPaneId = positional[2] ? String(positional[2]) : ''
  let tabId
  let workspaceId
  if (refPaneId && state.panes[refPaneId]) {
    tabId = state.panes[refPaneId].tab_id
    workspaceId = state.panes[refPaneId].workspace_id
  } else {
    const tabIds = Object.keys(state.tabs)
    if (tabIds.length === 0) {
      // A running herdr always has a current tab — synthesize one so pane
      // split works without a prior tab create (itest gate, PMR-RNW2).
      const t = state.next
      state.next = t + 1
      tabId = 't' + t
      workspaceId = 'w1'
      state.tabs[tabId] = {
        tab_id: tabId,
        workspace_id: workspaceId,
        label: '',
        cwd: String(flags.cwd ?? '/tmp'),
      }
    } else {
      tabId = tabIds[tabIds.length - 1]
      workspaceId = state.tabs[tabId].workspace_id
    }
  }
  state.panes[paneId] = {
    pane_id: paneId,
    tab_id: tabId,
    workspace_id: workspaceId,
    agent: null,
    cwd: String(flags.cwd ?? '/tmp'),
  }
  saveState(state)
  out({ pane: { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId } })
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'run') {
  const paneId = positional[2]
  requirePane(state, paneId)
  const command = positional.slice(3).join(' ')
  const res = cp.spawnSync('bash', ['-c', command], { encoding: 'utf8' })
  appendLog(paneId, String(res.stdout ?? ''))
  appendLog(paneId, String(res.stderr ?? ''))
  process.exit(res.status === 0 ? 0 : 1)
}
if (verb0 === 'pane' && verb1 === 'send-text') {
  // AIDEV-NOTE: minimal shell semantics (PMR-RNW2): send-text buffers the
  // typed line (echoed into the log), send-keys return executes it via bash
  // and appends the output — so the send-text/return surface path runs real
  // commands against the mock, like a terminal would.
  const paneId = positional[2]
  const record = requirePane(state, paneId)
  const text = positional.slice(3).join(' ')
  appendLog(paneId, text + '\\n')
  record.pending = text
  saveState(state)
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'send-keys') {
  const paneId = positional[2]
  const record = requirePane(state, paneId)
  const key = positional.slice(3).join(' ')
  if (key === 'return') {
    const pending = typeof record.pending === 'string' ? record.pending : ''
    record.pending = null
    saveState(state)
    if (pending !== '') {
      const res = cp.spawnSync('bash', ['-c', pending], { encoding: 'utf8' })
      appendLog(paneId, String(res.stdout ?? ''))
      appendLog(paneId, String(res.stderr ?? ''))
    } else {
      appendLog(paneId, '\\n')
    }
  } else if (key === 'esc') {
    appendLog(paneId, '[esc]\\n')
  } else {
    appendLog(paneId, '[' + key + ']')
  }
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'read') {
  const paneId = positional[2]
  requirePane(state, paneId)
  let text = readLog(paneId)
  if (typeof flags.lines === 'string') {
    text = tailLines(text, Number.parseInt(flags.lines, 10))
  }
  process.stdout.write(text)
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'close') {
  const paneId = positional[2]
  requirePane(state, paneId)
  delete state.panes[paneId]
  saveState(state)
  process.exit(0)
}
if (verb0 === 'pane' && verb1 === 'wait-output') {
  const paneId = positional[2]
  const regexStr = String(flags.regex ?? '')
  const timeoutMs = Number.parseInt(String(flags.timeout ?? '5000'), 10)
  requirePane(state, paneId)
  let regex
  try {
    regex = new RegExp(regexStr)
  } catch {
    fail('bad_regex', 'invalid regex: ' + regexStr, 1)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = readLog(paneId).split('\\n')
    for (const line of lines) {
      if (regex.test(line)) {
        out({ matched_line: line, pane_id: paneId })
        process.exit(0)
      }
    }
    cp.spawnSync('sleep', ['0.025'])
  }
  fail('timeout', 'wait-output timed out after ' + timeoutMs + 'ms', 1)
}

if (verb0 === 'agent' && verb1 === 'start') {
  const alias = positional[2]
  const paneId = String(flags.pane ?? '')
  const record = state.panes[paneId]
  if (!record) {
    fail('pane_not_found', 'pane ' + paneId + ' not found', 1)
  }
  state.agents[alias] = {
    agent: alias,
    agent_status: 'running',
    kind: String(flags.kind ?? 'pi'),
    pane_id: paneId,
    tab_id: record.tab_id,
    workspace_id: record.workspace_id,
    cwd: record.cwd ?? '/tmp',
    agent_session: { value: 'mock-' + alias },
  }
  record.agent = alias
  saveState(state)
  process.stdout.write('started agent ' + alias + '\\n')
  process.exit(0)
}
if (verb0 === 'agent' && verb1 === 'list') {
  out({ agents: Object.values(state.agents) })
  process.exit(0)
}
if (verb0 === 'agent' && verb1 === 'get') {
  const target = positional[2]
  let agent = state.agents[target] ?? null
  if (!agent) {
    // Target may be a pane id instead of an alias.
    for (const record of Object.values(state.agents)) {
      if (record.pane_id === target) {
        agent = record
        break
      }
    }
  }
  out({ agent })
  process.exit(0)
}
if (verb0 === 'agent' && verb1 === 'focus') {
  state.focused = positional[2] ?? null
  saveState(state)
  process.exit(0)
}
if (verb0 === 'agent' && verb1 === 'read') {
  const target = positional[2]
  let agent = state.agents[target] ?? null
  if (!agent) {
    for (const record of Object.values(state.agents)) {
      if (record.pane_id === target) {
        agent = record
        break
      }
    }
  }
  if (!agent) {
    fail('agent_not_found', 'agent ' + target + ' not found', 1)
  }
  process.stdout.write(readLog(agent.pane_id))
  process.exit(0)
}

fail('unknown_command', 'mock herdr: unsupported argv: ' + argv.join(' '), 1)
`

export interface MockHerdr {
  /** Dir to prepend to PATH (contains the `herdr` binary). */
  binDir: string
  /** Full path of the shim binary (for direct execFileSync invocation). */
  shimPath: string
  // AIDEV-NOTE: state.json and the pane logs live in binDir (the shim's own
  // __dirname), NOT in dir — dir is only the mkdtemp root that owns binDir.
  /** mkdtemp root that owns binDir; removed by dispose(). */
  dir: string
  /** Run the shim directly and return trimmed stdout. */
  run: (args: readonly string[]) => string
  /** Remove the temp dir. */
  dispose: () => void
}

/** Materialize the mock herdr shim into a fresh mkdtemp dir. */
export function installMockHerdr(): MockHerdr {
  const dir = mkdtempSync(join(tmpdir(), 'mock-herdr-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const shimPath = join(binDir, 'herdr')
  writeFileSync(shimPath, SHIM_SCRIPT, { mode: 0o755 })
  chmodSync(shimPath, 0o755)
  return {
    binDir,
    shimPath,
    dir,
    run: (args: readonly string[]) =>
      execFileSync(shimPath, args, { encoding: 'utf8' }).trim(),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
