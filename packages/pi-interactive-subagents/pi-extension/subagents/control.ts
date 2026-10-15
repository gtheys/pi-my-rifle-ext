// Durable request/ack handshake for parent→child control ops (interrupt,
// answer). Ported from pi-herdsman's RequestRecord/lastAck discipline
// (Apache-2.0, mailbox.ts schema v5 essence), scoped down per plan PMR-DNPZ:
// the parent writes `<dataRoot>/asks/<childId>.control.json`, the child
// extension answers with an ack sidecar `<sessionFile>.ack`, and the parent's
// 1s status-refresh loop correlates the two.
//
// AIDEV-NOTE: at-least-once window — the escape keypress remains the actual
// delivery mechanism; the control record is durable INTENT so a future
// reattach (PMR-WXG0/Z5KR) can observe it. If the ack write is lost (child
// crash between abort and sidecar write), the parent expires the request and
// falls back to legacy fire-and-forget semantics — a stale record alone never
// re-applies a request today; any future re-apply path must correlate on
// requestId before acting.
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

export type ControlRequestKind = 'interrupt' | 'answer'

// Typed rejection codes, ported from herdsman's ack vocabulary. The child
// currently only ever emits 'idle' (turn aborted cleanly); the rest exist so
// future child-side gates (busy mid-tool, identity mismatch, ...) share one
// wire format instead of inventing strings later.
export type AckCode =
  | 'busy'
  | 'idle'
  | 'invalid'
  | 'identity'
  | 'ambiguous'
  | 'incompatible'

export interface ControlRecord {
  requestId: string
  childId: string
  sessionFile: string
  kind: ControlRequestKind
  payload: Record<string, unknown>
  sentAt: string
}

export interface ControlAck {
  requestId: string
  accepted: boolean
  code: AckCode
  message?: string
}

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/** Durable control record path: `<dataRoot>/asks/<childId>.control.json`. */
export function controlRecordPath(childId: string, root?: string): string {
  return join(
    ensureSubagentsDataDir('asks', root ?? subagentsDataRoot()),
    `${sanitizeChildId(childId)}.control.json`,
  )
}

/** Ack sidecar path, colocated with the child session file. */
export function ackSidecarPath(sessionFile: string): string {
  return `${sessionFile}.ack`
}

// AIDEV-NOTE: atomic write (tmp + fsync + rename) so the parent's 1s poller
// never observes a partial record. Latest intent wins — a second request for
// the same child overwrites the first; the superseded requestId then fails
// ack correlation and times out on the parent side.
export function writeControlRecord(record: ControlRecord, root?: string): void {
  const path = controlRecordPath(record.childId, root)
  const tmpPath = `${path}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(record))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

/** Read a control record; returns null when missing, malformed, or not an object. */
export function readControlRecord(
  childId: string,
  root?: string,
): ControlRecord | null {
  let raw: string
  try {
    raw = readFileSync(controlRecordPath(childId, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.requestId !== 'string') return null
    return parsed as ControlRecord
  } catch {
    return null
  }
}

export function removeControlRecord(childId: string, root?: string): void {
  try {
    unlinkSync(controlRecordPath(childId, root))
  } catch {}
}

/** Child side: write the ack sidecar. Best-effort callers wrap in try/catch. */
export function writeAckSidecar(sessionFile: string, ack: ControlAck): void {
  writeFileSync(ackSidecarPath(sessionFile), JSON.stringify(ack))
}

/** Parent side: read the ack sidecar; null when missing or malformed. */
export function readAckSidecar(sessionFile: string): ControlAck | null {
  try {
    const parsed = JSON.parse(
      readFileSync(ackSidecarPath(sessionFile), 'utf8'),
    ) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const ack = parsed as Record<string, unknown>
    if (typeof ack.requestId !== 'string') return null
    if (typeof ack.accepted !== 'boolean') return null
    return parsed as ControlAck
  } catch {
    return null
  }
}

export function removeAckSidecar(sessionFile: string): void {
  try {
    unlinkSync(ackSidecarPath(sessionFile))
  } catch {}
}

/**
 * Identity revalidation before an ack is applied (herdsman discipline): the
 * ack must carry the requestId we sent, and the control record must still
 * name the childId + sessionFile we are polling. A mismatched or wrong-id ack
 * is ignored, never guessed from.
 */
export function ackMatches(params: {
  record: ControlRecord
  ack: ControlAck
  childId: string
  sessionFile: string
}): boolean {
  return (
    params.record.requestId === params.ack.requestId &&
    params.record.childId === params.childId &&
    params.record.sessionFile === params.sessionFile
  )
}

// AIDEV-NOTE: completion ack = the existing `.exit` sidecar. A child that
// exits between request and ack needs no new machinery: the watcher observes
// `.exit`/`.code` as today and closes the entry; the pending request simply
// times out and any leftover control record is residue (single small file,
// harmless). Do not build a separate completion-ack protocol.
