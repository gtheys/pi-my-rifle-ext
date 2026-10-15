// Context retirement (PMR-1EC3). Port of herdsman's contextRetirement
// policy (ADR 0010: finish-and-hand-off, deterministic, governable),
// re-scoped to the PARENT session: once automatic compaction pressure
// arrives (session_before_compact, reason threshold/overflow), settled
// subagent payloads (subagent_result / subagent_ask / subagent_message
// custom messages) are retired per provider request to durable refs on
// disk. The session file keeps full records — only the model-visible
// context stops growing with child history. We never cancel or replace
// pi's native compaction, so manual/emergency compaction is untouched
// and there is no loop-block risk.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSubagentsDataDir, subagentsDataRoot } from './dataroot.ts'

// AIDEV-NOTE: narrow structural type for the subset of pi's AgentMessage
// union we inspect (pi's CustomMessage). pi-coding-agent does not
// re-export AgentMessage, and a type-only dependency on pi-agent-core is
// not declared in this package.
export interface RetirableMessage {
  role: string
  customType?: string
  content?: unknown
  details?: unknown
}

export const RETIRABLE_CUSTOM_TYPES: readonly string[] = [
  'subagent_result',
  'subagent_ask',
  'subagent_message',
]

/** Stub prefix doubles as the already-retired marker (idempotent re-runs). */
export const RETIRED_STUB_PREFIX = '[retired subagent payload]'

/** Payloads smaller than this stay inline — retiring them buys nothing. */
export const DEFAULT_RETIREMENT_MIN_BYTES = 2048

/** Newest N retirable payloads keep their full text for the parent. */
export const DEFAULT_RETIREMENT_KEEP_RECENT = 1

export interface RetirementOptions {
  minBytes?: number
  keepRecent?: number
  /** Data-root override for tests; defaults to subagentsDataRoot(). */
  root?: string
}

export interface RetirementOutcome<T> {
  messages: T[]
  retired: number
}

/**
 * Pure arming decision (unit-tested). Retirement arms on automatic context
 * pressure only: threshold and overflow. Manual /compact never arms it —
 * the user asked for summarization, not retirement.
 */
export function shouldArmRetirement(
  reason: 'manual' | 'threshold' | 'overflow',
  enabled: boolean,
): boolean {
  if (!enabled) return false
  if (reason === 'manual') return false
  return true
}

interface RetirableDetails {
  name?: string
  resultPath?: string
  resultRef?: string
}

function narrowDetails(details: unknown): RetirableDetails {
  if (typeof details !== 'object' || details === null) return {}
  const raw = details as Record<string, unknown>
  const narrowed: RetirableDetails = {}
  if (typeof raw.name === 'string') narrowed.name = raw.name
  if (typeof raw.resultPath === 'string') narrowed.resultPath = raw.resultPath
  if (typeof raw.resultRef === 'string') narrowed.resultRef = raw.resultRef
  return narrowed
}

function isRetirableCandidate(
  msg: RetirableMessage,
  minBytes: number,
): boolean {
  if (msg.role !== 'custom') return false
  if (msg.customType === undefined) return false
  if (!RETIRABLE_CUSTOM_TYPES.includes(msg.customType)) return false
  if (typeof msg.content !== 'string') return false
  if (msg.content.startsWith(RETIRED_STUB_PREFIX)) return false
  return Buffer.byteLength(msg.content, 'utf8') >= minBytes
}

// AIDEV-NOTE: hash-named records make retirement idempotent across requests —
// the context hook re-runs on a fresh clone every provider call, and the same
// payload always resolves to the same path (exclusive create, losers reuse).
function writeRetiredPayload(
  customType: string,
  content: string,
  details: unknown,
  root?: string,
): string | null {
  const hash = createHash('sha256')
    .update(customType)
    .update('\0')
    .update(content)
    .digest('hex')
  const dir = ensureSubagentsDataDir('retired', root ?? subagentsDataRoot())
  const path = join(dir, `${hash}.json`)
  if (existsSync(path)) return path
  const record: Record<string, unknown> = {
    customType,
    content,
    retiredAt: new Date().toISOString(),
  }
  if (details !== undefined) record.details = details
  const serialized = JSON.stringify(record)
  try {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeSync(fd, serialized)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    if (existsSync(path)) return path
    return null
  }
  return path
}

export function buildRetirementStub(
  customType: string,
  name: string | undefined,
  refPath: string,
  resultRef: string | undefined,
): string {
  let subject = customType
  if (name !== undefined) subject = `${customType} "${name}"`
  let ref = refPath
  if (resultRef !== undefined) ref = `${refPath} (${resultRef})`
  return `${RETIRED_STUB_PREFIX} ${subject} — full text retired to ${ref}. Read that file if you need the complete payload.`
}

/**
 * Replace large settled-subagent payloads with durable-ref stubs. Returns
 * the input untouched (same array identity, retired 0) when nothing
 * qualifies; otherwise a new array with copied message objects. Never
 * mutates the input messages. The most recent `keepRecent` candidates stay
 * inline so the parent keeps the freshest result in full.
 */
export function retireSettledSubagentPayloads<T extends RetirableMessage>(
  messages: T[],
  opts: RetirementOptions = {},
): RetirementOutcome<T> {
  const minBytes = opts.minBytes ?? DEFAULT_RETIREMENT_MIN_BYTES
  const keepRecent = opts.keepRecent ?? DEFAULT_RETIREMENT_KEEP_RECENT

  const candidates: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg !== undefined && isRetirableCandidate(msg, minBytes)) {
      candidates.push(i)
    }
  }
  const retireCount = candidates.length - keepRecent
  if (retireCount <= 0) return { messages, retired: 0 }

  const out = messages.slice()
  let retired = 0
  for (let c = 0; c < retireCount; c++) {
    const index = candidates[c]
    if (index === undefined) continue
    const msg = out[index]
    if (msg === undefined || typeof msg.content !== 'string') continue
    const customType = msg.customType
    if (customType === undefined) continue

    const details = narrowDetails(msg.details)
    // subagent_result already has a durable record in the store (see
    // store.ts) — point at it instead of writing a second copy.
    let refPath: string | null = null
    let resultRef: string | undefined
    if (customType === 'subagent_result' && details.resultPath !== undefined) {
      if (existsSync(details.resultPath)) {
        refPath = details.resultPath
        resultRef = details.resultRef
      }
    }
    if (refPath === null) {
      refPath = writeRetiredPayload(
        customType,
        msg.content,
        msg.details,
        opts.root,
      )
    }
    if (refPath === null) continue

    out[index] = {
      ...msg,
      content: buildRetirementStub(
        customType,
        details.name,
        refPath,
        resultRef,
      ),
    }
    retired++
  }
  if (retired === 0) return { messages, retired: 0 }
  return { messages: out, retired }
}
