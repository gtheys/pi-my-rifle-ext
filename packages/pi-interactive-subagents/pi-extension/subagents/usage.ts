// Token/cost usage accounting (PMR-874G). Ported from pi-herdsman's
// project-usage rollup (Apache-2.0): usage is summed from Pi-native session
// jsonl entries (assistant messages, toolResult summaries, branch_summary /
// compaction entries) — the same attribution rules as pi's own
// core/usage-totals.js. The rollup is display-only; the session file stays
// the authority. COVERAGE DISCIPLINE: when a session's usage is unavailable
// (unreadable file, no usage blocks) we surface a coverage flag, never a
// guessed number.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Session-accumulated token + cost totals (cost in USD). */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export interface UsageSummary {
  totals: UsageTotals
  /** False when no entry carried a usage block — never show invented zeros. */
  sawUsage: boolean
}

export function createUsageSummary(): UsageSummary {
  return {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    sawUsage: false,
  }
}

export function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// AIDEV-NOTE: mirrors pi's core/usage-totals.js attribution — assistant
// messages, toolResult summaries, and branch_summary/compaction entries can
// all carry usage. Anything else is ignored. Fail closed on malformed
// shapes: partial data still counts, a crash never does.
function addUsageBlock(summary: UsageSummary, usage: unknown): void {
  if (usage == null || typeof usage !== 'object') return
  const u = usage as Record<string, unknown>
  const cost = u.cost as Record<string, unknown> | undefined
  summary.totals.input += num(u.input)
  summary.totals.output += num(u.output)
  summary.totals.cacheRead += num(u.cacheRead)
  summary.totals.cacheWrite += num(u.cacheWrite)
  summary.totals.cost += num(cost?.total)
  summary.sawUsage = true
}

/** Add one parsed session entry's usage (if any) to the summary. Pure. */
export function addEntryUsage(summary: UsageSummary, entry: unknown): void {
  if (entry == null || typeof entry !== 'object') return
  const e = entry as Record<string, unknown>
  if (e.type === 'message') {
    const message = e.message as Record<string, unknown> | undefined
    if (message == null) return
    if (message.role === 'assistant' || message.role === 'toolResult') {
      addUsageBlock(summary, message.usage)
    }
    return
  }
  if (e.type === 'branch_summary' || e.type === 'compaction') {
    addUsageBlock(summary, e.usage)
  }
}

/** Pure summarizer over parsed session entries (unit-tested with fixtures). */
export function summarizeEntriesUsage(
  entries: readonly unknown[],
): UsageSummary {
  const summary = createUsageSummary()
  for (const entry of entries) {
    addEntryUsage(summary, entry)
  }
  return summary
}

/**
 * Full-file usage read for one session jsonl. Null when the file is missing
 * or unreadable (coverage gap — caller shows the flag, not a zero).
 */
export function readSessionUsage(sessionFile: string): UsageSummary | null {
  let size: number
  try {
    size = statSync(sessionFile).size
  } catch {
    return null
  }
  const tracker = createSessionUsageTracker()
  updateSessionUsageTracker(tracker, sessionFile, size)
  return tracker.summary
}

/**
 * Incremental append-only reader state. Session jsonl files only grow, so
 * the 1s status loop reparses just the new bytes per tick instead of the
 * whole file (same discipline as the activity-file reads).
 */
export interface SessionUsageTracker {
  /** Byte offset of the first unparsed byte. */
  offset: number
  summary: UsageSummary
}

export function createSessionUsageTracker(): SessionUsageTracker {
  return { offset: 0, summary: createUsageSummary() }
}

// AIDEV-NOTE: only COMPLETE lines are consumed (offset stops after the last
// newline) — a mid-write line is picked up on the next tick, never parsed
// half-written. File shrink (truncate/rotate — not expected for session
// jsonl) resets the tracker rather than double-counting from a stale offset.
export function updateSessionUsageTracker(
  tracker: SessionUsageTracker,
  sessionFile: string,
  knownSize?: number,
): void {
  let size: number
  if (knownSize !== undefined) {
    size = knownSize
  } else {
    try {
      size = statSync(sessionFile).size
    } catch {
      return
    }
  }
  if (size < tracker.offset) {
    tracker.offset = 0
    tracker.summary = createUsageSummary()
  }
  if (size === tracker.offset) return

  let chunk: string
  let fd: number
  try {
    fd = openSync(sessionFile, 'r')
  } catch {
    return
  }
  try {
    const buffer = Buffer.alloc(size - tracker.offset)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, tracker.offset)
    chunk = buffer.toString('utf8', 0, bytesRead)
  } catch {
    return
  } finally {
    closeSync(fd)
  }

  const lastNewline = chunk.lastIndexOf('\n')
  if (lastNewline === -1) return
  const complete = chunk.slice(0, lastNewline)
  tracker.offset += Buffer.byteLength(complete, 'utf8') + 1
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    try {
      addEntryUsage(tracker.summary, JSON.parse(line))
    } catch {
      // AIDEV-NOTE: one malformed line must not lose the whole chunk —
      // skip it (coverage is already best-effort display data).
    }
  }
}

/** Compact one-liner, e.g. `12.3k tok $0.0420`. Cost omitted when zero. */
export function formatUsageCompact(totals: UsageTotals): string {
  const tokens = totalTokens(totals)
  let tok: string
  if (tokens >= 1_000_000) {
    tok = `${(tokens / 1_000_000).toFixed(1)}M`
  } else if (tokens >= 1000) {
    tok = `${(tokens / 1000).toFixed(1)}k`
  } else {
    tok = String(tokens)
  }
  if (totals.cost <= 0) return `${tok} tok`
  let cost: string
  if (totals.cost < 1) {
    cost = totals.cost.toFixed(4)
  } else {
    cost = totals.cost.toFixed(2)
  }
  return `${tok} tok $${cost}`
}

/**
 * Parent session file from a session jsonl header (first line). Used to
 * build the ownership graph for the transitive rollup (PMR-874G). Reads
 * only the first chunk — session files grow to MBs. Null on any failure.
 */
export function readSessionParentFile(sessionFile: string): string | null {
  let fd: number
  try {
    fd = openSync(sessionFile, 'r')
  } catch {
    return null
  }
  let firstLine: string
  try {
    const buffer = Buffer.alloc(8192)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const chunk = buffer.toString('utf8', 0, bytesRead)
    const newline = chunk.indexOf('\n')
    if (newline === -1) return null
    firstLine = chunk.slice(0, newline)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
  try {
    const header = JSON.parse(firstLine) as Record<string, unknown>
    if (header.type !== 'session') return null
    if (typeof header.parentSession !== 'string') return null
    return header.parentSession
  } catch {
    return null
  }
}

/** One node of the ownership graph used for the transitive rollup. */
export interface UsageOwnershipNode {
  childId: string
  sessionFile: string
  /** Parent session file from the child session header; null for roots. */
  parentSessionFile: string | null
  /** Null when this node's usage is unavailable (coverage gap). */
  summary: UsageSummary | null
}

export interface UsageRollup {
  /** Self + all transitive descendants. */
  totals: UsageTotals
  /** True when any node in the subtree lacked usage data. */
  incomplete: boolean
}

// AIDEV-NOTE: herdsman's project-usage rollup — walk the ownership graph
// (child session `parentSession` headers + assignment records), sum self +
// descendants. Cycle-guarded: a malformed graph (A parents B parents A)
// terminates with the subtree marked incomplete, never an infinite loop or
// double count.
export function rollupUsageByOwnership(
  nodes: readonly UsageOwnershipNode[],
): Map<string, UsageRollup> {
  const bySession = new Map<string, UsageOwnershipNode>()
  for (const node of nodes) {
    bySession.set(node.sessionFile, node)
  }
  const rollups = new Map<string, UsageRollup>()

  function accumulate(
    node: UsageOwnershipNode,
    visiting: Set<string>,
  ): UsageRollup {
    const cached = rollups.get(node.childId)
    if (cached) return cached
    if (visiting.has(node.sessionFile)) {
      return {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        incomplete: true,
      }
    }
    visiting.add(node.sessionFile)
    const totals: UsageTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }
    let incomplete = false
    if (node.summary) {
      totals.input += node.summary.totals.input
      totals.output += node.summary.totals.output
      totals.cacheRead += node.summary.totals.cacheRead
      totals.cacheWrite += node.summary.totals.cacheWrite
      totals.cost += node.summary.totals.cost
      if (!node.summary.sawUsage) incomplete = true
    } else {
      incomplete = true
    }
    for (const child of nodes) {
      if (child.parentSessionFile !== node.sessionFile) continue
      if (child.childId === node.childId) continue
      const sub = accumulate(child, visiting)
      totals.input += sub.totals.input
      totals.output += sub.totals.output
      totals.cacheRead += sub.totals.cacheRead
      totals.cacheWrite += sub.totals.cacheWrite
      totals.cost += sub.totals.cost
      if (sub.incomplete) incomplete = true
    }
    visiting.delete(node.sessionFile)
    const rollup = { totals, incomplete }
    rollups.set(node.childId, rollup)
    return rollup
  }

  for (const node of nodes) {
    accumulate(node, new Set())
  }
  return rollups
}
