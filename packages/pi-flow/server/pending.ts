// AIDEV-NOTE: PMR-XTQQ — pi-flow pending protocol module (durable run
// server, phase 3). A pending record is the daemon's durable "this run is
// parked mid-loop and should be re-injected when a session reopens" marker,
// written to <agentDir>/pi-flow/pending/<ref>.json (sibling of runs/ — the
// runs dir is ref-keyed journal/projection files, never pending markers).
//
// RENAME-FIRST CONTRACT (the no-duplicates guarantee): consumePending
// renames <ref>.json → <ref>.consumed.json before returning success, and the
// caller (index.ts, subtask 3.3) only injects `/flow <ref>` after a
// `{consumed: true}` result. POSIX rename is atomic, so two concurrent
// consumers race on one rename — exactly one wins, the loser gets ENOENT and
// returns {consumed:false}. If the post-rename injection throws, consumption
// already happened: catch + notify the manual `/flow` fallback is correct
// (a lost injection beats a duplicate loop).
//
// "PARKED" DEFINITION: the latest journal `loop-state` snapshot has
// awaitingOutcome=true AND status='running'. Paused snapshots carry
// awaitingOutcome=false and are NOT parked (see flow/loop.ts journaling).
// A stale leftover record (daemon died, run later paused/finished) fails
// verify and is renamed away with dropped:true — it can never be injected.
//
// This module never imports the loop or pi internals: the consumer passes a
// `verify` closure that reads the journal and answers "is this ref still
// parked?". writePending/clearPending/sweepConsumed are standalone functions
// the daemon (subtask 3.2) calls from its serial scan queue.

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { type LoopStateRecord, runFileName } from '../run-state.ts'

export const PENDING_SCHEMA = 'gtheys.pi-flow.pending.v1'

export type PendingPhase = 'plan' | 'implement' | 'validate' | 'feedback'

export interface PendingRecord {
  schema: typeof PENDING_SCHEMA
  ref: string
  phase: PendingPhase
  createdAt: string
  sourceAt: string
}

const PENDING_PHASES: readonly PendingPhase[] = [
  'plan',
  'implement',
  'validate',
  'feedback',
]

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strict string-field check for the record shape. Pure. */
function hasStringFields(
  obj: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    if (typeof obj[key] !== 'string') return false
  }
  return true
}

/**
 * Parse a pending record from raw file contents. Strict: the exact schema
 * id, a filename-safe ref, a known phase, ISO-ish strings for both
 * timestamps, and no extra keys. Returns null on any garbage — never throws.
 * Pure.
 */
export function parsePendingRecord(raw: string): PendingRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecordObject(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 5) return null
  if (parsed.schema !== PENDING_SCHEMA) return null
  if (!hasStringFields(parsed, ['ref', 'phase', 'createdAt', 'sourceAt'])) {
    return null
  }
  const ref = parsed.ref as string
  const phase = parsed.phase as string
  // Reuse runFileName's charset rule so a parsed ref can never escape the
  // pending dir even before it hits a path join.
  if (runFileName(ref) === null) return null
  if (!PENDING_PHASES.includes(phase as PendingPhase)) return null
  return {
    schema: PENDING_SCHEMA,
    ref,
    phase: phase as PendingPhase,
    createdAt: parsed.createdAt as string,
    sourceAt: parsed.sourceAt as string,
  }
}

/**
 * Parked check over a loop-state snapshot: awaitingOutcome=true AND
 * status='running'. Paused snapshots are awaitingOutcome=false and do NOT
 * count. Pure. Undefined (no snapshot yet) is not parked.
 */
export function isParkedLoop(loop: LoopStateRecord | undefined): boolean {
  if (loop === undefined) return false
  return loop.awaitingOutcome === true && loop.status === 'running'
}

export interface PendingPathGuard {
  /** Path components derived from the ref; null on a charset-violating ref. */
  pendingPath: string | null
  consumedPath: string | null
}

/** Derive <ref>.json / <ref>.consumed.json paths under pendingDir. Pure. */
export function pendingPaths(
  pendingDir: string,
  ref: string,
): PendingPathGuard {
  const name = runFileName(ref)
  if (name === null) {
    return { pendingPath: null, consumedPath: null }
  }
  const base = name.slice(0, -'.json'.length)
  return {
    pendingPath: path.join(pendingDir, name),
    consumedPath: path.join(pendingDir, `${base}.consumed.json`),
  }
}

export type ConsumePendingResult =
  | { consumed: true }
  | { consumed: false }
  | { consumed: false; dropped: true }

// AIDEV-NOTE: io seam for injectable fs in tests; the exactly-once race test
// uses the real fs (default io), not fakes.
export interface PendingIo {
  readFile: (p: string) => Promise<string>
  writeFile: (p: string, data: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (p: string) => Promise<void>
  readdir: (p: string) => Promise<string[]>
  mkdir: (dir: string, recursive: true) => Promise<void>
}

export const defaultPendingIo: PendingIo = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, data) => fsp.writeFile(p, data, 'utf8'),
  rename: async (from, to) => {
    await fsp.rename(from, to)
  },
  unlink: (p) => fsp.unlink(p),
  readdir: (p) => fsp.readdir(p),
  mkdir: async (dir, recursive) => {
    await fsp.mkdir(dir, { recursive })
  },
}

/**
 * Consume a pending record for a ref. Ordering:
 * 1. Guard the ref charset (invalid → {consumed:false}, fs untouched).
 * 2. RENAME <ref>.json → <ref>.consumed.json (atomic exactly-once gate;
 *    ENOENT → {consumed:false} — someone else won or nothing pending).
 * 3. Read + parse the consumed file; malformed → dropped.
 * 4. `verify(record)` (the caller's journal-closure answering "still
 *    parked?") — verify-fail → dropped. Either way the file stays renamed
 *    away so a stale record can never be re-injected.
 */
export async function consumePending(
  pendingDir: string,
  ref: string,
  verify: (record: PendingRecord) => Promise<boolean> | boolean,
  io: PendingIo = defaultPendingIo,
): Promise<ConsumePendingResult> {
  const paths = pendingPaths(pendingDir, ref)
  if (paths.pendingPath === null || paths.consumedPath === null) {
    return { consumed: false }
  }
  try {
    await io.rename(paths.pendingPath, paths.consumedPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { consumed: false }
    throw err
  }
  let record: PendingRecord | null
  try {
    const raw = await io.readFile(paths.consumedPath)
    record = parsePendingRecord(raw)
  } catch {
    record = null
  }
  if (record === null) {
    return { consumed: false, dropped: true }
  }
  const stillValid = await verify(record)
  if (!stillValid) {
    return { consumed: false, dropped: true }
  }
  return { consumed: true }
}

/**
 * Daemon-side: write a pending record for a ref (idempotent overwrite).
 * Writes to a temp name then renames so a concurrent consumer never reads a
 * torn file. Invalid ref → no-op.
 */
export async function writePending(
  pendingDir: string,
  record: PendingRecord,
  io: PendingIo = defaultPendingIo,
): Promise<void> {
  const paths = pendingPaths(pendingDir, record.ref)
  if (paths.pendingPath === null) return
  await io.mkdir(pendingDir, true)
  const tmpPath = `${paths.pendingPath}.tmp-${process.pid}`
  await io.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`)
  await io.rename(tmpPath, paths.pendingPath)
}

/** Daemon-side: remove a pending marker for a ref (absence is fine). */
export async function clearPending(
  pendingDir: string,
  ref: string,
  io: PendingIo = defaultPendingIo,
): Promise<void> {
  const paths = pendingPaths(pendingDir, ref)
  if (paths.pendingPath === null) return
  try {
    await io.unlink(paths.pendingPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw err
  }
}

/**
 * Daemon-side: sweep consumed markers during runs-dir scans. Returns the
 * number of files removed; individual unlink failures (racing consumer, etc.)
 * are skipped, not thrown.
 */
export async function sweepConsumed(
  pendingDir: string,
  io: PendingIo = defaultPendingIo,
): Promise<number> {
  let names: string[]
  try {
    names = await io.readdir(pendingDir)
  } catch {
    return 0
  }
  let swept = 0
  for (const name of names) {
    if (!name.endsWith('.consumed.json')) continue
    try {
      await io.unlink(path.join(pendingDir, name))
      swept += 1
    } catch {
      // raced or vanished — next sweep catches it
    }
  }
  return swept
}
