// AIDEV-NOTE (PMR-EA8X): /flow-cost command registration. All data access
// is injected so tests exercise the command purely; the offline ground-truth
// rollup lives in flow/cost-rows.ts (moved out of this module in PMR-8MQH 1.3
// so the daemon can reach it — this file re-exports it, see below). `--push`
// forwards aggregates to the Pushgateway (optional backend): push failures
// surface as warnings and never fail the report — the session files stay the
// authority.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isValidRef } from '../herdr/viewer.ts'
import { buildPushBody, formatCostReport, type PushResult } from './cost.ts'
import {
  type CostRollup,
  type CostRollupDeps,
  computeCostRollup,
} from './cost-rows.ts'

// AIDEV-NOTE (PMR-8MQH 1.3): computeCostRollup + CostRollup/CostRollupDeps
// live in flow/cost-rows.ts (node-only, daemon-reachable). Re-exported here so
// every existing importer (flow/cost-autopush.ts, index.ts, test/*) keeps its
// './cost-command.ts' import unchanged.
export { type CostRollup, type CostRollupDeps, computeCostRollup }

export interface FlowCostDeps extends CostRollupDeps {
  /** Push exposition body to the gateway; ok=false is a warning, not fatal. */
  push: (
    ref: string,
    body: string,
    mode?: 'work' | 'personal',
  ) => Promise<PushResult>
}

type ParsedCostArgs =
  | { kind: 'ok'; ref: string; push: boolean }
  | { kind: 'help' }

export function parseCostArgs(args: string): ParsedCostArgs {
  const tokens = args
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  let ref: string | null = null
  let push = false
  for (const token of tokens) {
    if (token === '--push') {
      push = true
      continue
    }
    if (ref === null) {
      ref = token
      continue
    }
    return { kind: 'help' }
  }
  if (ref === null) return { kind: 'help' }
  return { kind: 'ok', ref, push }
}

export function registerFlowCostCommand(
  pi: ExtensionAPI,
  deps: FlowCostDeps,
): void {
  pi.registerCommand('flow-cost', {
    description:
      'Per-ticket cost rollup from session files (offline ground truth). Usage: /flow-cost <ref> [--push]',
    handler: async (args, ctx) => {
      const parsed = parseCostArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /flow-cost <ref> [--push] — cost per worker/subtask/phase from the run journal + session files.',
          'info',
        )
        return
      }
      if (!isValidRef(parsed.ref)) {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: invalid ref (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}) — aborting.`,
          'warning',
        )
        return
      }
      const rollup = await computeCostRollup(parsed.ref, deps)
      if (rollup.kind === 'no-journal') {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: no run journal found — nothing to roll up.`,
          'warning',
        )
        return
      }
      if (rollup.kind === 'empty') {
        ctx.ui.notify(
          `/flow-cost ${parsed.ref}: journal has no subagent spawn notes (pre-attribution run?) — nothing to roll up.`,
          'info',
        )
        return
      }
      const { rows, durations, trackRef, mode, steps, events } = rollup
      ctx.ui.notify(
        formatCostReport(parsed.ref, rows, durations, steps ?? []),
        'info',
      )
      if (parsed.push) {
        const result = await deps.push(
          trackRef,
          buildPushBody(trackRef, rows, durations, events),
          mode,
        )
        if (result.ok) {
          ctx.ui.notify(
            `/flow-cost ${parsed.ref}: pushed aggregates to the pushgateway.`,
            'info',
          )
        } else {
          ctx.ui.notify(
            `/flow-cost ${parsed.ref}: pushgateway push FAILED (${result.error ?? 'unknown error'}) — report above is still the ground truth.`,
            'warning',
          )
        }
      }
    },
  })
}
