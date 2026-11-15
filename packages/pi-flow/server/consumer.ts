// AIDEV-NOTE: PMR-XTQQ — pending-record consumer (durable run server,
// subtask 3.3). Called from index.ts on session_start (after the binding
// restore) and on agent_settled when the loop is inactive: if the restored
// binding's ref has a pending record, consume it (rename-first, exactly-once
// — see server/pending.ts) and re-present `/flow <ref>` to the user.
//
// DEGRADE PATH (documented, not a bug): if sendUserMessage throws — e.g.
// because a run is already streaming, where a plain triggerTurn would be
// rejected and a deliverAs would be REQUIRED — consumption has already
// happened (correct: no duplicates), so we catch and notify the manual
// `/flow <ref>` fallback. session_start / settled timing makes plain
// injection the expected path.
//
// LATCH: an in-process per-ref Set owned by the caller (index.ts). It is
// added on a successful consumption attempt (before the send) and cleared by
// the /flow start path so a real rerun re-arms the consumer. agent_settled
// fires often; the latch plus the ENOENT-on-consumed rename contract makes
// repeated settles no-ops.
//
// The module is pure-ish: everything effectful (sender, fs, journal read)
// is injected, so tests use a fake sender + fake io and never need a live
// pi process.

import type { FlowRunEvent } from '../run-state.ts'
import { projectRunState, readRunEvents } from '../run-state.ts'
import {
  type ConsumePendingResult,
  consumePending,
  defaultPendingIo,
  isParkedLoop,
  type PendingIo,
} from './pending.ts'

export interface ResumeConsumerDeps {
  /** The flow ref from the restored binding. */
  ref: string
  agentDir: string
  pendingDir: string
  /** runServer.enabled kill switch — false short-circuits everything. */
  enabled: () => boolean
  /** True while a /flow loop is running in this process — no injection then. */
  loopActive: () => boolean
  /** In-process per-ref latch; caller clears entries on /flow start. */
  latch: Set<string>
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  /** pi.sendUserMessage seam. */
  send: (message: string) => void
  readRunEvents?: (
    agentDir: string,
    ref: string,
  ) => Promise<FlowRunEvent[] | null>
  consumePending?: (
    pendingDir: string,
    ref: string,
    verify: () => Promise<boolean> | boolean,
    io?: PendingIo,
  ) => Promise<ConsumePendingResult>
  io?: PendingIo
}

export function resumedMessage(ref: string): string {
  return `pi-flow: resumed parked run ${ref} — re-presented /flow ${ref}.`
}

/** Dropped/verify-fail fallback: today's manual-rerun wording. */
export function droppedMessage(ref: string): string {
  return `pi-flow: restored flow binding for ${ref}. The parked run record failed verification and was dropped — rerun /flow ${ref} to continue phases.`
}

/** sendUserMessage threw — manual rerun is the fallback. */
export function sendFailedMessage(ref: string): string {
  return `pi-flow: could not re-present /flow ${ref} automatically — run /flow ${ref} to resume the parked run.`
}

/**
 * Verify closure over the journal: parked = latest loop-state snapshot has
 * awaitingOutcome=true and status='running' (see server/pending.ts).
 */
async function isStillParked(
  deps: Pick<ResumeConsumerDeps, 'agentDir' | 'readRunEvents'>,
  ref: string,
): Promise<boolean> {
  const read = deps.readRunEvents ?? readRunEvents
  const events = await read(deps.agentDir, ref)
  if (events === null) return false
  const state = projectRunState(events)
  if (state === null) return false
  return isParkedLoop(state.loop)
}

/**
 * Maybe consume the pending record for `ref` and re-present `/flow <ref>`.
 * No-op when the kill switch is off, the loop is active, the latch holds, or
 * there is nothing pending. Never throws on consumption failure paths.
 */
export async function resumeParkedRun(deps: ResumeConsumerDeps): Promise<void> {
  if (!deps.enabled()) return
  if (deps.loopActive()) return
  if (deps.latch.has(deps.ref)) return
  const consume = deps.consumePending ?? consumePending
  const io = deps.io ?? defaultPendingIo
  let result: ConsumePendingResult
  try {
    result = await consume(
      deps.pendingDir,
      deps.ref,
      () => isStillParked(deps, deps.ref),
      io,
    )
  } catch (err) {
    deps.notify(
      `pi-flow: pending-record check for ${deps.ref} failed: ${String(err)}`,
      'warning',
    )
    return
  }
  if (result.consumed) {
    // Latch BEFORE the send: a streaming sendUserMessage throw must not cause
    // a second injection attempt on the next settle.
    deps.latch.add(deps.ref)
    deps.notify(resumedMessage(deps.ref), 'info')
    // NOTE: during streaming a deliverAs would be REQUIRED; the settle/startup
    // timing makes plain injection the expected path, and a throw is caught
    // above with the manual-fallback notify (documented degrade).
    try {
      deps.send(`/flow ${deps.ref}`)
    } catch (err) {
      deps.notify(`${sendFailedMessage(deps.ref)} (${String(err)})`, 'warning')
    }
    return
  }
  if ('dropped' in result && result.dropped) {
    deps.notify(droppedMessage(deps.ref), 'info')
  }
}
