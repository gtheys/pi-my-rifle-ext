// Retention / pruning sweep for the subagents data root (PMR-KT90).
//
// pruneSubagentsData walks <dataRoot>/pi-subagents/ and removes records per
// the record-class policy matrix (plan 2026-11-21-add-safe-retention-for-
// inactive). Two invariants are absolute:
//
// AIDEV-NOTE (PMR-KT90): result-ref-reservations and spawn-seq are NEVER
// enumerated for deletion — pruning either resets a monotonic counter
// (highestExistingN / spawn-seq N), which would reuse semantic refs and
// childIds. This module deliberately contains no code path that reads or
// lists those two directories for removal.
//
// AIDEV-NOTE (PMR-KT90): every class fails CLOSED — an unreadable record, an
// unparseable/missing timestamp, a failed liveness inspection
// (readProcessLockStatus throws "Unable to verify" by design), or an
// unresolvable session-file lookup all KEEP the record and count it as
// skipped. Deletions are per-record try/caught so one bad record never
// aborts the sweep.
//
// Injectable `now` (activity.ts precedent) and `root` (dataroot.ts test
// seam) keep the policy path free of wall-clock and default-path reads.
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@mariozechner/pi-coding-agent'
import { pidAlive, readAssignment } from './assignments.ts'
import { controlRecordPath } from './control.ts'
import { type SubagentsDataDirName, subagentsDataRoot } from './dataroot.ts'
import { readProcessLockStatus } from './lock.ts'
import { peerLockPath, readPresence } from './peers.ts'

export interface PruneReport {
  cutoffIso: string
  removed: Partial<Record<SubagentsDataDirName, number>>
  skipped: Partial<Record<SubagentsDataDirName, number>>
  skipReasons: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Mutable per-sweep accounting shared by the per-class policy functions. */
interface PruneLedger {
  cutoffMs: number
  removed: Partial<Record<SubagentsDataDirName, number>>
  skipped: Partial<Record<SubagentsDataDirName, number>>
  reasonCounts: Map<string, number>
}

function markRemoved(ledger: PruneLedger, cls: SubagentsDataDirName): void {
  ledger.removed[cls] = (ledger.removed[cls] ?? 0) + 1
}

/** Count a skip; `reason` (optional) joins the human-readable skipReasons. */
function markSkipped(
  ledger: PruneLedger,
  cls: SubagentsDataDirName,
  reason?: string,
): void {
  ledger.skipped[cls] = (ledger.skipped[cls] ?? 0) + 1
  if (reason !== undefined) {
    const key = `${cls}: ${reason}`
    ledger.reasonCounts.set(key, (ledger.reasonCounts.get(key) ?? 0) + 1)
  }
}

/** Read a JSON file as unknown; null on any read/parse failure (fail closed). */
function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed == null || typeof parsed !== 'object') return null
    if (Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Date.parse-based timestamp; null on missing/non-string/unparseable. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return null
  return ms
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key]
  if (typeof value !== 'string' || value === '') return null
  return value
}

/** Directory entries; null when the dir is missing or unreadable (fail closed). */
function dirEntries(dir: string): string[] | null {
  try {
    return readdirSync(dir)
  } catch {
    return null
  }
}

/** Session file exists on disk (kept when present — resumable evidence). */
function sessionFileExists(sessionFile: string): boolean {
  try {
    return existsSync(sessionFile)
  } catch {
    return true
  }
}

/**
 * Newest timestamp across a childId directory of records; null (fail closed)
 * when the dir cannot be listed or any record lacks a parseable pick of
 * `pick` fields (first parseable field wins per record).
 */
function newestTimestampAcrossDir(
  dir: string,
  pickFields: readonly string[],
): number | null {
  const entries = dirEntries(dir)
  if (entries === null) return null
  let newest: number | null = null
  for (const entry of entries) {
    const record = readJson(join(dir, entry))
    if (record === null) return null
    let ts: number | null = null
    for (const field of pickFields) {
      const parsed = parseTimestamp(record[field])
      if (parsed !== null) {
        ts = parsed
        break
      }
    }
    if (ts === null) return null
    if (newest === null || ts > newest) newest = ts
  }
  return newest
}

/**
 * Resolve a child's session file from the durable records: assignment first,
 * then peer presence. Null when neither record yields a sessionFile.
 */
function resolveChildSessionFile(childId: string, root: string): string | null {
  const assignment = readAssignment(childId, root)
  if (assignment !== null) return assignment.sessionFile
  const presence = readPresence(childId, root)
  if (presence !== null) return presence.sessionFile
  return null
}

/**
 * Liveness of a presence record via readProcessLockStatus, which throws
 * "Unable to verify" by design when the claim cannot be inspected — the
 * caller treats a throw as "not prunable".
 */
function presenceLockLive(
  sessionFile: string,
): { live: boolean } | { error: true } {
  try {
    const status = readProcessLockStatus(peerLockPath(sessionFile))
    return { live: status.live }
  } catch {
    return { error: true }
  }
}

// Shared policy for the two age-only, session-free classes (results,
// retired): newest activity is the record's single immutable timestamp and
// age past the cutoff is the whole eligibility rule.
function pruneImmutableTimestampedRecords(
  dir: string,
  cls: Extract<SubagentsDataDirName, 'results' | 'retired'>,
  timestampField: string,
  ledger: PruneLedger,
): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, cls, `${cls} dir unreadable`)
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const record = readJson(join(dir, entry))
    if (record === null) {
      markSkipped(ledger, cls, 'malformed record')
      continue
    }
    const ts = parseTimestamp(record[timestampField])
    if (ts === null) {
      markSkipped(ledger, cls, `missing/unparseable ${timestampField}`)
      continue
    }
    if (ts >= ledger.cutoffMs) {
      markSkipped(ledger, cls)
      continue
    }
    try {
      unlinkSync(join(dir, entry))
      markRemoved(ledger, cls)
    } catch {
      markSkipped(ledger, cls, 'unlink failed')
    }
  }
}

function pruneResults(dir: string, ledger: PruneLedger): void {
  pruneImmutableTimestampedRecords(dir, 'results', 'createdAt', ledger)
}

function pruneAssignments(
  dir: string,
  ledger: PruneLedger,
  root: string,
): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'assignments', 'assignments dir unreadable')
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const record = readJson(join(dir, entry))
    if (record === null) {
      markSkipped(ledger, 'assignments', 'malformed record')
      continue
    }
    const updatedAt = parseTimestamp(record.updatedAt)
    if (updatedAt === null) {
      markSkipped(ledger, 'assignments', 'missing/unparseable updatedAt')
      continue
    }
    if (updatedAt >= ledger.cutoffMs) {
      markSkipped(ledger, 'assignments')
      continue
    }
    const claim = record.claim
    if (claim == null || typeof claim !== 'object') {
      markSkipped(ledger, 'assignments', 'malformed record')
      continue
    }
    const pid = (claim as Record<string, unknown>).pid
    if (typeof pid !== 'number') {
      markSkipped(ledger, 'assignments', 'malformed record')
      continue
    }
    if (pidAlive(pid)) {
      markSkipped(ledger, 'assignments', 'live claim pid')
      continue
    }
    const sessionFile = stringField(record, 'sessionFile')
    if (sessionFile === null) {
      markSkipped(ledger, 'assignments', 'missing sessionFile')
      continue
    }
    if (sessionFileExists(sessionFile)) {
      markSkipped(
        ledger,
        'assignments',
        'session file still exists (resumable)',
      )
      continue
    }
    try {
      unlinkSync(join(dir, entry))
      markRemoved(ledger, 'assignments')
    } catch {
      markSkipped(ledger, 'assignments', 'unlink failed')
    }
  }
}

// AIDEV-NOTE (PMR-KT90): peers prune their presence file AND inbox dir as ONE
// candidate. An undrained inbox of a dead child WITH a session file on disk
// stays — at-least-once redelivery is intentional.
function prunePeers(dir: string, ledger: PruneLedger, root: string): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'peers', 'peers dir unreadable')
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const childId = entry.slice(0, -'.json'.length)
    const record = readJson(join(dir, entry))
    if (record === null) {
      markSkipped(ledger, 'peers', 'malformed record')
      continue
    }
    const updatedAt = parseTimestamp(record.updatedAt)
    const sessionFile = stringField(record, 'sessionFile')
    if (updatedAt === null || sessionFile === null) {
      markSkipped(ledger, 'peers', 'malformed record')
      continue
    }
    let newest = updatedAt
    const inboxEntries = dirEntries(join(dir, childId, 'inbox'))
    if (inboxEntries !== null) {
      for (const msg of inboxEntries) {
        const message = readJson(join(dir, childId, 'inbox', msg))
        if (message === null) {
          markSkipped(ledger, 'peers', 'malformed inbox message')
          newest = Number.NaN
          break
        }
        const sentAt = parseTimestamp(message.sentAt)
        if (sentAt === null) {
          markSkipped(ledger, 'peers', 'malformed inbox message')
          newest = Number.NaN
          break
        }
        if (sentAt > newest) newest = sentAt
      }
      if (Number.isNaN(newest)) continue
    }
    if (newest >= ledger.cutoffMs) {
      markSkipped(ledger, 'peers')
      continue
    }
    const lockState = presenceLockLive(sessionFile)
    if ('error' in lockState) {
      markSkipped(ledger, 'peers', 'liveness inspection failed')
      continue
    }
    if (lockState.live) {
      markSkipped(ledger, 'peers', 'live presence lock')
      continue
    }
    if (sessionFileExists(sessionFile)) {
      markSkipped(ledger, 'peers', 'session file still exists (resumable)')
      continue
    }
    let removedAny = false
    let failed = false
    try {
      rmSync(join(dir, childId), { recursive: true, force: true })
      removedAny = true
    } catch {
      failed = true
    }
    try {
      unlinkSync(join(dir, entry))
      removedAny = true
    } catch {
      failed = true
    }
    if (failed && !removedAny) {
      markSkipped(ledger, 'peers', 'delete failed')
      continue
    }
    if (removedAny) markRemoved(ledger, 'peers')
  }
}

/**
 * True when the child behind an ask record is provably not live: assignment
 * claim pid dead, or peer presence lock dead. When neither identity record
 * exists the child has no live evidence left (both its records were already
 * prunable/removed) and is treated as not live — the sessionFile-missing
 * check below still applies. Any liveness inspection failure keeps.
 */
function askChildNotLive(
  childId: string,
  root: string,
  ledger: PruneLedger,
): boolean | null {
  const assignment = readAssignment(childId, root)
  if (assignment !== null) {
    let alive: boolean
    try {
      alive = pidAlive(assignment.claim.pid)
    } catch {
      markSkipped(ledger, 'asks', 'liveness inspection failed')
      return null
    }
    if (alive) {
      markSkipped(ledger, 'asks', 'live claim pid')
      return false
    }
    return true
  }
  const presence = readPresence(childId, root)
  if (presence !== null) {
    const lockState = presenceLockLive(presence.sessionFile)
    if ('error' in lockState) {
      markSkipped(ledger, 'asks', 'liveness inspection failed')
      return null
    }
    if (lockState.live) {
      markSkipped(ledger, 'asks', 'live presence lock')
      return false
    }
    return true
  }
  return true
}

// AIDEV-NOTE (PMR-KT90): ask + reply + control records are one candidate —
// a blocked child waiting on a reply is never prunable (its session file
// exists on disk).
function pruneAsks(dir: string, ledger: PruneLedger, root: string): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'asks', 'asks dir unreadable')
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.endsWith('.reply.json')) continue
    if (entry.endsWith('.control.json')) continue
    const childId = entry.slice(0, -'.json'.length)
    const record = readJson(join(dir, entry))
    if (record === null) {
      markSkipped(ledger, 'asks', 'malformed record')
      continue
    }
    const createdAt = parseTimestamp(record.createdAt)
    const sessionFile = stringField(record, 'sessionFile')
    if (createdAt === null || sessionFile === null) {
      markSkipped(ledger, 'asks', 'malformed record')
      continue
    }
    let newest = createdAt
    const reply = readJson(join(dir, `${childId}.reply.json`))
    if (reply !== null) {
      const repliedAt = parseTimestamp(reply.repliedAt)
      if (repliedAt === null) {
        markSkipped(ledger, 'asks', 'missing/unparseable repliedAt')
        continue
      }
      if (repliedAt > newest) newest = repliedAt
    }
    if (newest >= ledger.cutoffMs) {
      markSkipped(ledger, 'asks')
      continue
    }
    const notLive = askChildNotLive(childId, root, ledger)
    if (notLive === null) continue
    if (!notLive) continue
    if (sessionFileExists(sessionFile)) {
      markSkipped(ledger, 'asks', 'session file still exists (resumable)')
      continue
    }
    let removedAny = false
    let failed = false
    const targets = [
      join(dir, entry),
      join(dir, `${childId}.reply.json`),
      join(dir, `${childId}.control.json`),
    ]
    for (const target of targets) {
      try {
        unlinkSync(target)
        removedAny = true
      } catch (error) {
        // AIDEV-NOTE (PMR-KT90): ENOENT is the expected missing-sibling case
        // (no reply/control record). Any OTHER unlink failure (EACCES,
        // EIO, ...) must surface — silently counting it as removed would
        // report a record deleted that is still on disk (prunePeers sets
        // `failed` the same way).
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true
      }
    }
    if (failed && !removedAny) {
      markSkipped(ledger, 'asks', 'delete failed')
      continue
    }
    if (removedAny) markRemoved(ledger, 'asks')
  }
}

/**
 * Recursively collect SESSION IDS (not file names) under the sessions root.
 * Pi session files are named `<ISO-timestamp>_<sessionId>.jsonl` (index.ts
 * spawn), so each file contributes its base name AND the portion after the
 * first underscore — both `<id>.jsonl` and `<ts>_<id>.jsonl` shapes resolve
 * to their id. Files without an underscore contribute only the bare id.
 * Null when the scan itself fails (fail closed — keep the inbox).
 */
function scanSessionIds(sessionsRoot: string): Set<string> | null {
  const ids = new Set<string>()
  const visit = (dir: string): boolean => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!visit(join(dir, entry.name))) return false
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const base = entry.name.slice(0, -'.jsonl'.length)
        ids.add(base)
        const underscore = base.indexOf('_')
        if (underscore !== -1) ids.add(base.slice(underscore + 1))
      }
    }
    return true
  }
  if (!visit(sessionsRoot)) return null
  return ids
}

function pruneOwnerInbox(
  dir: string,
  ledger: PruneLedger,
  sessionsRoot: string | null,
): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'inbox', 'inbox dir unreadable')
    return
  }
  let cachedSessionIds: Set<string> | null | undefined
  for (const entry of entries) {
    const inboxDir = join(dir, entry)
    let statIsDir = true
    try {
      statIsDir = statSync(inboxDir).isDirectory()
    } catch {
      markSkipped(ledger, 'inbox', 'stat failed')
      continue
    }
    if (!statIsDir) continue
    const msgEntries = dirEntries(inboxDir)
    if (msgEntries === null) {
      markSkipped(ledger, 'inbox', 'inbox dir unreadable')
      continue
    }
    let newest: number | null = null
    let malformed = false
    for (const msg of msgEntries) {
      const message = readJson(join(inboxDir, msg))
      if (message === null) {
        malformed = true
        break
      }
      const sentAt = parseTimestamp(message.sentAt)
      if (sentAt === null) {
        malformed = true
        break
      }
      if (newest === null || sentAt > newest) newest = sentAt
    }
    if (malformed || newest === null) {
      markSkipped(ledger, 'inbox', 'malformed record')
      continue
    }
    if (newest >= ledger.cutoffMs) {
      markSkipped(ledger, 'inbox')
      continue
    }
    if (sessionsRoot === null) {
      markSkipped(ledger, 'inbox', 'sessions root unavailable')
      continue
    }
    // AIDEV-NOTE (PMR-KT90): the recursive sessions walk is hoisted into a
    // lazily-computed cache — the result cannot change during a single
    // sweep, so it runs at most once per pruneOwnerInbox call instead of
    // once per aged inbox dir. `undefined` = not yet scanned.
    if (cachedSessionIds === undefined) {
      cachedSessionIds = scanSessionIds(sessionsRoot)
    }
    if (cachedSessionIds === null) {
      markSkipped(ledger, 'inbox', 'session scan failed')
      continue
    }
    // AIDEV-NOTE (PMR-KT90): match the SESSION ID, not the file name — pi
    // names session files `<ISO-ts>_<sessionId>.jsonl`, so a bare
    // `${entry}.jsonl` name check never matches a real session file and the
    // resumability guard would be dead code.
    if (cachedSessionIds.has(entry)) {
      markSkipped(ledger, 'inbox', 'parent session file still exists')
      continue
    }
    try {
      rmSync(inboxDir, { recursive: true, force: true })
      markRemoved(ledger, 'inbox')
    } catch {
      markSkipped(ledger, 'inbox', 'delete failed')
    }
  }
}

/**
 * Does a source mailbox record for this delivered marker still exist?
 * Scopes in use (index.ts / subagent-done.ts): `<childId>` (ask replies +
 * peer inbox), `<ownerSessionId>` (owner inbox), `control:<childId>`.
 * Returns null when a source scan itself fails — keep the marker.
 *
 * AIDEV-NOTE (PMR-KT90): `scope` here is the ON-DISK marker dir name, which
 * was written through delivered.ts sanitizeScope — ':' maps to '_', so the
 * control scope arrives as `control_<childId>`, never `control:<childId>`.
 * Match the sanitized prefix and slice the (already sanitized) childId off;
 * controlRecordPath re-applies the same mapping, so this mirrors the write
 * side exactly.
 */
function deliveredSourceExists(
  scope: string,
  requestId: string,
  root: string,
): boolean | null {
  // Ask reply source: asks/<childId>.reply.json with matching askId.
  const reply = readJson(join(root, 'asks', `${scope}.reply.json`))
  if (reply !== null && reply.askId === requestId) return true

  // Peer inbox source: peers/<childId>/inbox/*.json with matching messageId.
  const peerInbox = dirEntries(join(root, 'peers', scope, 'inbox'))
  if (peerInbox !== null) {
    for (const msg of peerInbox) {
      const message = readJson(join(root, 'peers', scope, 'inbox', msg))
      if (message !== null && message.messageId === requestId) return true
    }
  }

  // Owner inbox source: inbox/<ownerSessionId>/*.json with matching messageId.
  const ownerInbox = dirEntries(join(root, 'inbox', scope))
  if (ownerInbox !== null) {
    for (const msg of ownerInbox) {
      const message = readJson(join(root, 'inbox', scope, msg))
      if (message !== null && message.messageId === requestId) return true
    }
  }

  // Control source: control_<childId> scope (sanitized on disk),
  // asks/<childId>.control.json.
  if (scope.startsWith('control_')) {
    const childId = scope.slice('control_'.length)
    const control = readJson(controlRecordPath(childId, root))
    if (control !== null && control.requestId === requestId) return true
  }

  // Distinguish "scanned everything, no match" from "a scan failed".
  const replyExists = existsSync(join(root, 'asks', `${scope}.reply.json`))
  if (replyExists) return false
  const peerInboxMissing = !existsSync(join(root, 'peers', scope, 'inbox'))
  const ownerInboxMissing = !existsSync(join(root, 'inbox', scope))
  const controlMissing =
    !scope.startsWith('control_') ||
    !existsSync(controlRecordPath(scope.slice('control_'.length), root))
  if (peerInboxMissing && ownerInboxMissing && controlMissing) return false
  return null
}

// AIDEV-NOTE (PMR-KT90): pruning a delivered marker while its source record
// still exists re-opens the exactly-once duplicate-delivery window — any
// doubt keeps the marker.
function pruneDelivered(dir: string, ledger: PruneLedger, root: string): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'delivered', 'delivered dir unreadable')
    return
  }
  for (const scope of entries) {
    const scopeDir = join(dir, scope)
    let requestIds: string[] | null
    try {
      if (!statSync(scopeDir).isDirectory()) continue
      requestIds = readdirSync(scopeDir)
    } catch {
      markSkipped(ledger, 'delivered', 'stat failed')
      continue
    }
    for (const requestId of requestIds) {
      const markerPath = join(scopeDir, requestId)
      let mtimeMs: number
      try {
        mtimeMs = statSync(markerPath).mtimeMs
      } catch {
        markSkipped(ledger, 'delivered', 'stat failed')
        continue
      }
      if (mtimeMs >= ledger.cutoffMs) {
        markSkipped(ledger, 'delivered')
        continue
      }
      const sourceExists = deliveredSourceExists(scope, requestId, root)
      if (sourceExists === null) {
        markSkipped(ledger, 'delivered', 'source scan failed')
        continue
      }
      if (sourceExists) {
        markSkipped(ledger, 'delivered', 'source record still exists')
        continue
      }
      try {
        unlinkSync(markerPath)
        markRemoved(ledger, 'delivered')
      } catch {
        markSkipped(ledger, 'delivered', 'unlink failed')
      }
    }
  }
}

function pruneInterrupts(dir: string, ledger: PruneLedger): void {
  const entries = dirEntries(dir)
  if (entries === null) {
    markSkipped(ledger, 'interrupts', 'interrupts dir unreadable')
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const record = readJson(join(dir, entry))
    if (record === null) {
      markSkipped(ledger, 'interrupts', 'malformed record')
      continue
    }
    const sentAt = parseTimestamp(record.sentAt)
    const sessionFile = stringField(record, 'sessionFile')
    if (sentAt === null || sessionFile === null) {
      markSkipped(ledger, 'interrupts', 'malformed record')
      continue
    }
    if (sentAt >= ledger.cutoffMs) {
      markSkipped(ledger, 'interrupts')
      continue
    }
    if (sessionFileExists(sessionFile)) {
      markSkipped(
        ledger,
        'interrupts',
        'session file still exists (replay source)',
      )
      continue
    }
    try {
      unlinkSync(join(dir, entry))
      markRemoved(ledger, 'interrupts')
    } catch {
      markSkipped(ledger, 'interrupts', 'unlink failed')
    }
  }
}

/**
 * Shared policy for the childId-keyed replay-evidence classes
 * (tool-effects, peer-bindings): eligible ONLY when the child's session
 * file is gone and the dir's newest activity is older than the cutoff.
 * The childId dir is pruned as one candidate; the session file resolves
 * through assignments/<childId>.json then peers/<childId>.json —
 * unresolvable keeps.
 */
function pruneChildIdKeyedDir(
  baseDir: string,
  cls: Extract<SubagentsDataDirName, 'tool-effects' | 'peer-bindings'>,
  pickFields: readonly string[],
  ledger: PruneLedger,
  root: string,
): void {
  const entries = dirEntries(baseDir)
  if (entries === null) {
    markSkipped(ledger, cls, `${cls} dir unreadable`)
    return
  }
  for (const childId of entries) {
    const childDir = join(baseDir, childId)
    let isDir = true
    try {
      isDir = statSync(childDir).isDirectory()
    } catch {
      markSkipped(ledger, cls, 'stat failed')
      continue
    }
    if (!isDir) continue
    const newest = newestTimestampAcrossDir(childDir, pickFields)
    if (newest === null) {
      markSkipped(ledger, cls, 'malformed record')
      continue
    }
    if (newest >= ledger.cutoffMs) {
      markSkipped(ledger, cls)
      continue
    }
    const sessionFile = resolveChildSessionFile(childId, root)
    if (sessionFile === null) {
      markSkipped(ledger, cls, 'session file unresolvable')
      continue
    }
    if (sessionFileExists(sessionFile)) {
      markSkipped(ledger, cls, 'session file still exists (replay source)')
      continue
    }
    try {
      rmSync(childDir, { recursive: true, force: true })
      markRemoved(ledger, cls)
    } catch {
      markSkipped(ledger, cls, 'delete failed')
    }
  }
}

/**
 * Retention sweep across the subagents data root. Never enumerates
 * result-ref-reservations or spawn-seq for deletion; every class fails
 * closed (see module AIDEV-NOTEs). One malformed/unreadable record never
 * aborts the sweep.
 */
export function pruneSubagentsData(options: {
  retentionDays: number
  now?: () => Date
  root?: string
  agentDir?: string
}): PruneReport {
  const nowFn = options.now ?? ((): Date => new Date())
  const nowMs = nowFn().getTime()
  const cutoffMs = nowMs - options.retentionDays * DAY_MS
  const root = options.root ?? subagentsDataRoot()

  const ledger: PruneLedger = {
    cutoffMs,
    removed: {},
    skipped: {},
    reasonCounts: new Map<string, number>(),
  }

  // Order matters: classes whose liveness/session resolution reads another
  // class's records (asks reads assignments/peers; tool-effects and
  // peer-bindings resolve via assignments/peers) run BEFORE those source
  // classes are pruned, so one sweep never prunes its own evidence mid-pass.
  // Concretely: pruneAsks runs BEFORE prunePeers — a peer pruned first
  // would drop askChildNotLive into its no-evidence fallback instead of the
  // accurate presence-lock check. pruneDelivered scans asks/peers/inbox
  // sources, so it also runs before all three. prunePeers itself reads no
  // other pruned class, so moving it after pruneAsks breaks nothing.
  pruneResults(join(root, 'results'), ledger)
  pruneImmutableTimestampedRecords(
    join(root, 'retired'),
    'retired',
    'retiredAt',
    ledger,
  )
  pruneInterrupts(join(root, 'interrupts'), ledger)
  pruneDelivered(join(root, 'delivered'), ledger, root)
  pruneChildIdKeyedDir(
    join(root, 'tool-effects'),
    'tool-effects',
    ['createdAt'],
    ledger,
    root,
  )
  pruneChildIdKeyedDir(
    join(root, 'peer-bindings'),
    'peer-bindings',
    ['lastActivityAt', 'createdAt'],
    ledger,
    root,
  )
  pruneAsks(join(root, 'asks'), ledger, root)
  prunePeers(join(root, 'peers'), ledger, root)
  pruneAssignments(join(root, 'assignments'), ledger, root)

  // Owner inbox needs the sessions root OUTSIDE the data root. Only this
  // default resolution reads getAgentDir(); the injectable agentDir keeps
  // tests (and any non-default install) off the default path.
  let sessionsRoot: string | null = null
  const agentDir = options.agentDir ?? getAgentDir()
  sessionsRoot = join(agentDir, 'sessions')
  pruneOwnerInbox(join(root, 'inbox'), ledger, sessionsRoot)

  const skipReasons: string[] = []
  for (const [key, count] of ledger.reasonCounts) {
    skipReasons.push(`${key} (${count})`)
  }
  skipReasons.sort()

  return {
    cutoffIso: new Date(cutoffMs).toISOString(),
    removed: ledger.removed,
    skipped: ledger.skipped,
    skipReasons,
  }
}
