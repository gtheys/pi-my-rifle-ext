// AIDEV-NOTE: Per-subtask gate ranges (PMR-6EEW remainder, observability
// plan Phase 6 / M7 item 4). Subtask attribution is derived from history:
// every flow commit carries a `Subtask: <aven-ref>` trailer, so a reviewer
// assigned to subtask X can be pinned to exactly X's commits — never "the
// branch". Commits without a trailer are surfaced as unattributed rather
// than guessed at. PURE only: no git, no journal. The exec-backed derivation
// lives in gate-target.ts (deriveSubtaskAttribution), journal events in
// run-state.ts ('subtask-ranges').

import { isFullSha } from './gate-target.ts'

export const SUBTASK_TRAILER_PREFIX = 'Subtask:'

const SUBTASK_REF_RE = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$/
// /g for matchAll, /i for case, /m for per-line trailer matching
const TRAILER_RE = /^Subtask:\s*([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\s*$/gim

export interface SubtaskCommit {
  sha: string
  message: string
  /** aven refs found in `Subtask:` trailers (0 = unattributed). */
  subtaskRefs: string[]
}

export type SubtaskLogParse =
  | { ok: true; commits: SubtaskCommit[] }
  | { ok: false; reason: string }

/**
 * Parse `git log --format=%H%x1f%B%x1e` output (field separator U+001F,
 * record separator U+001E) into attributed commits. Malformed SHAs are an
 * error, not silent data loss — a range derived from garbage history must
 * never be handed to a gate.
 */
export function parseSubtaskLog(stdout: string): SubtaskLogParse {
  const commits: SubtaskCommit[] = []
  for (const record of stdout.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '').replace(/\n+$/, '')
    if (trimmed.length === 0) continue
    const sep = trimmed.indexOf('\x1f')
    if (sep < 0) {
      return {
        ok: false,
        reason: `log record has no field separator: '${trimmed.slice(0, 40)}'`,
      }
    }
    const sha = trimmed.slice(0, sep).trim()
    const message = trimmed.slice(sep + 1)
    if (!isFullSha(sha)) {
      return {
        ok: false,
        reason: `log record sha is not full 40-hex: '${sha.slice(0, 40)}'`,
      }
    }
    const subtaskRefs: string[] = []
    for (const m of message.matchAll(TRAILER_RE)) {
      const ref = m[1] ?? ''
      if (!subtaskRefs.includes(ref)) subtaskRefs.push(ref)
    }
    commits.push({ sha, message, subtaskRefs })
  }
  return { ok: true, commits }
}

/** Validate a standalone subtask ref (used by buildSubtaskGateTarget). */
export function isSubtaskRef(value: string): boolean {
  return SUBTASK_REF_RE.test(value)
}

/** subtask ref -> its commits, in log order (newest first). */
export function subtaskCommitMap(
  commits: SubtaskCommit[],
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const c of commits) {
    for (const ref of c.subtaskRefs) {
      const list = map.get(ref) ?? []
      list.push(c.sha)
      map.set(ref, list)
    }
  }
  return map
}

/** Commits in the range with NO subtask trailer — never silently attributed. */
export function unattributedCommits(commits: SubtaskCommit[]): SubtaskCommit[] {
  return commits.filter((c) => c.subtaskRefs.length === 0)
}

export interface SubtaskAttribution {
  /** subtask ref -> commit SHAs (newest first, as git log emits). */
  bySubtask: Array<{ subtask: string; commits: string[] }>
  /** SHAs of commits without any `Subtask:` trailer. */
  unattributed: string[]
}

/** The journal-shaped projection of one range's attribution. */
export function subtaskAttribution(
  commits: SubtaskCommit[],
): SubtaskAttribution {
  const map = subtaskCommitMap(commits)
  const bySubtask: Array<{ subtask: string; commits: string[] }> = []
  for (const [subtask, shas] of map) {
    bySubtask.push({ subtask, commits: shas })
  }
  bySubtask.sort((a, b) => a.subtask.localeCompare(b.subtask))
  return {
    bySubtask,
    unattributed: unattributedCommits(commits).map((c) => c.sha),
  }
}
