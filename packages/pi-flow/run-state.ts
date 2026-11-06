// AIDEV-NOTE: Flow run-state journal (PMR follow-up, ported from
// pi-workflows' "durable run state" idea). Aven labels stay the gate source
// of truth; this journal is the *evidence record* — append-only JSONL events
// plus a current-state projection, written under
// getAgentDir()/pi-flow/runs/<ref>.json (+ .journal.jsonl).
// The Herdr flow viewer renders the projection WITHOUT touching aven.

import { promises as fs } from 'node:fs'
import path from 'node:path'

// AIDEV-NOTE: PMR-Z2K7 — 'research' left the flow lifecycle (PIV); old
// journals containing research phases fail isFlowRunState and are rebuilt
// from the journal, whose unknown events are simply ignored by projection.
export type FlowPhase = 'plan' | 'implement' | 'validate' | 'feedback'

// AIDEV-NOTE: PMR-6EEW gate integrity — journal event kinds for pinned gate
// targets and the decisions that cite them. gate-target is recorded when a
// gate spawns (pin at spawn); gate-decision when its verdict is accepted,
// rejected or invalidated (echo missing / target mismatch / stale).
export type GateJournalKind =
  | 'review'
  | 'deviation'
  | 'code-review'
  | 'spec-review'

export type GateDecisionStatus =
  | 'pass'
  | 'fail'
  | 'echo-missing'
  | 'target-mismatch'
  | 'stale'

export type FlowRunEvent =
  | {
      kind: 'run-start'
      at: string
      ref: string
      mode: 'work' | 'personal'
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
      kind: 'gate-target'
      at: string
      ref: string
      gate: GateJournalKind
      targetId: string
      baseSha: string
      headSha: string
      diffSha256: string
    }
  | {
      kind: 'gate-decision'
      at: string
      ref: string
      gate: GateJournalKind
      targetId: string
      status: GateDecisionStatus
    }
  | {
      /** AIDEV-NOTE: PMR-6EEW per-subtask ranges — subtask → commits map */
      kind: 'subtask-ranges'
      at: string
      ref: string
      gate: GateJournalKind
      baseSha: string
      headSha: string
      bySubtask: Array<{ subtask: string; commits: string[] }>
      unattributed: string[]
    }
  | {
      kind: 'note'
      at: string
      ref: string
      text: string
    }

export interface GateTargetRecord {
  targetId: string
  gate: GateJournalKind
  baseSha: string
  headSha: string
  diffSha256: string
  at: string
}

export interface GateDecisionRecord {
  targetId: string
  gate: GateJournalKind
  status: GateDecisionStatus
  at: string
}

export type FlowRunState = {
  schema: 'gtheys.pi-flow.run.v1'
  ref: string
  mode: 'work' | 'personal'
  startedAt: string
  updatedAt: string
  completedPhases: FlowPhase[]
  currentPhase: FlowPhase | null
  notes: { at: string; text: string }[]
  // AIDEV-NOTE: PMR-6EEW — optional so pre-gate-integrity projections (and
  // journals rebuilt without gate events) stay valid.
  gateTargets?: GateTargetRecord[]
  gateDecisions?: GateDecisionRecord[]
  subtaskRanges?: SubtaskRangesRecord[]
}

export interface SubtaskRangesRecord {
  gate: GateJournalKind
  baseSha: string
  headSha: string
  bySubtask: Array<{ subtask: string; commits: string[] }>
  unattributed: string[]
  at: string
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
        startedAt: event.at,
        updatedAt: event.at,
        completedPhases: [],
        currentPhase: null,
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
    case 'gate-target': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const targets = state.gateTargets ?? []
      // idempotent by targetId — the same pin re-recorded is a no-op
      if (targets.some((t) => t.targetId === event.targetId)) return state
      return {
        ...state,
        gateTargets: [
          ...targets,
          {
            targetId: event.targetId,
            gate: event.gate,
            baseSha: event.baseSha,
            headSha: event.headSha,
            diffSha256: event.diffSha256,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'gate-decision': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      const decisions = state.gateDecisions ?? []
      return {
        ...state,
        gateDecisions: [
          ...decisions,
          {
            targetId: event.targetId,
            gate: event.gate,
            status: event.status,
            at: event.at,
          },
        ],
        updatedAt: event.at,
      }
    }
    case 'subtask-ranges': {
      if (state === null || state.ref !== event.ref)
        return state as FlowRunState
      return {
        ...state,
        subtaskRanges: [
          ...(state.subtaskRanges ?? []),
          {
            gate: event.gate,
            baseSha: event.baseSha,
            headSha: event.headSha,
            bySubtask: event.bySubtask,
            unattributed: event.unattributed,
            at: event.at,
          },
        ],
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
  'plan',
  'implement',
  'validate',
  'feedback',
]

const GATE_KINDS: readonly GateJournalKind[] = [
  'review',
  'deviation',
  'code-review',
  'spec-review',
]

const GATE_STATUSES: readonly GateDecisionStatus[] = [
  'pass',
  'fail',
  'echo-missing',
  'target-mismatch',
  'stale',
]

export function isFlowRunState(value: unknown): value is FlowRunState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.schema !== SCHEMA) return false
  if (typeof v.ref !== 'string') return false
  if (v.mode !== 'work' && v.mode !== 'personal') return false
  if (typeof v.startedAt !== 'string') return false
  if (typeof v.updatedAt !== 'string') return false
  if (!Array.isArray(v.completedPhases)) return false
  if (!v.completedPhases.every((p) => PHASES.includes(p as FlowPhase)))
    return false
  const current = v.currentPhase
  if (current !== null && !PHASES.includes(current as FlowPhase)) return false
  if (!Array.isArray(v.notes)) return false
  const notesOk = v.notes.every(
    (n) =>
      typeof n === 'object' &&
      n !== null &&
      typeof (n as Record<string, unknown>).at === 'string' &&
      typeof (n as Record<string, unknown>).text === 'string',
  )
  if (!notesOk) return false
  // AIDEV-NOTE: PMR-6EEW — optional arrays validated only when present.
  if (v.gateTargets !== undefined) {
    if (!Array.isArray(v.gateTargets)) return false
    const targetsOk = v.gateTargets.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Record<string, unknown>).targetId === 'string' &&
        GATE_KINDS.includes(
          (t as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        typeof (t as Record<string, unknown>).baseSha === 'string' &&
        typeof (t as Record<string, unknown>).headSha === 'string' &&
        typeof (t as Record<string, unknown>).diffSha256 === 'string' &&
        typeof (t as Record<string, unknown>).at === 'string',
    )
    if (!targetsOk) return false
  }
  if (v.gateDecisions !== undefined) {
    if (!Array.isArray(v.gateDecisions)) return false
    const decisionsOk = v.gateDecisions.every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as Record<string, unknown>).targetId === 'string' &&
        GATE_KINDS.includes(
          (d as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        GATE_STATUSES.includes(
          (d as Record<string, unknown>).status as GateDecisionStatus,
        ) &&
        typeof (d as Record<string, unknown>).at === 'string',
    )
    if (!decisionsOk) return false
  }
  // AIDEV-NOTE: PMR-6EEW per-subtask ranges — optional, validated when present.
  if (v.subtaskRanges !== undefined) {
    if (!Array.isArray(v.subtaskRanges)) return false
    const rangesOk = v.subtaskRanges.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        GATE_KINDS.includes(
          (r as Record<string, unknown>).gate as GateJournalKind,
        ) &&
        typeof (r as Record<string, unknown>).baseSha === 'string' &&
        typeof (r as Record<string, unknown>).headSha === 'string' &&
        Array.isArray((r as Record<string, unknown>).bySubtask) &&
        Array.isArray((r as Record<string, unknown>).unattributed) &&
        typeof (r as Record<string, unknown>).at === 'string',
    )
    if (!rangesOk) return false
  }
  return true
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
