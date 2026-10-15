import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SNAPSHOT_STALLED_AFTER_MS = 60_000
export const DEFAULT_STATUS_LINE_LIMIT = 4
export const MAX_STATUS_NAME_LENGTH = 72
export const MAX_STATUS_LINE_LENGTH = 120

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, 'config.json')
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, 'config.json.example')

export type SubagentStatusKind =
  | 'starting'
  | 'active'
  | 'waiting'
  | 'blocked'
  | 'stalled'
  | 'running'
export type SubagentStatusSource = 'pi' | 'claude'
export type SubagentStatusTransition = 'stalled' | 'recovered' | null
export type StatusSnapshotState =
  | 'unseen'
  | 'present'
  | 'missing'
  | 'invalid'
  | 'wrong-id'
export type StatusActivityPhase =
  | 'starting'
  | 'active'
  | 'waiting'
  | 'blocked'
  | 'done'

// AIDEV-NOTE: pending parent→child control request (PMR-DNPZ). Tracked on the
// status state so the 1s refresh loop can observe the `.ack` sidecar and
// transition the request to acked/timeout; survives observeStatus spreads.
export interface PendingControlRequest {
  requestId: string
  kind: 'interrupt' | 'answer'
  sentAtMs: number
}

/** No ack within this window ⇒ expire and fall back to fire-and-forget. */
export const INTERRUPT_ACK_TIMEOUT_MS = 5_000

export interface StatusConfig {
  enabled: boolean
  lineLimit: number
}

export type StatusObservation =
  | {
      snapshot: 'present'
      updatedAt: number
      sequence: number
      phase: StatusActivityPhase
      active?: boolean
      activeScope?: string
      activeSince?: number
      waitingSince?: number
      blockedSince?: number
      latestEvent?: string
      activityLabel?: string
    }
  | {
      snapshot: 'missing' | 'invalid' | 'wrong-id'
      snapshotError?: string
    }

export interface SubagentStatusState {
  source: SubagentStatusSource
  startTimeMs: number
  firstObservationAtMs: number | null
  lastActivityAtMs: number | null
  lastActivitySequence: number | null
  localOverrideAtMs: number | null
  localOverrideSequence: number | null
  activeNow: boolean
  activeSinceMs: number | null
  activeScope: string | null
  waitingSinceMs: number | null
  blockedSinceMs: number | null
  phase: StatusActivityPhase | null
  latestEvent: string | null
  activityLabel: string | null
  snapshotState: StatusSnapshotState
  snapshotProblemSinceMs: number | null
  snapshotError: string | null
  currentKind: SubagentStatusKind
  pendingRequest: PendingControlRequest | null
}

export interface StatusSnapshot {
  kind: SubagentStatusKind
  elapsedMs: number
  elapsedText: string
  activeSinceMs: number | null
  activeDurationText: string | null
  activeScope: string | null
  waitingSinceMs: number | null
  blockedSinceMs: number | null
  waitingDurationText: string | null
  blockedDurationText: string | null
  latestEvent: string | null
  activityLabel: string | null
  snapshotState: StatusSnapshotState
  snapshotError: string | null
  snapshotProblemText: string | null
  statusLabel: string | null
}

export interface CappedStatusLines {
  visibleLines: string[]
  overflow: number
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`)
}

function requireObject(
  value: unknown,
  source: string,
  fieldName: string,
): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireBoolean(
  value: unknown,
  source: string,
  fieldName: string,
): boolean {
  if (typeof value !== 'boolean') {
    invalidStatusConfig(source, `${fieldName} must be a boolean`)
  }
  return value
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  )
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(
      source,
      `${fieldName} has unsupported key(s): ${unsupportedKeys.join(', ')}`,
    )
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  if (maxLength <= 1) return text.slice(0, maxLength)
  return `${text.slice(0, maxLength - 1)}…`
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim() || 'subagent'
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH)
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, ' ').trim(), MAX_STATUS_LINE_LENGTH)
}

function snapshotProblemLabel(
  snapshotState: StatusSnapshotState,
): string | null {
  if (snapshotState === 'wrong-id') return 'wrong activity id'
  return null
}

function activityLabel(
  snapshot: Pick<StatusSnapshot, 'activityLabel' | 'activeScope'>,
): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope
}

export function parseStatusConfig(
  rawConfig: unknown,
  source = 'config.json',
): StatusConfig {
  const config = requireObject(rawConfig, source, 'root')
  const status = requireObject(config.status, source, 'status')
  rejectUnsupportedKeys(status, ['enabled'], source, 'status')
  const enabled = requireBoolean(status.enabled, source, 'status.enabled')

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  }
}

function readStatusConfigFile(
  configPath: string,
  examplePath: string,
): { sourcePath: string; rawConfig: string } {
  try {
    return {
      sourcePath: configPath,
      rawConfig: readFileSync(configPath, 'utf8'),
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code !== 'ENOENT') throw error
  }

  try {
    return {
      sourcePath: examplePath,
      rawConfig: readFileSync(examplePath, 'utf8'),
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    if (errno.code === 'ENOENT') {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      )
    }
    throw error
  }
}

// AIDEV-NOTE: SUPERSEDED — runtime config now loads via config.ts
// (loadSubagentsConfig) from <agentDir>/pi-subagents/config.json with a
// project override in CONFIG_DIR_NAME. loadStatusConfig/config.json.example
// remain only for backwards compatibility and tests.
export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): StatusConfig {
  const { sourcePath, rawConfig } = readStatusConfigFile(
    configPath,
    examplePath,
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(rawConfig) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`)
  }

  return parseStatusConfig(parsed, sourcePath)
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`

  return `${minutes}m`
}

export function createStatusState(params: {
  source: SubagentStatusSource
  startTimeMs: number
}): SubagentStatusState {
  const initialKind = params.source === 'claude' ? 'running' : 'starting'
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    blockedSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === 'claude' ? 'unseen' : 'unseen',
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
    pendingRequest: null,
  }
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === 'claude') return state

  if (observation.snapshot !== 'present') {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    }
  }

  const updatedAt = observation.updatedAt
  const sequence = observation.sequence
  const lastActivityAtMs = state.lastActivityAtMs
  const lastActivitySequence = state.lastActivitySequence
  const olderThanLastActivity =
    lastActivityAtMs != null &&
    (updatedAt < lastActivityAtMs ||
      (updatedAt === lastActivityAtMs &&
        lastActivitySequence != null &&
        sequence < lastActivitySequence))
  if (olderThanLastActivity) return state

  const blockedByLocalOverride =
    state.localOverrideAtMs != null &&
    (updatedAt < state.localOverrideAtMs ||
      (updatedAt === state.localOverrideAtMs &&
        state.localOverrideSequence != null &&
        sequence <= state.localOverrideSequence))
  if (blockedByLocalOverride) return state

  const phase = observation.phase
  const activeNow = phase === 'active' || observation.active === true
  const activeSinceMs = activeNow
    ? (observation.activeSince ?? state.activeSinceMs ?? updatedAt)
    : null
  const waitingSinceMs =
    phase === 'waiting'
      ? (observation.waitingSince ?? state.waitingSinceMs ?? updatedAt)
      : null
  // AIDEV-NOTE: blocked ≠ waiting (PMR-WXG0) — a child sitting in ask_owner
  // keeps its own since-timestamp so the status line can show "blocked".
  const blockedSinceMs =
    phase === 'blocked'
      ? (observation.blockedSince ?? state.blockedSinceMs ?? updatedAt)
      : null

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? (observation.activeScope ?? null) : null,
    waitingSinceMs,
    blockedSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: 'present',
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  }
}

export function forceStatusAfterInterrupt(
  state: SubagentStatusState,
  now: number,
): SubagentStatusState {
  if (state.source === 'claude') return state

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    blockedSinceMs: null,
    phase: 'waiting',
    latestEvent: 'interrupt_requested',
    activityLabel: 'interrupted',
    snapshotState: 'present',
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: 'waiting',
  }
}

export function markPendingRequest(
  state: SubagentStatusState,
  pending: PendingControlRequest,
): SubagentStatusState {
  return { ...state, pendingRequest: pending }
}

export type PendingAckOutcome = 'acked' | 'ignored'

// AIDEV-NOTE: identity revalidation — only an ack carrying the exact requestId
// we sent is applied; wrong-id acks are ignored (state untouched) so a stale
// sidecar from a superseded request can never satisfy a newer one.
export function applyPendingAck(
  state: SubagentStatusState,
  ackRequestId: string,
): { state: SubagentStatusState; outcome: PendingAckOutcome } {
  const pending = state.pendingRequest
  if (!pending || pending.requestId !== ackRequestId) {
    return { state, outcome: 'ignored' }
  }
  return {
    state: {
      ...state,
      pendingRequest: null,
      latestEvent: 'interrupt_acked',
    },
    outcome: 'acked',
  }
}

export type PendingExpiryOutcome = 'pending' | 'timeout'

/** Expire the pending request once the bounded ack window elapses. */
export function expirePendingRequest(
  state: SubagentStatusState,
  now: number,
  timeoutMs: number = INTERRUPT_ACK_TIMEOUT_MS,
): { state: SubagentStatusState; outcome: PendingExpiryOutcome } {
  const pending = state.pendingRequest
  if (!pending || now - pending.sentAtMs < timeoutMs) {
    return { state, outcome: 'pending' }
  }
  return {
    state: {
      ...state,
      pendingRequest: null,
      latestEvent: 'interrupt_unacknowledged',
    },
    outcome: 'timeout',
  }
}

function lastHealthyKindOf(state: SubagentStatusState): SubagentStatusKind {
  if (state.activeNow) return 'active'
  if (state.phase === 'blocked') return 'blocked'
  if (state.waitingSinceMs != null || state.phase === 'done') return 'waiting'
  if (state.currentKind === 'stalled') return 'starting'
  return state.currentKind
}

// AIDEV-NOTE (PMR-SMHB): a 'wrong-id' read means the activity file exists and
// some live child is writing it, but its runningChildId disagrees with our
// bookkeeping (identity churn: resume/reload/re-key paths hand out a new id
// while the old writer keeps going, or vice versa). That is identity
// ambiguity, not inactivity — a writer being present is evidence of life, so
// the 60s problem-age escalation must NEVER claim 'stalled' for it (fail
// closed: a possibly-alive child is never reported dead). Hold the last
// healthy kind ('starting' when identity was never validated) and keep the
// diagnostic label so the mismatch stays visible.
function classifyProblemState(
  state: SubagentStatusState,
  now: number,
): Pick<StatusSnapshot, 'kind' | 'statusLabel'> {
  const problemLabel = snapshotProblemLabel(state.snapshotState)
  const hasValidSnapshot = state.lastActivityAtMs != null

  if (state.snapshotState === 'wrong-id') {
    if (!hasValidSnapshot) {
      return { kind: 'starting', statusLabel: problemLabel }
    }
    return { kind: lastHealthyKindOf(state), statusLabel: problemLabel }
  }

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs
    const elapsedMs = Math.max(0, now - referenceMs)
    if (elapsedMs >= SNAPSHOT_STALLED_AFTER_MS) {
      return { kind: 'stalled', statusLabel: problemLabel }
    }
    return { kind: 'starting', statusLabel: null }
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now
  const problemMs = Math.max(0, now - problemSinceMs)
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) {
    return { kind: 'stalled', statusLabel: problemLabel }
  }

  return { kind: lastHealthyKindOf(state), statusLabel: problemLabel }
}

export function classifyStatus(
  state: SubagentStatusState,
  now: number,
): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs)
  const elapsedText = formatElapsedDuration(elapsedMs)

  if (state.source === 'claude') {
    return {
      kind: 'running',
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      blockedSinceMs: null,
      waitingDurationText: null,
      blockedDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    }
  }

  let kind: SubagentStatusKind
  let statusLabel: string | null = null

  if (state.snapshotState === 'present') {
    if (state.phase === 'active' || state.activeNow) {
      kind = 'active'
    } else if (state.phase === 'blocked') {
      // AIDEV-NOTE: blocked ≠ stalled (PMR-WXG0) — a blocked-asking child is
      // intentionally waiting for its owner and must never trip the 60s
      // snapshot-staleness rule, no matter how quiet it goes at its prompt.
      kind = 'blocked'
    } else if (state.phase === 'waiting') {
      kind = 'waiting'
    } else if (state.phase === 'done') {
      kind = 'waiting'
      statusLabel = 'done'
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs)
      kind =
        elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS
          ? 'stalled'
          : 'starting'
      statusLabel = null
    }
  } else {
    const classified = classifyProblemState(state, now)
    kind = classified.kind
    statusLabel = classified.statusLabel
  }

  const activeDurationText =
    state.activeSinceMs == null
      ? null
      : formatElapsedDuration(now - state.activeSinceMs)
  const waitingDurationText =
    state.waitingSinceMs == null
      ? null
      : formatElapsedDuration(now - state.waitingSinceMs)
  const blockedDurationText =
    state.blockedSinceMs == null
      ? null
      : formatElapsedDuration(now - state.blockedSinceMs)
  const snapshotProblemText =
    state.snapshotProblemSinceMs == null
      ? null
      : formatElapsedDuration(now - state.snapshotProblemSinceMs)

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    blockedSinceMs: state.blockedSinceMs,
    waitingDurationText,
    blockedDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  }
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState
  snapshot: StatusSnapshot
  transition: SubagentStatusTransition
} {
  const snapshot = classifyStatus(state, now)
  const transition =
    state.currentKind !== 'stalled' && snapshot.kind === 'stalled'
      ? 'stalled'
      : state.currentKind === 'stalled' &&
          (snapshot.kind === 'active' || snapshot.kind === 'waiting')
        ? 'recovered'
        : null

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  }
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot)
  if (!label) return 'active'
  const duration = snapshot.activeDurationText
    ? ` ${snapshot.activeDurationText}`
    : ''
  return `active (${label}${duration})`
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText
    ? ` ${snapshot.waitingDurationText}`
    : ''
  return `waiting${duration}`
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : ''
  const duration = snapshot.snapshotProblemText
    ? ` ${snapshot.snapshotProblemText}`
    : ''
  return `stalled${duration}${detail}`
}

export function formatStatusLine(
  name: string,
  snapshot: StatusSnapshot,
): string {
  const boundedName = normalizeStatusName(name)

  if (snapshot.kind === 'starting') {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : ''
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, starting${label}.`,
    )
  }

  if (snapshot.kind === 'running') {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`)
  }

  if (snapshot.kind === 'active') {
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`,
    )
  }

  if (snapshot.kind === 'blocked') {
    const duration = snapshot.blockedDurationText
      ? ` ${snapshot.blockedDurationText}`
      : ''
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, blocked (waiting for owner${duration}).`,
    )
  }

  if (snapshot.kind === 'waiting') {
    const problem =
      snapshot.statusLabel && snapshot.statusLabel !== 'done'
        ? ` (${snapshot.statusLabel})`
        : snapshot.statusLabel === 'done'
          ? ' (done)'
          : ''
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`,
    )
  }

  return boundStatusLine(
    `${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`,
  )
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name)

  if (transition === 'recovered') {
    const detail =
      snapshot.kind === 'waiting'
        ? formatWaitingDetail(snapshot)
        : formatActiveDetail(snapshot)
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`,
    )
  }

  return formatStatusLine(boundedName, snapshot)
}

export function capStatusLines(
  lines: string[],
  lineLimit: number,
): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit)
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  }
}

export function formatStatusAggregate(
  lines: string[],
  lineLimit: number,
): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit)
  const bulletLines = visibleLines.map((line) => `• ${line}`)
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`)
  return `Subagent status:\n${bulletLines.join('\n')}`
}
