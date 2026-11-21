// Durable per-logical-tool-call effect memo for child side-effect tools
// (PMR-ZJCP).
//
// Memo-after-effect discipline (delivered.ts PMR-KY0E precedent): a child
// tool handler performs its durable effect, THEN writes an exclusive-create
// memo keyed by a logical fingerprint of the call. On replay after an
// interrupted run, a memo hit means the earlier effect already happened and
// the handler returns the memoized result instead of repeating the effect.
//
// AIDEV-NOTE (PMR-ZJCP): mark-after-effect discipline — the memo is written
// only AFTER the durable effect succeeded, so a memo hit is trustworthy
// evidence of completion. Narrow send→mark crash windows are NOT covered by
// the memo alone; handlers consult the effect's own durable records (ask
// record, recipient inbox, .exit payload) as additional evidence. Memos are
// deliberately NEVER cleaned up — no wipe, no GC, no TTL — so they survive
// the PMR-WXG0 resume wipe (removeAskRecordsForSession) and remain the
// durable record of an interrupted child's effects forever.
import { createHash } from 'node:crypto'
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

export type ChildEffectTool =
  | 'ask_owner'
  | 'caller_ping'
  | 'subagent_done'
  | 'message_owner'
  | 'message_peer'

export interface ChildToolEffectMemo {
  version: 1
  childId: string
  tool: ChildEffectTool
  fingerprint: string
  createdAt: string
  result: Record<string, unknown>
}

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

// AIDEV-NOTE: canonical JSON — recursively sorted object keys, undefined
// values dropped — so pi-core param ordering can never split a fingerprint.
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const items: string[] = []
    for (const item of value) {
      if (item === undefined) {
        items.push('null')
      } else {
        items.push(canonicalJson(item))
      }
    }
    return `[${items.join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts: string[] = []
    for (const key of keys) {
      const member = record[key]
      if (member === undefined) continue
      parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`)
    }
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

/** sha256 over canonical JSON: recursively sorted keys, undefined dropped. */
export function effectFingerprint(
  tool: ChildEffectTool,
  childId: string,
  params: unknown,
): string {
  return createHash('sha256')
    .update(canonicalJson({ tool, childId, params }))
    .digest('hex')
}

/** Memo path: `<dataRoot>/tool-effects/<childId>/<tool>-<fingerprint>.json`. */
export function effectMemoPath(
  childId: string,
  tool: ChildEffectTool,
  fingerprint: string,
  root: string = subagentsDataRoot(),
): string {
  return join(
    ensureSubagentsDataDir('tool-effects', root),
    sanitizeChildId(childId),
    `${tool}-${fingerprint}.json`,
  )
}

/** Hand-rolled structural validator (never TypeBox for durable records). */
export function isChildToolEffectMemo(
  value: unknown,
): value is ChildToolEffectMemo {
  if (value == null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== 1) return false
  if (typeof record.childId !== 'string') return false
  if (
    record.tool !== 'ask_owner' &&
    record.tool !== 'caller_ping' &&
    record.tool !== 'subagent_done' &&
    record.tool !== 'message_owner' &&
    record.tool !== 'message_peer'
  ) {
    return false
  }
  if (typeof record.fingerprint !== 'string') return false
  if (typeof record.createdAt !== 'string') return false
  if (record.result == null || typeof record.result !== 'object') return false
  if (Array.isArray(record.result)) return false
  return true
}

/** Fail closed: null on missing or malformed (asks.ts readAskRecord style). */
export function readEffectMemo(
  childId: string,
  tool: ChildEffectTool,
  fingerprint: string,
  root?: string,
): ChildToolEffectMemo | null {
  let raw: string
  try {
    raw = readFileSync(effectMemoPath(childId, tool, fingerprint, root), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isChildToolEffectMemo(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Exclusive create (openSync 'wx', 0o600, write+fsync+close). Returns true
 * when newly written, false when the memo already exists (EEXIST).
 */
export function writeEffectMemo(
  memo: ChildToolEffectMemo,
  root?: string,
): boolean {
  const path = effectMemoPath(memo.childId, memo.tool, memo.fingerprint, root)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(memo))
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

// AIDEV-NOTE (PMR-ZJCP): atomic rewrite (tmp + fsync + rename, asks.ts
// atomicWrite shape) — used ONLY on the ask_owner orphan-fallback replay
// path, where a stale memo from a pre-wipe run must be replaced by the
// fresh ask's result. Exclusive create alone cannot express that update.
export function rewriteEffectMemo(
  memo: ChildToolEffectMemo,
  root?: string,
): void {
  const path = effectMemoPath(memo.childId, memo.tool, memo.fingerprint, root)
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  atomicWrite(path, JSON.stringify(memo))
}
