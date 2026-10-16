// Fire-and-forget child-to-owner messaging (PMR-QCVA).
// Durable records live at `<dataRoot>/inbox/<parentSessionId>/<childId>-<seq>.json`.
// The child's message_owner tool writes one and returns immediately; the
// parent's 1s status-refresh loop drains the inbox, coalesces all records
// from the tick into ONE `subagent_message` steer, and deletes each drained
// record afterwards.
//
// AIDEV-NOTE: at-least-once window — records are unlinked only AFTER the
// parent's sendMessage succeeds. A crash (or a stale pi instance after
// /reload) before the unlink re-delivers the same messages on the next tick
// (duplicate turn in the worst case). Mirrors the peers inbox discipline.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'
import { capStatusLines } from './status.ts'

export const MESSAGE_VERSION = 1
export const OWNER_MESSAGE_MAX_BYTES = 8192

export interface OwnerMessage {
  version: number
  messageId: string
  childId: string
  name?: string
  message: string
  sentAt: string
}

function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

function inboxBaseDir(root?: string): string {
  return ensureSubagentsDataDir('inbox', root ?? subagentsDataRoot())
}

export function ownerInboxDir(parentSessionId: string, root?: string): string {
  const dir = join(inboxBaseDir(root), sanitizeId(parentSessionId))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
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

function nextSeq(dir: string, childId: string): number {
  const prefix = `${sanitizeId(childId)}-`
  let max = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue
    const match = /^(\d+)\.json$/.exec(entry.slice(prefix.length))
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return max + 1
}

function messagePath(dir: string, childId: string, seq: number): string {
  return join(
    dir,
    `${sanitizeId(childId)}-${String(seq).padStart(6, '0')}.json`,
  )
}

/**
 * Write a durable message to the owner's inbox. Exclusive-create with retry
 * on the allocated seq so concurrent senders never overwrite each other.
 * Throws a clear error above the 8 KiB cap.
 */
export function sendOwnerMessage(params: {
  parentSessionId: string
  childId: string
  name?: string
  message: string
  root?: string
}): { path: string; messageId: string } {
  const record: OwnerMessage = {
    version: MESSAGE_VERSION,
    messageId: randomUUID(),
    childId: params.childId,
    message: params.message,
    sentAt: new Date().toISOString(),
  }
  if (params.name !== undefined) record.name = params.name
  const payload = JSON.stringify(record)
  const size = Buffer.byteLength(payload)
  if (size > OWNER_MESSAGE_MAX_BYTES) {
    throw new Error(
      `message is ${size} bytes; the owner-inbox cap is ${OWNER_MESSAGE_MAX_BYTES} bytes. Split or shorten the message.`,
    )
  }
  const dir = ownerInboxDir(params.parentSessionId, params.root)
  // AIDEV-NOTE: seq allocation + exclusive create — a concurrent sender that
  // wins the same seq bumps our attempt and we retry with the next number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seq = nextSeq(dir, params.childId)
    const path = messagePath(dir, params.childId, seq)
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { path, messageId: record.messageId }
  }
  throw new Error('owner-inbox contention: could not allocate a message slot')
}

/** An inbox file plus its parsed message (only structurally valid ones). */
export interface OwnerInboxEntry {
  path: string
  message: OwnerMessage
}

/** Read all valid owner-inbox messages, ordered by filename (seq). */
export function readOwnerInbox(
  parentSessionId: string,
  root?: string,
): OwnerInboxEntry[] {
  let entries: string[]
  const dir = ownerInboxDir(parentSessionId, root)
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const result: OwnerInboxEntry[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    try {
      if (statSync(path).isDirectory()) continue
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed == null || typeof parsed !== 'object') continue
      const candidate = parsed as Record<string, unknown>
      if (candidate.version !== MESSAGE_VERSION) continue
      if (typeof candidate.messageId !== 'string') continue
      if (typeof candidate.childId !== 'string') continue
      if (typeof candidate.message !== 'string') continue
      if (typeof candidate.sentAt !== 'string') continue
      result.push({ path, message: parsed as OwnerMessage })
    } catch {
      // Malformed / partially visible — never surfaced.
    }
  }
  return result
}

export function removeOwnerMessage(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

export interface CoalescedOwnerMessages {
  lines: string[]
  visibleLines: string[]
  overflow: number
}

/**
 * Pure coalescing + line-cap: one bullet per message, capped at lineLimit
 * with an overflow count (capStatusLines precedent). Returns the full lines
 * (for details) and the capped view.
 */
export function coalesceOwnerMessages(
  entries: OwnerInboxEntry[],
  lineLimit: number,
): CoalescedOwnerMessages {
  const lines = entries.map((entry) => {
    const who = entry.message.name || entry.message.childId
    const firstLine = entry.message.message.split('\n')[0]
    return `${who}: ${firstLine}`
  })
  const capped = capStatusLines(lines, lineLimit)
  return {
    lines,
    visibleLines: capped.visibleLines,
    overflow: capped.overflow,
  }
}

// AIDEV-NOTE: exported for tests — ids are filesystem path components.
export const __inboxInternals__ = { sanitizeId }
