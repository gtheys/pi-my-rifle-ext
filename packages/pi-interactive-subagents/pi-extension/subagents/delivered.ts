// Exactly-once mailbox delivery dedup (PMR-KY0E).
//
// Each durable mailbox record (ask replies, owner-inbox messages, peer-inbox
// messages, control requests) carries a requestId. Drains consult this set
// BEFORE injecting the turn and mark the id after a successful send, so a
// crash between send and record-unlink suppresses the redelivery.
//
// AIDEV-NOTE: marker-file set (store.ts reservation precedent) — a delivered
// id is an exclusive-create marker under
// <dataRoot>/delivered/<scope>/<requestId>. Exclusive create is atomic by
// construction, so no read-modify-write discipline is needed. Markers are
// deliberately never cleaned up (same policy as result-ref-reservations).
// Legacy records: every record version currently validated by the readers
// (asks askId, inbox/peers messageId, control requestId) already carries an
// id, so there is no pre-dedup shape to migrate — a missing id fails closed
// in the readers as before.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

function sanitizeScope(scope: string): string {
  const safe = scope.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/** Marker path for a delivered requestId within a scope. */
export function deliveredMarkerPath(
  scope: string,
  requestId: string,
  root: string = subagentsDataRoot(),
): string {
  return join(
    ensureSubagentsDataDir('delivered', root),
    sanitizeScope(scope),
    sanitizeScope(requestId),
  )
}

/** True when this requestId was already marked delivered in this scope. */
export function hasDelivered(
  scope: string,
  requestId: string,
  root: string = subagentsDataRoot(),
): boolean {
  return existsSync(deliveredMarkerPath(scope, requestId, root))
}

/**
 * Mark a requestId delivered. Returns true when newly marked (deliver it),
 * false when it was already marked (suppress the redelivery).
 */
export function markDelivered(
  scope: string,
  requestId: string,
  root: string = subagentsDataRoot(),
): boolean {
  const marker = deliveredMarkerPath(scope, requestId, root)
  mkdirSync(join(marker, '..'), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = openSync(marker, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, '1')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}
