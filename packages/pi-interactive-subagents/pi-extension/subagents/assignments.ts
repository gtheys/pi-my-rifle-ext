// Durable branch-owned assignment records (PMR-Z5KR). Ported from
// pi-herdsman's ProjectAssignment pattern (Apache-2.0, ADR 0017): authority
// is the RECORD under <dataRoot>/assignments/<childId>.json, not process
// memory. Children live in herdr-owned background tabs, so a parent death
// leaves them running — any new parent process rediscovers them here
// (orphan + resume hint) instead of losing track of the work.
//
// Lifecycle: written atomically at spawn, status updated on transitions
// (blocked/interrupted/stalled via the 1s status loop), REMOVED only on a
// verified completion signal (`.exit`/sentinel sidecar observed by the
// watcher) or explicit remove. Crash-inferred endings mark the record
// 'lost' and keep it — fail closed, never invent state.
import {
  closeSync,
  existsSync,
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

/** Coarse lifecycle status persisted on the record. Mirrors WidgetStateKind. */
export type AssignmentStatus =
  | 'working'
  | 'blocked'
  | 'starting'
  | 'waiting'
  | 'stalled'
  | 'lost'

export interface AssignmentRecord {
  childId: string
  name: string
  task: string
  agent?: string
  sessionFile: string
  paneId?: string
  tabId?: string
  workspaceId?: string
  cwd: string
  /** Worktree placement (PMR-11TD): the branch-keyed authority fields. */
  worktree?: string
  branch?: string
  status: AssignmentStatus
  /**
   * Owning parent identity. pid = the parent pi process; id = the parent
   * session id (diagnostics/correlation).
   *
   * AIDEV-NOTE: stale detection is pid liveness only. Pid reuse could
   * misclassify an orphan as owned — mitigate by treating 'owned' as
   * display metadata only; every mutation path still revalidates identity
   * (childId + sessionFile) before acting. Herdsman's full claim-generation
   * machinery (lock.ts) is deliberately not coupled in here.
   */
  claim: { pid: number; id: string }
  createdAt: string
  updatedAt: string
}

/** New-record input: timestamps are assigned by writeAssignment. */
export type AssignmentDraft = Omit<AssignmentRecord, 'createdAt' | 'updatedAt'>

/** What a scan of the assignments dir can say about one record (fail closed). */
export type AssignmentView =
  | { childId: string; state: 'unknown' }
  | { childId: string; state: 'owned'; record: AssignmentRecord }
  | {
      childId: string
      state: 'orphaned'
      record: AssignmentRecord
      resumeHint?: string
    }

function sanitizeChildId(childId: string): string {
  const safe = childId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/** Canonical on-disk path for an assignment record. */
export function assignmentPath(childId: string, root?: string): string {
  return join(
    ensureSubagentsDataDir('assignments', root ?? subagentsDataRoot()),
    `${sanitizeChildId(childId)}.json`,
  )
}

export function hasAssignment(childId: string, root?: string): boolean {
  return existsSync(assignmentPath(childId, root))
}

// AIDEV-NOTE: atomic write — tmp sibling + fsync + rename (same discipline
// as store.ts/control.ts). Readers never observe a partial record.
function writeRecordAtomic(path: string, record: AssignmentRecord): void {
  const tmpPath = `${path}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(record))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

/** Write the assignment record at spawn (latest full picture wins). */
export function writeAssignment(
  draft: AssignmentDraft,
  root?: string,
): AssignmentRecord {
  const now = new Date().toISOString()
  const record: AssignmentRecord = {
    ...draft,
    createdAt: now,
    updatedAt: now,
  }
  writeRecordAtomic(assignmentPath(record.childId, root), record)
  return record
}

/** Read one record; null when missing or malformed (fail closed). */
export function readAssignment(
  childId: string,
  root?: string,
): AssignmentRecord | null {
  let raw: string
  try {
    raw = readFileSync(assignmentPath(childId, root), 'utf8')
  } catch {
    return null
  }
  return parseAssignment(raw)
}

function parseAssignment(raw: string): AssignmentRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed == null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.childId !== 'string') return null
    if (typeof record.sessionFile !== 'string') return null
    const claim = record.claim as Record<string, unknown> | undefined
    if (claim == null || typeof claim.pid !== 'number') return null
    return parsed as AssignmentRecord
  } catch {
    return null
  }
}

// AIDEV-NOTE: read-modify-write; latest status wins. A MISSING record is a
// no-op (fail closed) — transitions never resurrect a removed assignment.
export function updateAssignmentStatus(
  childId: string,
  status: AssignmentStatus,
  root?: string,
): void {
  const record = readAssignment(childId, root)
  if (!record) return
  if (record.status === status) return
  writeRecordAtomic(assignmentPath(childId, root), {
    ...record,
    status,
    updatedAt: new Date().toISOString(),
  })
}

/** Explicit remove — callers gate this on verified completion or user intent. */
export function removeAssignment(childId: string, root?: string): void {
  try {
    unlinkSync(assignmentPath(childId, root))
  } catch {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM = the process exists but is owned by another user.
    return err?.code === 'EPERM'
  }
}

/**
 * Scan the assignments dir and classify every record from FILES ALONE —
 * this is the parent-restart discovery path. Live claim pid ⇒ owned; dead
 * claim pid ⇒ orphaned with a resume hint; unreadable record ⇒ unknown
 * (kept on disk, no action, no invented state).
 */
export function listAssignments(root?: string): AssignmentView[] {
  const dir = ensureSubagentsDataDir('assignments', root ?? subagentsDataRoot())
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const views: AssignmentView[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const childId = entry.slice(0, -'.json'.length)
    let raw: string
    try {
      raw = readFileSync(join(dir, entry), 'utf8')
    } catch {
      views.push({ childId, state: 'unknown' })
      continue
    }
    const record = parseAssignment(raw)
    if (!record) {
      views.push({ childId, state: 'unknown' })
      continue
    }
    if (pidAlive(record.claim.pid)) {
      views.push({ childId, state: 'owned', record })
      continue
    }
    const view: Extract<AssignmentView, { state: 'orphaned' }> = {
      childId,
      state: 'orphaned',
      record,
    }
    if (record.sessionFile) {
      view.resumeHint = `subagent_resume({ sessionPath: "${record.sessionFile}" })`
    }
    views.push(view)
  }
  views.sort((a, b) => a.childId.localeCompare(b.childId))
  return views
}

// AIDEV-NOTE: branch-keyed authority lookup (herdsman ADR 0017). Exactly one
// current assignment may name a branch — zero or multiple matches are
// ambiguous and fail closed to an error, never a guessed record.
export function findAssignmentByBranch(
  branch: string,
  root?: string,
): { record: AssignmentRecord } | { error: string } {
  const matches: AssignmentRecord[] = []
  for (const view of listAssignments(root)) {
    if (view.state === 'unknown') continue
    if (view.record.branch === branch) matches.push(view.record)
  }
  if (matches.length === 1) return { record: matches[0] }
  if (matches.length === 0) {
    return { error: `No assignment for branch "${branch}" — state unknown.` }
  }
  return {
    error: `Ambiguous assignments for branch "${branch}" (${matches.length} records) — state unknown.`,
  }
}
