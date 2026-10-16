// taskGraph-style aggregate snapshot for the status-refresh loop (PMR-YJC5).
// AIDEV-NOTE: ONE pass per tick folds durable records into a single
// childId-keyed snapshot instead of scattered per-child reads. New record
// types plug in by adding one fold step here — never a new per-tick read
// loop. Atomicity discipline is unchanged: records keep their atomic
// writers; this module only reads. Not a durable record type — a pure fold,
// rebuilt every tick.
//
// AIDEV-NOTE: folds are opt-in per consumer. The tick currently consumes
// only the owner-inbox fold (the drain input); the asks fold runs only when
// includeAsks is passed — an unconsumed per-tick fold is a readdir burned
// for nothing. Wire includeAsks in when a tick consumer for askPending
// arrives.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AskRecord } from './asks.ts'
import { asksDir } from './asks.ts'
import type { OwnerInboxEntry, OwnerMessage } from './inbox.ts'
import { MESSAGE_VERSION, ownerInboxDir } from './inbox.ts'

/** Injectable read surface so tests can count per-tick file reads. */
export interface SnapshotReadIo {
  readdir: (path: string) => string[]
  readFile: (path: string) => string
}

export const defaultSnapshotReadIo: SnapshotReadIo = {
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
}

export interface AggregateChildEntry {
  /** Parent session id this snapshot was folded for (inbox owner). */
  owner: string
  /** Durable ask record when the child is blocked-asking; null otherwise. */
  askPending: AskRecord | null
  /** Count of undrained owner-inbox messages from this child. */
  inboxPending: number
}

export interface AggregateSnapshot {
  children: Map<string, AggregateChildEntry>
  /** All undrained inbox entries, filename (seq) order — drain input. */
  inboxEntries: OwnerInboxEntry[]
  /** Debug metric: file reads this pass (readdir + readFile). */
  reads: number
}

function parseAskRecord(raw: string, childId: string): AskRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.askId !== 'string') return null
    if (record.childId !== childId) return null
    if (typeof record.question !== 'string') return null
    if (typeof record.sessionFile !== 'string') return null
    return parsed as AskRecord
  } catch {
    return null
  }
}

function parseInboxMessage(raw: string): OwnerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object') return null
    const candidate = parsed as Record<string, unknown>
    if (candidate.version !== MESSAGE_VERSION) return null
    if (typeof candidate.messageId !== 'string') return null
    if (typeof candidate.childId !== 'string') return null
    if (typeof candidate.message !== 'string') return null
    if (typeof candidate.sentAt !== 'string') return null
    return parsed as OwnerMessage
  } catch {
    return null
  }
}

/**
 * Fold all per-child ask + owner-inbox records into one snapshot in a single
 * pass: one readdir of asks/, one readdir of the owner's inbox dir, then one
 * read per existing record. Malformed records fail closed (omitted), matching
 * readAskRecord/readOwnerInbox semantics.
 */
export function buildAggregateSnapshot(params: {
  ownerSessionId: string
  childIds: readonly string[]
  root?: string
  io?: SnapshotReadIo
  /** Run the asks fold (one readdir + one read per present record). Only
   * enable when a consumer for askPending exists. */
  includeAsks?: boolean
}): AggregateSnapshot {
  const io = params.io ?? defaultSnapshotReadIo
  const root = params.root
  let reads = 0

  const children = new Map<string, AggregateChildEntry>()
  for (const childId of params.childIds) {
    children.set(childId, {
      owner: params.ownerSessionId,
      askPending: null,
      inboxPending: 0,
    })
  }

  // Fold 1 (opt-in): ask records — one readdir, then read only files present.
  if (params.includeAsks) {
    try {
      const dir = asksDir(root)
      reads += 1
      const seen = new Set(io.readdir(dir))
      for (const childId of params.childIds) {
        const entry = children.get(childId)
        if (!entry || entry.askPending) continue
        const fileName = `${childId}.json`
        if (!seen.has(fileName)) continue
        reads += 1
        entry.askPending = parseAskRecord(
          io.readFile(join(dir, fileName)),
          childId,
        )
      }
    } catch {
      // Missing asks dir — no pending asks; never fatal.
    }
  }

  // Fold 2: owner inbox — one readdir, one read per record, fold counts per child.
  const inboxEntries: OwnerInboxEntry[] = []
  try {
    const dir = ownerInboxDir(params.ownerSessionId, root)
    reads += 1
    const names = io.readdir(dir).sort()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      reads += 1
      const message = parseInboxMessage(io.readFile(path))
      if (!message) continue
      inboxEntries.push({ path, message })
      const entry = children.get(message.childId)
      if (entry) entry.inboxPending += 1
    }
  } catch {
    // Missing inbox dir — nothing pending.
  }

  return { children, inboxEntries, reads }
}
