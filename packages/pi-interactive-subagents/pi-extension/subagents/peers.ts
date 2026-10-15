// Peer-to-peer messaging between same-role live subagents (PMR-98S6).
// Presence records `<dataRoot>/peers/<childId>.json` name the child's process
// lock claim; a record is VALID only while its claim is the live generation of
// the lock keyed on the child's session file (dead pid or superseded claim ⇒
// filtered). Messages land in a durable per-child inbox
// `<dataRoot>/peers/<childId>/inbox/<seq>.json`; the recipient's pump
// delivers them as new turns and deletes them afterwards.
//
// AIDEV-NOTE: at-least-once window — inbox messages are unlinked only AFTER
// sendMessage succeeds child-side. A crash before the unlink re-delivers the
// same message on the next pump tick (duplicate turn in the worst case).
// herdr pane/tab ids are display metadata only; identity correlates on
// childId + sessionFile (herdsman divergence #3 in the plan).
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
import { basename, join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'
import {
  acquireProcessLock,
  isProcessLockClaim,
  keyedProcessLockPath,
  type ProcessLockClaim,
  readProcessLockStatus,
} from './lock.ts'

const PRESENCE_VERSION = 1
const MESSAGE_VERSION = 1
export const PRESENCE_MAX_BYTES = 4096
export const MESSAGE_MAX_BYTES = 8192

export interface PeerPresence {
  version: number
  childId: string
  sessionId: string
  sessionFile: string
  name: string
  agent?: string
  cwd: string
  surface?: string
  claim: ProcessLockClaim
  updatedAt: string
}

export interface PeerMessage {
  version: number
  messageId: string
  from: { childId: string; name?: string; agent?: string }
  message: string
  resultRef?: string
  sentAt: string
}

/** Process lock key for a child's peer presence claim. */
export function peerLockKey(sessionFile: string): string {
  return `pi-subagents-peer:${sessionFile}`
}

export function peerLockPath(sessionFile: string): string {
  return keyedProcessLockPath(peerLockKey(sessionFile))
}

function peersDir(root?: string): string {
  return ensureSubagentsDataDir('peers', root ?? subagentsDataRoot())
}

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

export function presencePath(childId: string, root?: string): string {
  return join(peersDir(root), `${sanitizeChildId(childId)}.json`)
}

export function inboxDir(childId: string, root?: string): string {
  const dir = join(peersDir(root), sanitizeChildId(childId), 'inbox')
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

/** Structural validation of a presence record (fail closed). */
export function isPeerPresence(value: unknown): value is PeerPresence {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== PRESENCE_VERSION) return false
  if (typeof record.childId !== 'string' || record.childId === '') return false
  if (typeof record.sessionId !== 'string') return false
  if (typeof record.sessionFile !== 'string' || record.sessionFile === '') {
    return false
  }
  if (typeof record.name !== 'string') return false
  if (typeof record.cwd !== 'string') return false
  if (typeof record.updatedAt !== 'string') return false
  if (!isProcessLockClaim(record.claim)) return false
  return true
}

export function readPresence(
  childId: string,
  root?: string,
): PeerPresence | null {
  let raw: string
  try {
    raw = readFileSync(presencePath(childId, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPeerPresence(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A presence record is valid only while its claim is the live generation of
 * the lock keyed on the child's session file. Dead pid ⇒ not live; stale
 * takeover ⇒ different claim id. Both fail closed.
 */
export function presenceIsLive(record: PeerPresence, root?: string): boolean {
  let status: { claim: ProcessLockClaim; live: boolean }
  try {
    status = readProcessLockStatus(peerLockPath(record.sessionFile))
  } catch {
    return false
  }
  if (!status.live) return false
  return (
    status.claim.pid === record.claim.pid && status.claim.id === record.claim.id
  )
}

export interface ChildIdentity {
  childId: string
  sessionFile: string
  name: string
  agent?: string
  surface?: string
  cwd?: string
}

function sessionIdFromSessionFile(sessionFile: string): string {
  const base = basename(sessionFile)
  if (base.endsWith('.jsonl')) return base.slice(0, -'.jsonl'.length)
  return base
}

/**
 * Acquire this child's presence lock and publish its presence record. The
 * caller owns the returned release function (call on session shutdown).
 * Throws if the serialized record exceeds the 4 KiB cap.
 */
export function publishPresence(
  identity: ChildIdentity,
  root?: string,
): () => void {
  // acquireProcessLock is imported at top level; it throws on contention.
  const lease = acquireProcessLock(peerLockPath(identity.sessionFile), {
    name: 'peer presence lock',
  })
  const record: PeerPresence = {
    version: PRESENCE_VERSION,
    childId: identity.childId,
    sessionId: sessionIdFromSessionFile(identity.sessionFile),
    sessionFile: identity.sessionFile,
    name: identity.name,
    cwd: identity.cwd ?? process.cwd(),
    claim: lease.claim,
    updatedAt: new Date().toISOString(),
  }
  if (identity.agent !== undefined) record.agent = identity.agent
  if (identity.surface !== undefined) record.surface = identity.surface
  const payload = JSON.stringify(record)
  if (Buffer.byteLength(payload) > PRESENCE_MAX_BYTES) {
    lease.release()
    throw new Error(
      `presence record exceeds ${PRESENCE_MAX_BYTES} bytes — refusing to publish`,
    )
  }
  atomicWrite(presencePath(identity.childId, root), payload)
  return () => {
    try {
      unlinkSync(presencePath(identity.childId, root))
    } catch {}
    lease.release()
  }
}

export interface PeerListEntry {
  childId: string
  sessionId: string
  sessionFile: string
  name: string
  agent?: string
  cwd: string
  surface?: string
  self: boolean
}

/**
 * Scan the peers dir, filter dead/stale/malformed records, return live peers
 * (plus self, marked). This child's own record is included even before its
 * lock status is re-verified — it holds the lease by definition.
 */
export function listLivePeers(
  identity: ChildIdentity,
  root?: string,
): PeerListEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(peersDir(root))
  } catch {
    return []
  }
  const result: PeerListEntry[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const childId = entry.slice(0, -'.json'.length)
    const record = readPresence(childId, root)
    if (!record) continue
    const isSelf = record.childId === identity.childId
    if (!isSelf && !presenceIsLive(record, root)) continue
    const listItem: PeerListEntry = {
      childId: record.childId,
      sessionId: record.sessionId,
      sessionFile: record.sessionFile,
      name: record.name,
      cwd: record.cwd,
      self: isSelf,
    }
    if (record.agent !== undefined) listItem.agent = record.agent
    if (record.surface !== undefined) listItem.surface = record.surface
    result.push(listItem)
  }
  return result
}

/**
 * Resolve a peer reference (childId or name) to a LIVE presence record.
 * Self is resolvable too — messaging yourself is legal (the pump delivers it).
 */
export function resolvePeer(
  peer: string,
  identity: ChildIdentity,
  root?: string,
): PeerListEntry {
  const peers = listLivePeers(identity, root)
  const matches = peers.filter((p) => p.childId === peer || p.name === peer)
  if (matches.length === 0) {
    throw new Error(
      `No live peer found for "${peer}". Call list_peers to see who is available.`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Peer reference "${peer}" is ambiguous (${matches.length} matches). Use the childId instead.`,
    )
  }
  return matches[0]
}

function nextInboxSeq(dir: string): number {
  let max = 0
  for (const entry of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(entry)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return max + 1
}

function inboxMessagePath(dir: string, seq: number): string {
  return join(dir, `${String(seq).padStart(6, '0')}.json`)
}

/**
 * Write a durable inbox message to the recipient. Exclusive-create with
 * retry on the allocated seq so two concurrent senders never overwrite each
 * other. Throws a clear error above the 8 KiB cap.
 */
export function sendPeerMessage(params: {
  toChildId: string
  from: ChildIdentity
  message: string
  resultRef?: string
  root?: string
}): { path: string; messageId: string } {
  const record: PeerMessage = {
    version: MESSAGE_VERSION,
    messageId: randomUUID(),
    from: {
      childId: params.from.childId,
      name: params.from.name,
      agent: params.from.agent,
    },
    message: params.message,
    sentAt: new Date().toISOString(),
  }
  if (params.resultRef !== undefined) record.resultRef = params.resultRef
  const payload = JSON.stringify(record)
  const size = Buffer.byteLength(payload)
  if (size > MESSAGE_MAX_BYTES) {
    throw new Error(
      `message is ${size} bytes; the inbox cap is ${MESSAGE_MAX_BYTES} bytes. Split or shorten the message.`,
    )
  }
  const dir = inboxDir(params.toChildId, params.root)
  // AIDEV-NOTE: seq allocation + exclusive create — a concurrent sender that
  // wins the same seq bumps our attempt and we retry with the next number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seq = nextInboxSeq(dir)
    const path = inboxMessagePath(dir, seq)
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
  throw new Error('inbox contention: could not allocate a message slot')
}

/** An inbox file plus its parsed message (only structurally valid ones). */
export interface InboxEntry {
  path: string
  message: PeerMessage
}

/** Read all valid inbox messages for a child, ordered by seq. */
export function readInbox(childId: string, root?: string): InboxEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(inboxDir(childId, root))
  } catch {
    return []
  }
  const result: InboxEntry[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue
    const path = join(inboxDir(childId, root), entry)
    try {
      if (statSync(path).isDirectory()) continue
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed == null || typeof parsed !== 'object') continue
      const candidate = parsed as Record<string, unknown>
      if (candidate.version !== MESSAGE_VERSION) continue
      if (typeof candidate.messageId !== 'string') continue
      if (typeof candidate.message !== 'string') continue
      if (typeof candidate.sentAt !== 'string') continue
      const from = candidate.from
      if (from == null || typeof from !== 'object') continue
      if (typeof (from as Record<string, unknown>).childId !== 'string')
        continue
      result.push({ path, message: parsed as PeerMessage })
    } catch {
      // Malformed / partially visible — never surfaced.
    }
  }
  return result
}

export function removeInboxEntry(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

// AIDEV-NOTE: exported for tests — childId is a filesystem path component.
export const __peersInternals__ = { sanitizeChildId }
