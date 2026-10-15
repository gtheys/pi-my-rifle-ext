// Durable result store for subagent results. Ported from pi-herdsman
// storage mechanics (Apache-2.0, ADR 0001): results live as atomic JSON
// records under <dataRoot>/results/, semantic refs `result:<name>#<n>` are
// reserved via exclusive-create marker files under
// <dataRoot>/result-ref-reservations/<name>/<n> — monotonic per name, never
// reused, safe across concurrent allocators and parent sessions.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'
import type { UsageTotals } from './usage.ts'

// AIDEV-NOTE: per-kind byte ceiling on a serialized result record (herdsman
// discipline). 1 MiB is generous for a final summary; anything larger is
// rejected (fail closed) rather than truncated, so callers can fall back to
// inline delivery without silently losing content.
export const MAX_RESULT_RECORD_BYTES = 1024 * 1024

export interface ResultRecord {
  canonicalId: string
  childId: string
  name: string
  summary: string
  sessionFile: string | null
  artifactPaths: string[]
  /** Session-accumulated token/cost totals (PMR-874G), recorded at settlement. */
  usage?: UsageTotals
  createdAt: string
}

export interface ResultRefBinding {
  ref: string
  canonicalId: string
}

export class ResultRecordTooLargeError extends Error {
  readonly code = 'RESULT_RECORD_TOO_LARGE'
}

/** Canonical on-disk path for a result record. */
export function resultRecordPath(canonicalId: string, root?: string): string {
  return join(
    ensureSubagentsDataDir('results', root ?? subagentsDataRoot()),
    `${canonicalId}.json`,
  )
}

/** Reservation marker path for a semantic ref counter slot. */
export function reservationPath(
  name: string,
  n: number,
  root?: string,
): string {
  return join(
    ensureSubagentsDataDir(
      'result-ref-reservations',
      root ?? subagentsDataRoot(),
    ),
    sanitizeName(name),
    String(n),
  )
}

/** Parse `result:<name>#<n>`; returns null on malformed refs. */
export function parseSemanticRef(
  ref: string,
): { name: string; n: number } | null {
  const match = /^result:([^#\s]+)#(\d+)$/.exec(ref)
  if (!match) return null
  const n = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return { name: match[1], n }
}

function sanitizeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

// AIDEV-NOTE: atomic record write — write tmp sibling, fsync, rename over the
// final path. Readers therefore never observe a partial record.
export function writeResultRecord(
  params: {
    childId: string
    name: string
    summary: string
    sessionFile: string | null
    artifactPaths?: string[]
    usage?: UsageTotals
  },
  root?: string,
): { canonicalId: string; path: string } {
  const canonicalId = randomUUID()
  const record: ResultRecord = {
    canonicalId,
    childId: params.childId,
    name: params.name,
    summary: params.summary,
    sessionFile: params.sessionFile,
    artifactPaths: params.artifactPaths ?? [],
    createdAt: new Date().toISOString(),
  }
  if (params.usage) record.usage = params.usage
  const serialized = JSON.stringify(record)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_RESULT_RECORD_BYTES) {
    throw new ResultRecordTooLargeError(
      `result record is ${bytes} bytes, ceiling is ${MAX_RESULT_RECORD_BYTES}`,
    )
  }

  const dir = ensureSubagentsDataDir('results', root ?? subagentsDataRoot())
  const finalPath = join(dir, `${canonicalId}.json`)
  const tmpPath = join(dir, `.tmp-${canonicalId}`)
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, serialized)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
  return { canonicalId, path: finalPath }
}

/** Read a result record by canonical path. */
export function readResultRecord(path: string): ResultRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as ResultRecord
}

// AIDEV-NOTE: exactly-once ref allocation window — the exclusive create of the
// marker file is the single point that decides which allocator wins slot n.
// Losers retry at the next counter value, so refs are monotonic per name and
// never reused, even across parent sessions or crashed allocators (markers are
// deliberately never cleaned up).
export function allocateSemanticRef(
  name: string,
  root?: string,
  canonicalId?: string,
): string {
  const dir = join(
    ensureSubagentsDataDir(
      'result-ref-reservations',
      root ?? subagentsDataRoot(),
    ),
    sanitizeName(name),
  )
  mkdirSync(dir, { recursive: true })

  let n = highestExistingN(dir) + 1
  for (;;) {
    const marker = join(dir, String(n))
    try {
      const fd = openSync(marker, 'wx', 0o600)
      try {
        if (canonicalId !== undefined) writeSync(fd, canonicalId)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      n += 1
      continue
    }
    return `result:${name}#${n}`
  }
}

function highestExistingN(dir: string): number {
  let highest = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const parsed = Number.parseInt(entry, 10)
    if (
      String(parsed) === entry &&
      Number.isSafeInteger(parsed) &&
      parsed > highest
    ) {
      highest = parsed
    }
  }
  return highest
}

// AIDEV-NOTE: the marker content is the canonicalId, which is what lets a bare
// semantic ref resolve back to its record path without a separate index.
export function resolveResultRef(ref: string, root?: string): string | null {
  const parsed = parseSemanticRef(ref)
  if (!parsed) return null
  const marker = reservationPath(parsed.name, parsed.n, root)
  if (!existsSync(marker)) return null
  const canonicalId = readFileSync(marker, 'utf8').trim()
  if (canonicalId === '') return null
  const path = resultRecordPath(canonicalId, root)
  if (!existsSync(path)) return null
  return path
}

/** Remove an obsolete tmp sibling left behind by a crashed write. */
export function cleanupTmpRecord(canonicalId: string, root?: string): void {
  const dir = ensureSubagentsDataDir('results', root ?? subagentsDataRoot())
  try {
    unlinkSync(join(dir, `.tmp-${canonicalId}`))
  } catch {}
}

// AIDEV-NOTE: exported for tests — names are filesystem path components.
export const __storeInternals__ = { sanitizeName }
