// AIDEV-NOTE: automatic cost push at the end of a flow run. The manual
// `/flow-cost <ref> --push` step is what put cost metrics in Prometheus, so
// runs nobody pushed had no cost (and no per-phase bars). The loop now calls
// this on every terminal transition (done, halt, pause). Env-gated exactly
// like the manual push: PI_FLOW_PUSHGATEWAY_URL unset = nothing happens, not
// even a journal read. Idempotent — the Pushgateway group for the ref is
// replaced, so a rerun/resume simply refreshes the numbers. Never throws:
// failures become one warning, and /flow-cost remains the ground truth.
import { buildPushBody } from './cost.ts'
import { computeCostRollup, type FlowCostDeps } from './cost-command.ts'

export interface CostAutoPushDeps extends FlowCostDeps {
  /** True when a Pushgateway URL is configured (env PI_FLOW_PUSHGATEWAY_URL). */
  enabled: () => boolean
  notify: (message: string, level: 'info' | 'warning') => void
  /**
   * Let the journal's fire-and-forget appends land before re-reading it
   * (the loop writes phase-complete / "flow complete" right before it ends
   * the run). Default 1500 ms; tests inject an immediate resolver.
   */
  settle?: () => Promise<void>
}

export function createCostAutoPush(
  deps: CostAutoPushDeps,
): (ref: string) => Promise<void> {
  return async (ref) => {
    if (!deps.enabled()) return
    try {
      const settle =
        deps.settle ?? (() => new Promise<void>((r) => setTimeout(r, 1500)))
      await settle()
      const rollup = await computeCostRollup(ref, deps)
      if (rollup.kind !== 'ok') return
      const result = await deps.push(
        rollup.trackRef,
        buildPushBody(rollup.trackRef, rollup.rows, rollup.durations),
        rollup.mode,
      )
      if (result.ok) {
        deps.notify(`${ref}: cost metrics pushed to the pushgateway.`, 'info')
        return
      }
      deps.notify(
        `${ref}: automatic cost push FAILED (${result.error ?? 'unknown error'}) — run /flow-cost ${ref} --push to retry.`,
        'warning',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.notify(
        `${ref}: automatic cost push failed (${message}) — run /flow-cost ${ref} --push to retry.`,
        'warning',
      )
    }
  }
}
