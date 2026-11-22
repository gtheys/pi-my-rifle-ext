// AIDEV-NOTE (PMR-3QMY): public state-event contract for co-extensions.
//
// What this module is: the single source of truth for the
// `pi-my-rifle-subagents:state` channel payload. Pure module — no fs, no
// pi import, no globalThis. It only builds versioned event objects and
// hands them to an injected `{ emit }` bus; index.ts owns WHEN emissions
// happen (the durable/Map seams) and derives the entry list.
//
// Payload contract (HUMAN DECISION, Option A — minimal projection):
// each entry carries EXACTLY id / name / status, and the envelope carries
// EXACTLY type / version / incarnation / seq / emittedAt / agents. A
// key-set contract test pins this. Excluded from any payload: task prompt,
// message bodies, `cwd`, `sessionFile`, `activityFile`, `claim.pid`,
// paneId/tabId/workspaceId, worktree/branch paths, usage — anything
// beyond id/name/status per entry, and anything secret-ish or
// filesystem-detail-ish. Additive fields are a deliberate version-policy
// decision (v1 is additive-only: consumers MUST ignore unknown fields).
//
// Sequencer: `incarnation` is generated ONCE at module load and `seq` is a
// module-level 1-based counter. This is a DELIBERATE exception to the
// globalThis-survival pattern (RUNNING_KEY / flow-env.ts listener
// registry): we WANT a fresh incarnation per module load so `/reload`
// restarts the sequence. The sequencer must NOT move to globalThis. A
// cached module load continuing its incarnation is the safe direction —
// seq never reuses numbers within a live incarnation.
//
// Dual module instances: pi loads the extension entrypoint directly while
// co-extensions (pi-flow) import through the workspace package root — those
// can be distinct instances. Only the entrypoint instance wires emissions;
// consumers subscribe via `pi.events`, never via module imports.

import { randomUUID } from 'node:crypto'

/** Channel name for all subagent state events. */
export const SUBAGENT_STATE_CHANNEL = 'pi-my-rifle-subagents:state'

/**
 * Payload schema version. v1 is additive-only: consumers MUST ignore
 * unknown fields; publishers MAY add fields without bumping. Breaking
 * changes bump this constant.
 */
export const SUBAGENT_STATE_EVENT_VERSION = 1

/**
 * Mirror of `WidgetStateKind` (index.ts ~1000) / `AssignmentStatus`
 * (assignments.ts:24). Keep in sync with both.
 *
 * AIDEV-NOTE (PMR-3QMY) sync contract: `'lost'` is RESERVED — a lost child
 * is REMOVED from snapshots (settlement is the disappearance signal), so
 * it is never carried as a live status. It stays in the union so consumer
 * exhaustive switches are forward-stable.
 */
export type SubagentStateStatus =
  | 'starting'
  | 'working'
  | 'blocked'
  | 'waiting'
  | 'stalled'
  | 'lost'

/** Minimal public projection of one live subagent. */
export interface SubagentStateEntry {
  /** childId */
  id: string
  name: string
  status: SubagentStateStatus
}

/** Envelope published on SUBAGENT_STATE_CHANNEL. */
export interface SubagentStateEvent {
  type: 'snapshot' | 'stopped'
  version: 1
  /** UUID, per publisher module load. */
  incarnation: string
  /** 1-based, strictly monotonic within an incarnation. */
  seq: number
  /** ISO 8601. */
  emittedAt: string
  /** Snapshot entries sorted by id (the CALLER sorts); `[]` for 'stopped'. */
  agents: SubagentStateEntry[]
}

/** Minimal structural shape publishStateEvent needs from pi's EventBus. */
export interface StateEventBus {
  emit(channel: string, data: unknown): void
}

// Module-level sequencer (see AIDEV-NOTE header — must NOT move to
// globalThis). One incarnation per module load; seq increments per event.
const incarnation: string = randomUUID()
let seqCounter = 0

/** Next envelope field values from the sequencer (1-based, monotonic). */
function nextEnvelope(
  type: 'snapshot' | 'stopped',
  now?: number,
): SubagentStateEvent {
  seqCounter += 1
  let timestamp: number
  if (now === undefined) {
    timestamp = Date.now()
  } else {
    timestamp = now
  }
  return {
    type,
    version: SUBAGENT_STATE_EVENT_VERSION,
    incarnation,
    seq: seqCounter,
    emittedAt: new Date(timestamp).toISOString(),
    agents: [],
  }
}

/**
 * Build a full-snapshot event from the given entries.
 *
 * The entries are carried verbatim (same array reference and same element
 * identities) — the builder does NOT re-sort or copy. Callers derive the
 * list sorted by id (see `subagentStateEntries` in index.ts).
 */
export function buildSubagentStateSnapshot(
  entries: SubagentStateEntry[],
  now?: number,
): SubagentStateEvent {
  const event = nextEnvelope('snapshot', now)
  event.agents = entries
  return event
}

/** Build the terminal 'stopped' event (always `agents: []`). */
export function buildSubagentStateStopped(now?: number): SubagentStateEvent {
  return nextEnvelope('stopped', now)
}

/**
 * Best-effort publish — a missing/stale bus or a throwing `emit` must never
 * propagate into the status-maintenance path (spawn / tick / settle).
 * pi's EventBus already catches throwing subscribers; the try/catch here
 * additionally covers a stale bus object whose `emit` itself throws.
 */
export function publishStateEvent(
  bus: StateEventBus | null | undefined,
  event: SubagentStateEvent,
): void {
  if (!bus) return
  try {
    bus.emit(SUBAGENT_STATE_CHANNEL, event)
  } catch {
    // Isolation by design: state observation must never break execution.
  }
}
