// Durable interrupt intent watermark (PMR-J3WY).
//
// `subagent_interrupt` is replay-sensitive: after a parent restart pi may
// re-execute the same logical tool call (same toolCallId) from session
// history. Without a durable watermark the replay would send a second Escape
// to whatever turn the child is running NOW and create a second pending
// control request.
//
// The watermark is keyed by the logical tool call id and records the identity
// (childId + sessionFile) plus the requestId of the control record the first
// execution wrote. It is claimed BEFORE the Escape keypress (mark-before-send)
// so the dangerous window — escape sent, result unrecorded, restart — closes:
// a replay observes the watermark and returns an idempotent result instead of
// re-sending.
//
// AIDEV-NOTE: fail-closed identity validation — a watermark naming a different
// childId/sessionFile than the resolved target means the same logical call now
// points at different work; the interrupt is refused, never re-targeted.
// AIDEV-NOTE: crash between claim and Escape suppresses the replay too (the
// intent is durable even when the send never happened) — we optimize for
// never double-sending over never missing a send.
// AIDEV-NOTE: markers are deliberately never cleaned up (same policy as
// delivered.ts); they are single small files keyed by a unique toolCallId.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

export interface InterruptWatermark {
  toolCallId: string
  childId: string
  sessionFile: string
  requestId: string
  sentAt: string
}

function sanitizeToolCallId(toolCallId: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/** Durable watermark path: `<dataRoot>/interrupts/<toolCallId>.json`. */
export function interruptWatermarkPath(
  toolCallId: string,
  root?: string,
): string {
  return join(
    ensureSubagentsDataDir('interrupts', root ?? subagentsDataRoot()),
    `${sanitizeToolCallId(toolCallId)}.json`,
  )
}

/** Read a watermark; returns null when missing, malformed, or not an object. */
export function readInterruptWatermark(
  toolCallId: string,
  root?: string,
): InterruptWatermark | null {
  let raw: string
  try {
    raw = readFileSync(interruptWatermarkPath(toolCallId, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.toolCallId !== 'string') return null
    if (typeof record.childId !== 'string') return null
    if (typeof record.sessionFile !== 'string') return null
    if (typeof record.requestId !== 'string') return null
    return parsed as InterruptWatermark
  } catch {
    return null
  }
}

/** True when the watermark names this exact child and session file. */
export function interruptWatermarkMatches(
  watermark: InterruptWatermark,
  childId: string,
  sessionFile: string,
): boolean {
  return watermark.childId === childId && watermark.sessionFile === sessionFile
}

/**
 * Claim the watermark for a logical tool call. Exclusive create (atomic by
 * construction — same discipline as delivered.ts markers): returns true when
 * newly claimed (proceed with the send), false when it already exists (treat
 * as a replay and re-read it).
 */
export function claimInterruptWatermark(
  watermark: InterruptWatermark,
  root?: string,
): boolean {
  const marker = interruptWatermarkPath(watermark.toolCallId, root)
  mkdirSync(join(marker, '..'), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = openSync(marker, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(watermark))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}
