// Durable ask/answer records for the blocking ask_owner flow (PMR-WXG0).
// A child writes `asks/<childId>.json` + a `<sessionFile>.ask` sidecar when it
// asks its owner mid-run; the parent's answer_subagent tool validates identity,
// writes `asks/<childId>.reply.json`, delivers the reply into the live pane,
// and only then deletes the `.ask` sidecar.
//
// AIDEV-NOTE: at-least-once window — the reply record is written BEFORE pane
// delivery. If delivery partially fails (keystrokes lost, pane died), the
// durable record enables a retry via answer_subagent; a retry re-delivers the
// same message (duplicate user turn in the worst case). The `.ask` sidecar is
// deleted only after successful delivery, so it is the "still pending" marker.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

export interface AskRecord {
  askId: string
  childId: string
  name?: string
  question: string
  files?: string[]
  sessionFile: string
  createdAt: string
}

export interface AskReplyRecord {
  askId: string
  message: string
  repliedAt: string
}

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/** Durable ask record path: `<dataRoot>/asks/<childId>.json`. */
export function askRecordPath(childId: string, root?: string): string {
  return join(
    ensureSubagentsDataDir('asks', root ?? subagentsDataRoot()),
    `${sanitizeChildId(childId)}.json`,
  )
}

/** Durable reply record path: `<dataRoot>/asks/<childId>.reply.json`. */
export function replyRecordPath(childId: string, root?: string): string {
  return join(
    ensureSubagentsDataDir('asks', root ?? subagentsDataRoot()),
    `${sanitizeChildId(childId)}.reply.json`,
  )
}

/** Ask sidecar path, colocated with the child session file. */
export function askSidecarPath(sessionFile: string): string {
  return `${sessionFile}.ask`
}

function atomicWrite(path: string, contents: string): void {
  const tmpPath = `${path}.${process.pid}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

// AIDEV-NOTE: atomic write (tmp + fsync + rename) so the parent's 1s poller
// never observes a partial ask record.
export function writeAskRecord(record: AskRecord, root?: string): void {
  atomicWrite(askRecordPath(record.childId, root), JSON.stringify(record))
}

/** Read an ask record; null when missing or malformed (fail closed). */
export function readAskRecord(
  childId: string,
  root?: string,
): AskRecord | null {
  let raw: string
  try {
    raw = readFileSync(askRecordPath(childId, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.askId !== 'string') return null
    if (typeof record.childId !== 'string') return null
    if (typeof record.question !== 'string') return null
    if (typeof record.sessionFile !== 'string') return null
    return parsed as AskRecord
  } catch {
    return null
  }
}

export function removeAskRecord(childId: string, root?: string): void {
  try {
    unlinkSync(askRecordPath(childId, root))
  } catch {}
}

/** Child side: write the `.ask` sidecar. */
export function writeAskSidecar(sessionFile: string, askId: string): void {
  atomicWrite(askSidecarPath(sessionFile), JSON.stringify({ askId }))
}

/** Parent side: read the `.ask` sidecar; null when missing or malformed. */
export function readAskSidecar(sessionFile: string): { askId: string } | null {
  try {
    const parsed = JSON.parse(
      readFileSync(askSidecarPath(sessionFile), 'utf8'),
    ) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const sidecar = parsed as Record<string, unknown>
    if (typeof sidecar.askId !== 'string') return null
    return parsed as { askId: string }
  } catch {
    return null
  }
}

/**
 * Parent-owned cleanup — only the answer path deletes the sidecar, never the
 * child (herdsman discipline: each side owns its half of the protocol).
 */
export function removeAskSidecar(sessionFile: string): void {
  try {
    unlinkSync(askSidecarPath(sessionFile))
  } catch {}
}

/** Durable reply record, written before pane delivery (see file header). */
export function writeReplyRecord(
  childId: string,
  reply: AskReplyRecord,
  root?: string,
): void {
  atomicWrite(replyRecordPath(childId, root), JSON.stringify(reply))
}

export function readReplyRecord(
  childId: string,
  root?: string,
): AskReplyRecord | null {
  try {
    const parsed = JSON.parse(
      readFileSync(replyRecordPath(childId, root), 'utf8'),
    ) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const reply = parsed as Record<string, unknown>
    if (typeof reply.askId !== 'string') return null
    if (typeof reply.message !== 'string') return null
    return parsed as AskReplyRecord
  } catch {
    return null
  }
}

export function removeReplyRecord(childId: string, root?: string): void {
  try {
    unlinkSync(replyRecordPath(childId, root))
  } catch {}
}

/**
 * Identity revalidation before an answer is applied: the (optional) askId must
 * match the record's, and the record must name the childId + sessionFile the
 * caller is talking to. A mismatch is refused, never guessed from.
 */
export function askIdentityMatches(params: {
  record: AskRecord
  askId?: string
  childId: string
  sessionFile: string
}): boolean {
  if (params.record.childId !== params.childId) return false
  if (params.record.sessionFile !== params.sessionFile) return false
  if (params.askId != null && params.record.askId !== params.askId) return false
  return true
}

/**
 * Cleanup for resume/retry paths: ask records are keyed by childId, which a
 * resuming parent does not know — scan the asks dir and drop records (and
 * reply records) whose sessionFile matches. Returns removed ask-record count.
 */
export function removeAskRecordsForSession(
  sessionFile: string,
  root?: string,
): number {
  const dir = ensureSubagentsDataDir('asks', root ?? subagentsDataRoot())
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.reply.json')) continue
    const childId = entry.slice(0, -'.json'.length)
    const record = readAskRecord(childId, root)
    if (!record || record.sessionFile !== sessionFile) continue
    removeAskRecord(childId, root)
    removeReplyRecord(childId, root)
    removed += 1
  }
  return removed
}

/** Allocate a fresh ask id (exported for tests). */
export function newAskId(): string {
  return randomUUID()
}

// AIDEV-NOTE: exported for tests — childId is a filesystem path component.
export const __asksInternals__ = { sanitizeChildId }
