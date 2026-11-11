// AIDEV-NOTE: pi-bash-guard — human approval gate for destructive bash
// commands, the strands-decider pattern (https://github.com/strands-labs/
// strands-decider): a small calibrated "system one" decision model classifies
// each command safe/destructive; safe-with-high-confidence auto-runs,
// everything else waits for a human Allow/Deny dialog. Deterministic tiers
// around it (classify.ts) keep the obvious cases off the model entirely.
//
// Decision order per bash tool_call:
//   0. disabled or already human-approved this session  -> allow
//   1. deny tier (mkfs, fork bomb, curl|sh, ...)        -> block, no approval
//   2. allowlist tier (single read-only command)        -> allow
//   3. decider verdict over HTTP                        -> allow / confirm
//   4. ctx.ui.confirm (human)                           -> allow once / block
// Every tier-3/4 decision is journaled via pi.appendEntry('bash-guard', ...)
// so sessions have an audit trail. Fail-closed everywhere: decider
// unreachable, unparseable answer, or no UI to ask in -> block, never a
// silent allow. A human running bash by hand is out of scope (humans own
// the machine) — the boundary is the agent's bash TOOL.
import { createHash } from 'node:crypto'
import type {
  ExtensionAPI,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'
import { classifyCommand, confirmMessage, deciderOutcome } from './classify.ts'
import {
  type BashGuardConfig,
  resolveConfig,
  scaffoldSchema,
} from './config.ts'
import {
  askDecider,
  type DeciderFetch,
  type DeciderVerdict,
} from './decider.ts'

export type GuardStats = {
  allowedAllowlist: number
  denied: number
  deciderAllowed: number
  confirmed: number
  humanDenied: number
  failClosed: number
}

export function createGuardStats(): GuardStats {
  return {
    allowedAllowlist: 0,
    denied: 0,
    deciderAllowed: 0,
    confirmed: 0,
    humanDenied: 0,
    failClosed: 0,
  }
}

// AIDEV-NOTE: decision core kept as one injectable function so tests drive it
// with a fake decider + fake confirm and no Pi session. The index.ts handler
// is a thin wrapper: load config, call this, journal, return.
export type ConfirmFn = (message: string) => Promise<boolean>

export type GuardDecision =
  | { action: 'allow'; why: 'allowlist' | 'approved' | 'decider' }
  | {
      action: 'block'
      why: 'deny-tier' | 'human-denied' | 'fail-closed'
      reason: string
    }

export async function guardDecision(
  command: string,
  cfg: BashGuardConfig,
  approved: Set<string>,
  confirm: ConfirmFn | null,
  askDeciderFn: typeof askDecider,
  fetchImpl: DeciderFetch,
  stats: GuardStats,
): Promise<GuardDecision> {
  const commandKey = createHash('sha256').update(command).digest('hex')
  if (approved.has(commandKey)) return { action: 'allow', why: 'approved' }

  const classified = classifyCommand(command)
  if (classified.tier === 'deny') {
    stats.denied += 1
    return {
      action: 'block',
      why: 'deny-tier',
      reason: `pi-bash-guard: refused outright (${classified.reason}) — this pattern is never run from an agent session; run it by hand if you really need it`,
    }
  }
  if (classified.tier === 'allow') {
    stats.allowedAllowlist += 1
    return { action: 'allow', why: 'allowlist' }
  }

  const verdict: DeciderVerdict = await askDeciderFn(
    cfg.deciderUrl,
    command,
    cfg.timeoutMs,
    fetchImpl,
  )
  const outcome = deciderOutcome(verdict, cfg.threshold)
  if (outcome.action === 'allow') {
    stats.deciderAllowed += 1
    return { action: 'allow', why: 'decider' }
  }

  if (confirm === null) {
    stats.failClosed += 1
    return {
      action: 'block',
      why: 'fail-closed',
      reason: `pi-bash-guard: ${outcome.detail}, and no dialog UI is available to ask for approval — command blocked`,
    }
  }
  const ok = await confirm(confirmMessage(command, outcome))
  if (!ok) {
    stats.humanDenied += 1
    return {
      action: 'block',
      why: 'human-denied',
      reason: `pi-bash-guard: human denied this command (${outcome.detail})`,
    }
  }
  stats.confirmed += 1
  if (cfg.rememberApproval) approved.add(commandKey)
  return { action: 'allow', why: 'decider' }
}

export default function bashGuardExtension(pi: ExtensionAPI): void {
  const approved = new Set<string>()
  const stats = createGuardStats()

  pi.on('session_start', async (event) => {
    if (event.reason !== 'startup') return
    await scaffoldSchema()
  })

  // AIDEV-NOTE: the tool_call handler is async (ExtensionHandler allows
  // Promise<R>); Pi awaits it before the tool runs, so the decider round-trip
  // and the blocking confirm dialog both gate the real execution. Same
  // interception surface pi-flow's landing gate uses.
  pi.on(
    'tool_call',
    async (event, ctx): Promise<ToolCallEventResult | undefined> => {
      if (!isToolCallEventType('bash', event)) return undefined
      const cfg = await resolveConfig(ctx.cwd)
      if (!cfg.enabled) return undefined
      const canConfirm = ctx.hasUI && ctx.mode !== 'print'
      let confirmFn: ConfirmFn | null = null
      if (canConfirm) {
        confirmFn = (message: string) => ctx.ui.confirm('bash-guard', message)
      }
      const decision = await guardDecision(
        event.input.command,
        cfg,
        approved,
        confirmFn,
        askDecider,
        fetch as unknown as DeciderFetch,
        stats,
      )
      if (decision.action === 'allow') {
        if (decision.why !== 'allowlist') {
          pi.appendEntry('bash-guard', {
            command: event.input.command,
            decision: decision.why,
          })
        }
        return undefined
      }
      pi.appendEntry('bash-guard', {
        command: event.input.command,
        decision: decision.why,
        reason: decision.reason,
      })
      return { block: true, reason: decision.reason, terminate: true }
    },
  )

  // /bash-guard — status: config, decider reachability, session counters.
  pi.registerCommand('bash-guard', {
    description:
      'pi-bash-guard status: config, decider reachability, session counters',
    handler: async (args, ctx) => {
      if (args.trim() !== '') {
        ctx.ui.notify(
          'Usage: /bash-guard (no arguments — shows status)',
          'warning',
        )
        return
      }
      const cfg = await resolveConfig(ctx.cwd)
      let decider: string
      try {
        const response = await fetch(`${cfg.deciderUrl}/health`, {
          signal: AbortSignal.timeout(cfg.timeoutMs),
        })
        if (response.ok) {
          decider = `reachable (${cfg.deciderUrl})`
        } else {
          decider = `answered HTTP ${response.status} (${cfg.deciderUrl})`
        }
      } catch {
        decider = `UNREACHABLE (${cfg.deciderUrl}) — tier-3 commands will all need manual confirmation`
      }
      const lines = [
        `pi-bash-guard ${cfg.enabled ? 'enabled' : 'DISABLED'}`,
        `decider: ${decider}`,
        `threshold: ${cfg.threshold} · timeout: ${cfg.timeoutMs}ms · rememberApproval: ${cfg.rememberApproval}`,
        'session counters:',
        `  allowlisted: ${stats.allowedAllowlist}`,
        `  decider-allowed: ${stats.deciderAllowed}`,
        `  human-confirmed: ${stats.confirmed}`,
        `  human-denied: ${stats.humanDenied}`,
        `  hard-denied: ${stats.denied}`,
        `  fail-closed: ${stats.failClosed}`,
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}
