// Replay-safe spawn identity (PMR-YKAC). Ported from pi-durable's
// `replay: "safe"` subagent tool: child creation is keyed on
// (parentSessionId, spawnSeq) so a rerun after a crash finds the same child
// instead of duplicating it.
//
// AIDEV-NOTE: the seq allocator is a marker-file set (delivered.ts
// precedent): seq N is claimed by exclusive-create of
// <dataRoot>/spawn-seq/<parentSessionId>/<N> — atomic by construction, so
// concurrent spawns in one parent session can never claim the same seq, and
// the counter survives a parent crash (no in-memory reset).
//
// Replay is scan-based (pi-durable's scanConversations({ownerTaskId})):
// before allocating, look up a 'starting' assignment record written by THIS
// parent for the SAME name+task — that is the spawn that crashed between
// record-write and tab-create. Reuse its childId/sessionFile/worktree
// instead of creating duplicates.
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { type AssignmentRecord, findStartingAssignment } from './assignments.ts'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

function sanitizeScope(scope: string): string {
  const safe = scope.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') return '_'
  return safe
}

/**
 * Deterministic childId: first 8 hex of sha256(parentSessionId:spawnSeq) —
 * same shape as the legacy random id (`Math.random().toString(16)`), so
 * every downstream consumer (session file naming, worktree branch suffix,
 * PI_SUBAGENT_ID) is unaffected.
 */
export function deriveChildId(
  parentSessionId: string,
  spawnSeq: number,
): string {
  return createHash('sha256')
    .update(`${parentSessionId}:${spawnSeq}`)
    .digest('hex')
    .slice(0, 8)
}

/**
 * Claim the next spawn seq for this parent session. Durable and crash-safe:
 * the marker persists, so a restarted parent never re-issues a seq whose
 * assignment record may already exist.
 */
export function nextSpawnSeq(
  parentSessionId: string,
  root: string = subagentsDataRoot(),
): number {
  const dir = join(
    ensureSubagentsDataDir('spawn-seq', root),
    sanitizeScope(parentSessionId),
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (let seq = 1; ; seq++) {
    let fd: number
    try {
      fd = openSync(join(dir, String(seq)), 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(fd, '1')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return seq
  }
}

export interface SpawnIdentity {
  childId: string
  /** The crashed spawn's record when this allocation is a replay. */
  replay: AssignmentRecord | null
}

/**
 * Lookup-before-create (the replay: "safe" port): a matching 'starting'
 * record from this parent means the previous spawn crashed after writing
 * its record but before creating the tab — reuse it. Otherwise allocate a
 * fresh deterministic childId. Without a parent session id (programmatic
 * callers) fall back to the legacy random id.
 */
export function allocateSpawnIdentity(
  options: {
    parentSessionId: string | null
    name: string
    task: string
  },
  root?: string,
): SpawnIdentity {
  const { parentSessionId, name, task } = options
  if (!parentSessionId) {
    return {
      childId: Math.random().toString(16).slice(2, 10),
      replay: null,
    }
  }
  const replay = findStartingAssignment({ parentSessionId, name, task }, root)
  if (replay) {
    return { childId: replay.childId, replay }
  }
  return {
    childId: deriveChildId(
      parentSessionId,
      nextSpawnSeq(parentSessionId, root),
    ),
    replay: null,
  }
}
