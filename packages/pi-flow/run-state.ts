// AIDEV-NOTE: Flow run-state journal (PMR follow-up, ported from
// pi-workflows' "durable run state" idea). Aven labels stay the gate source
// of truth; this journal is the *evidence record* — append-only JSONL events
// plus a current-state projection, written under
// getAgentDir()/pi-flow/runs/<ref>.json (+ .journal.jsonl).
// The Herdr flow viewer renders the projection WITHOUT touching aven.

import { promises as fs } from 'node:fs'
import path from 'node:path'

export type FlowPhase =
  | 'research'
  | 'plan'
  | 'implement'
  | 'validate'
  | 'feedback'

export type FlowRunEvent =
  | {
      kind: 'run-start'
      at: string
      ref: string
      mode: 'work' | 'personal'
      skipResearch: boolean
    }
  | {
      kind: 'phase-start'
      at: string
      ref: string
      phase: FlowPhase
    }
  | {
      kind: 'phase-complete'
      at: string
      ref: string
      phase: FlowPhase
      label: string
    }
  | {
      kind: 'phase-skip'
      at: string
      ref: string
      reason: string
    }
  | {
      kind: 'note'
      at: string
      ref: string
      text: string
    }

export type FlowRunState = {
  schema: 'gtheys.pi-flow.run.v1'
  ref: string
  mode: 'work' | 'personal'
  skipResearch: boolean
  startedAt: string
  updatedAt: string
  completedPhases: FlowPhase[]
  currentPhase: FlowPhase | null
  researchSkipNote: string | null
  notes: { at: string; text: string }[]
}

export function runFileName(ref: string): string | null {
  // Refs are ticket ids (PMR-ABC123 / DP-71). Restrict to a safe filename
  // charset so the ref can never escape the runs dir or add path segments.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(ref)) return null
  return `${ref}.json`
}

export function runsDir(agentDir: string): string {
  return path.join(agentDir, 'pi-flow', 'runs')
}

export function runStatePath(agentDir: string, ref: string): string | null {
  const name = runFileName(ref)
  if (name === null) return null
  return path.join(runsDir(agentDir), name)
}

/** Project the current run state from an ordered event list. Pure. */
export function projectRunState(
  events: readonly FlowRunEvent[],
): FlowRunState | null {
  let state: FlowRunState | null = null
  for (const event of events) {
    state = applyEvent(state, event)
  }
  return state
}

export function applyEvent(
  state: FlowRunState | null,
  event: FlowRunEvent,
): FlowRunState {
  switch (event.kind) {
    case 'run-start': {
      return {
        schema: 'gtheys.pi-flow.run.v1',
        ref: event.ref,
        mode: event.mode,
        skipResearch: event.skipResearch,
        startedAt: event.at,
        updatedAt: event.at,
        completedPhases: [],
        currentPhase: null,
        researchSkipNote: null,
        notes: [],
      }
    }
    case 'phase-start': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      if (state.currentPhase === event.phase) return state
      return { ...state, currentPhase: event.phase, updatedAt: event.at }
    }
    case 'phase-complete': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const completed = state.completedPhases.includes(event.phase)
        ? state.completedPhases
        : [...state.completedPhases, event.phase]
      const current =
        state.currentPhase === event.phase ? null : state.currentPhase
      return {
        ...state,
        completedPhases: completed,
        currentPhase: current,
        updatedAt: event.at,
      }
    }
    case 'phase-skip': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        researchSkipNote: event.reason,
        updatedAt: event.at,
      }
    }
    case 'note': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        notes: [...state.notes, { at: event.at, text: event.text }],
        updatedAt: event.at,
      }
    }
  }
}

const SCHEMA = 'gtheys.pi-flow.run.v1'
const PHASES: readonly FlowPhase[] = [
  'research',
  'plan',
  'implement',
  'validate',
  'feedback',
]

export function isFlowRunState(value: unknown): value is FlowRunState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.schema !== SCHEMA) return false
  if (typeof v.ref !== 'string') return false
  if (v.mode !== 'work' && v.mode !== 'personal') return false
  if (typeof v.skipResearch !== 'boolean') return false
  if (typeof v.startedAt !== 'string') return false
  if (typeof v.updatedAt !== 'string') return false
  if (!Array.isArray(v.completedPhases)) return false
  if (!v.completedPhases.every((p) => PHASES.includes(p as FlowPhase)))
    return false
  const current = v.currentPhase
  if (current !== null && !PHASES.includes(current as FlowPhase)) return false
  if (v.researchSkipNote !== null && typeof v.researchSkipNote !== 'string')
    return false
  if (!Array.isArray(v.notes)) return false
  return v.notes.every(
    (n) =>
      typeof n === 'object' &&
      n !== null &&
      typeof (n as Record<string, unknown>).at === 'string' &&
      typeof (n as Record<string, unknown>).text === 'string',
  )
}

/**
 * Append an event to the journal and rewrite the projection atomically.
 * Best-effort per repo convention: journal failures must never break a flow
 * phase — aven labels remain the gate source of truth.
 */
export async function recordRunEvent(
  agentDir: string,
  event: FlowRunEvent,
  io: {
    readFile: (p: string) => Promise<string>
    appendFile: (p: string, data: string) => Promise<void>
    writeFile: (p: string, data: string) => Promise<void>
    mkdir: (dir: string, recursive: true) => Promise<void>
  } = {
    readFile: (p) =>
      fs.readFile(p, 'utf8').then((text) => {
        if (text === undefined) throw new Error('unreachable')
        return text
      }),
    appendFile: async (p, data) => {
      await fs.appendFile(p, data, 'utf8')
    },
    writeFile: async (p, data) => {
      await fs.writeFile(p, data, 'utf8')
    },
    mkdir: async (dir, recursive) => {
      await fs.mkdir(dir, { recursive })
    },
  },
): Promise<void> {
  const statePath = runStatePath(agentDir, event.ref)
  if (statePath === null) return
  const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
  const dir = path.dirname(statePath)
  await io.mkdir(dir, true)
  let state: FlowRunState | null = null
  try {
    const raw = await io.readFile(statePath)
    const parsed: unknown = JSON.parse(raw)
    if (isFlowRunState(parsed)) state = parsed
  } catch {
    // missing or corrupt projection — rebuild from the journal below
  }
  if (state === null) {
    // Rebuild from the journal so a deleted projection cannot lose history.
    const events: FlowRunEvent[] = []
    try {
      const journal = await io.readFile(journalPath)
      for (const line of journal.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          events.push(JSON.parse(trimmed) as FlowRunEvent)
        } catch {
          // torn tail line — skip
        }
      }
    } catch {
      // no journal yet — start fresh
    }
    state = projectRunState(events)
  }
  const next = applyEvent(state, event)
  if (next === state) return
  await io.appendFile(journalPath, `${JSON.stringify(event)}\n`)
  await io.writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`)
}

/** Read a run projection for display. Returns null when no run exists. */
export async function readRunState(
  agentDir: string,
  ref: string,
): Promise<FlowRunState | null> {
  const statePath = runStatePath(agentDir, ref)
  if (statePath === null) return null
  try {
    const raw = await fs.readFile(statePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isFlowRunState(parsed) ? parsed : null
  } catch {
    return null
  }
}
