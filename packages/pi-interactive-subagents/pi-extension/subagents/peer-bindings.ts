// Durable per-logical-send recipient binding for message_peer (PMR-77KT).
//
// Bind-before-send discipline: when a child resolves a peer name to a
// concrete recipient (childId + session file) and is about to deliver to
// its inbox, it first writes an exclusive-create binding record keyed by
// the SAME logical fingerprint the effect memo uses. On replay after an
// interrupted run, the binding pins the logical send to its original
// recipient: a replayed call can never re-resolve a reused peer name to a
// newer generation. If the bound recipient has died or been superseded,
// the handler fails closed (throws, no retarget) instead of delivering to
// a different child — the effect either already happened (provable from
// the bound inbox) or stays pinned to its original target forever.
//
// AIDEV-NOTE (PMR-77KT): writePeerBinding happens BEFORE the inbox write
// (durable-first, ask_owner record-before-sidecar precedent) and only the
// first write wins (EEXIST ⇒ replay takes the bound path). Records are
// never deleted — they are the durable record of which recipient a
// logical send belongs to, surviving the PMR-WXG0 resume wipe.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

export interface PeerRecipientBinding {
  version: 1
  childId: string // sender
  fingerprint: string // logical send key (effectFingerprint('message_peer', ...))
  toChildId: string // bound recipient generation
  toSessionFile: string // bound recipient session file (supersession check)
  toName: string // display name at bind time (result/error text)
  request: { peer: string; message: string; resultRef?: string } // request identity
  createdAt: string
  lastActivityAt: string
}

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/**
 * Binding path:
 * `<dataRoot>/peer-bindings/<senderChildId>/<fingerprint>.json`.
 */
export function peerBindingPath(
  childId: string,
  fingerprint: string,
  root: string = subagentsDataRoot(),
): string {
  return join(
    ensureSubagentsDataDir('peer-bindings', root),
    sanitizeChildId(childId),
    `${fingerprint}.json`,
  )
}

/** Hand-rolled structural validator (never TypeBox for durable records). */
export function isPeerRecipientBinding(
  value: unknown,
): value is PeerRecipientBinding {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== 1) return false
  if (typeof record.childId !== 'string') return false
  if (typeof record.fingerprint !== 'string') return false
  if (typeof record.toChildId !== 'string') return false
  if (typeof record.toSessionFile !== 'string') return false
  if (typeof record.toName !== 'string') return false
  if (record.request == null || typeof record.request !== 'object') return false
  if (Array.isArray(record.request)) return false
  const request = record.request as Record<string, unknown>
  if (typeof request.peer !== 'string') return false
  if (typeof request.message !== 'string') return false
  if (
    request.resultRef !== undefined &&
    typeof request.resultRef !== 'string'
  ) {
    return false
  }
  if (typeof record.createdAt !== 'string') return false
  if (typeof record.lastActivityAt !== 'string') return false
  return true
}

/** Fail closed: null on missing or malformed (tool-effects readEffectMemo style). */
export function readPeerBinding(
  childId: string,
  fingerprint: string,
  root?: string,
): PeerRecipientBinding | null {
  let raw: string
  try {
    raw = readFileSync(peerBindingPath(childId, fingerprint, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isPeerRecipientBinding(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Exclusive create (openSync 'wx', 0o600, write+fsync+close). Returns true
 * when newly written, false when a binding already exists (EEXIST).
 */
export function writePeerBinding(
  binding: PeerRecipientBinding,
  root?: string,
): boolean {
  const path = peerBindingPath(binding.childId, binding.fingerprint, root)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(binding))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
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

// AIDEV-NOTE (PMR-77KT): atomic touch (tmp + fsync + rename, tool-effects
// atomicWrite shape) advancing ONLY lastActivityAt — every other field,
// including the bound recipient and request identity, stays byte-identical.
// Best-effort by contract: handlers call it AFTER writeEffectMemo, so a
// throwing touch would surface a tool error for an already-completed send.
// All failures (EACCES, ENOSPC, read-only fs) are swallowed here — a stale
// lastActivityAt never justifies breaking a send; a leftover .tmp sibling is
// harmless (same shape as the atomicWrite in peers.ts).
export function touchPeerBinding(
  binding: PeerRecipientBinding,
  root?: string,
): void {
  try {
    const path = peerBindingPath(binding.childId, binding.fingerprint, root)
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
    const touched: PeerRecipientBinding = {
      ...binding,
      lastActivityAt: new Date().toISOString(),
    }
    atomicWrite(path, JSON.stringify(touched))
  } catch {
    // Best-effort: see the AIDEV-NOTE above.
  }
}
