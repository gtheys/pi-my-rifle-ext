// AIDEV-NOTE: PMR-XTQQ — the single seam every journal writer routes through.
// record() probes daemon liveness PER WRITE (plan decision 3: writes are
// phase-transition-frequency, never hot — no caching to invalidate) and hands
// projection ownership to the daemon by routing journal-only while it is
// alive; when absent (or runServer.enabled = false, plan decision 9) it falls
// back to today's full recordRunEvent path. Every write stays best-effort
// (the journal()/journalOnly() convention in index.ts): journal failures must
// never break a flow phase — aven labels remain the gate source of truth.
import {
  type FlowRunEvent,
  recordRunEvent,
  recordRunEventJournalOnly,
} from '../run-state.ts'
import { probeDaemon } from './lifecycle.ts'

/** Per-write liveness check. Throwing probes count as "daemon absent". */
export type DaemonAliveProbe = () => Promise<boolean>

export interface EventWriter {
  /** Route by liveness: journal-only while the daemon owns the projection.
   * Returns true when the event reached the journal file, false when the
   * write failed (best-effort: NEVER throws). flow_submit surfaces the
   * boolean as `journaled`, so the journaled:false contract holds in
   * production, not just for test fakes. */
  record(event: FlowRunEvent): Promise<boolean>
  /** Always journal-only (nested spawns, non-main processes). */
  recordJournalOnly(event: FlowRunEvent): Promise<void>
}

/**
 * Real probe over probeDaemon: pidfile liveness + version match, gated by the
 * runServer.enabled kill switch (disabled = always absent → full-writer
 * fallback permanently, and ensureDaemon never spawns).
 */
export function createDaemonAliveProbe(
  agentDir: string,
  isEnabled: () => boolean = () => true,
): DaemonAliveProbe {
  return async () => {
    if (!isEnabled()) return false
    const probe = await probeDaemon(agentDir)
    return probe.alive
  }
}

export function createEventWriter(
  agentDir: string,
  isDaemonAlive: DaemonAliveProbe,
): EventWriter {
  const journalOnlyWrite = async (event: FlowRunEvent): Promise<boolean> => {
    try {
      await recordRunEventJournalOnly(agentDir, event)
      return true
    } catch {
      // best-effort by design — but the outcome is REPORTED, so callers can
      // surface journaled:false (production-reachable contract).
      return false
    }
  }
  return {
    record: async (event) => {
      let alive: boolean
      try {
        alive = await isDaemonAlive()
      } catch {
        alive = false
      }
      if (alive) {
        return journalOnlyWrite(event)
      }
      try {
        await recordRunEvent(agentDir, event)
        return true
      } catch {
        // best-effort by design — never break the phase, but report failure.
        return false
      }
    },
    recordJournalOnly: async (event) => {
      // Void context: fire-and-forget callers ignore the outcome.
      await journalOnlyWrite(event)
    },
  }
}
