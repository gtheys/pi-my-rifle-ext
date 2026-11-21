// AIDEV-NOTE: PMR-06RH — tooling-owned retry budget. The agent reports each
// attempt's outcome here instead of counting in its head: the tool owns the
// RetryState (per ref; the in-memory Map is the runtime cache seeded from the
// durable ledger) and nextAttempt decides retry vs escalate. Escalation is
// surfaced as a tool error AND an aven note; after it, further attempts for
// the ref are refused without a new note (PMR-2HFC).
// AIDEV-NOTE: PMR-XTQQ 4.2 — the budget IS durable now: every transition is
// journaled as an `attempt-record` event via the writer seam, and a fresh
// instance seeds its Map from the journal's latest snapshot for the ref
// (null/absent → startRetry, i.e. today's fresh-session behavior). Degrade is
// best-effort like every journal write: a ledger read/io failure falls back
// to the in-memory-only Map — the budget must never brick the tool. The aven
// escalation-note path is unchanged.

import { promises as fs } from 'node:fs'
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { applyAvenErrorLabel, writeAvenNote } from '../aven/client.ts'
import {
  type AttemptResult,
  MAX_ATTEMPTS,
  nextAttempt,
  type RetryState,
  startRetry,
} from '../implement/retry.ts'
import {
  type FlowRunEvent,
  isYoloRun,
  readRunEvents,
  recordRunEvent,
} from '../run-state.ts'
import { toolResult } from './result.ts'

export type AttemptOutcome = 'passed' | 'retry' | 'escalate'

/**
 * AIDEV-NOTE: PMR-XTQQ 4.2 — durable twin of the in-memory RetryState Map.
 * `seed` returns the ref's journaled budget count (null = no journal /
 * unreadable / no snapshot yet); `record` journals the post-transition
 * snapshot. Both are best-effort: callers swallow failures and degrade to
 * in-memory behavior.
 */
export interface AttemptLedger {
  seed(ref: string): Promise<number | null>
  record(ref: string, outcome: AttemptOutcome, attempts: number): Promise<void>
}

/**
 * AIDEV-NOTE: PMR-XTQQ 4.2 — default ledger over the run journal. Reads via
 * readRunEvents (last-wins `attempt-record` per ref; 'passed' → 0). Writes
 * via the injected `record` fn (index.ts threads the mode-aware writer seam,
 * journal-only while the daemon owns the projection); absent = today's full
 * recordRunEvent path. All io is swallowed by the tool — never brick.
 */
export function createAttemptLedger(
  agentDir: string,
  deps: {
    readFile?: (p: string) => Promise<string>
    record?: (event: FlowRunEvent) => Promise<void>
  } = {},
): AttemptLedger {
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))
  return {
    seed: async (ref) => {
      const events = await readRunEvents(agentDir, ref, { readFile })
      if (events === null) return null
      // AIDEV-NOTE: PMR-5HTN — pick the TRUE latest by timestamp, not file
      // order: a nested worker and the main session append to the same
      // journal with O_APPEND, and file order can interleave an older
      // snapshot after a newer one, which would seed the budget from a stale
      // count and REGRESS it (fail-open). ISO timestamps from one host sort
      // lexicographically; equal timestamps fall back to file order (>=).
      let latest: number | null = null
      let latestAt: string | null = null
      for (const event of events) {
        if (event.kind !== 'attempt-record') continue
        if (event.ref !== ref) continue
        const value = event.outcome === 'passed' ? 0 : event.attempts
        if (latestAt === null || event.at >= latestAt) {
          latestAt = event.at
          latest = value
        }
      }
      return latest
    },
    record: async (ref, outcome, attempts) => {
      const event: FlowRunEvent = {
        kind: 'attempt-record',
        at: new Date().toISOString(),
        ref,
        tool: 'flow_run_attempt',
        outcome,
        attempts,
      }
      if (deps.record !== undefined) {
        try {
          await deps.record(event)
        } catch {
          // best-effort — journal failures never break the budget
        }
        return
      }
      try {
        await recordRunEvent(agentDir, event)
      } catch {
        // best-effort — journal failures never break the budget
      }
    },
  }
}

export function registerRunAttemptTool(
  pi: ExtensionAPI,
  ledger: AttemptLedger = createAttemptLedger(getAgentDir()),
  // AIDEV-NOTE: yolo 5.2 — injectable seams (production defaults), mirroring
  // the 3.1/3.2 pattern in phase-complete/spec-approve: tests stub both the
  // yolo read and the label write. `error` is a type label, outside
  // lifecycleLabelMutation, applied on yolo escalations only; a label
  // failure never changes the escalation result.
  deps: {
    isYoloRunFn?: (ref: string) => Promise<boolean>
    applyErrorLabel?: (ref: string) => Promise<boolean>
  } = {},
): void {
  const isYoloRunFn = deps.isYoloRunFn ?? isYoloRun
  const applyErrorLabel = deps.applyErrorLabel ?? applyAvenErrorLabel
  const retryStates = new Map<string, RetryState>()
  pi.registerTool({
    name: 'flow_run_attempt',
    label: 'flow run attempt',
    description:
      'Record one test attempt for a flow task and get the retry decision from the owned budget (3 total attempts, then escalate). The 3rd failing attempt returns an escalation error — STOP and report to the human; further attempts are refused (the budget persists in the run journal and resets when an attempt passes).',
    promptSnippet:
      'Retry-budget tracking for flow test attempts — report every attempt result here.',
    promptGuidelines: [
      'After EVERY test run in this phase, call flow_run_attempt with the outcome before deciding the next step — never count attempts yourself.',
      'An escalation result means STOP: report to the human, do not run further attempts.',
    ],
    parameters: Type.Object({
      ref: Type.String({ description: 'Aven ticket ref, e.g. PMR-ABC1' }),
      result: Type.Object({
        ok: Type.Boolean({ description: 'Whether the test attempt passed' }),
        lastError: Type.Optional(
          Type.String({ description: 'The failing test’s error message' }),
        ),
        commands: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Commands run in this attempt',
          }),
        ),
        hypothesis: Type.Optional(
          Type.String({ description: 'What this attempt tried to change' }),
        ),
      }),
    }),
    async execute(
      _toolCallId: string,
      params: {
        ref: string
        result: AttemptResult
      },
    ): Promise<AgentToolResult<{ ok: boolean; status: string }>> {
      // AIDEV-NOTE: PMR-XTQQ 4.2 — journal each transition outcome.
      // Best-effort: an io failure is swallowed and the tool degrades to the
      // in-memory Map — the budget must never brick the tool.
      const journalOutcome = async (
        outcome: AttemptOutcome,
        attempts: number,
      ): Promise<void> => {
        try {
          await ledger.record(params.ref, outcome, attempts)
        } catch {
          // degrade to in-memory behavior
        }
      }
      let state = retryStates.get(params.ref)
      if (state === undefined) {
        // AIDEV-NOTE: PMR-XTQQ 4.2 — first call per ref: seed from the
        // journal's latest attempt-record; io failure → startRetry (degrade
        // to in-memory, never brick).
        let count: number | null
        try {
          count = await ledger.seed(params.ref)
        } catch {
          count = null
        }
        if (count === null) {
          state = startRetry()
        } else if (count >= MAX_ATTEMPTS) {
          state = { attempts: MAX_ATTEMPTS }
        } else {
          state = { attempts: count }
        }
      }
      // AIDEV-NOTE: PMR-2HFC — already exhausted: refuse without re-running
      // the machine, so no duplicate escalation note is written.
      if (state.attempts >= MAX_ATTEMPTS) {
        return toolResult(
          `flow_run_attempt: retry budget already exhausted for ${params.ref} — attempt refused. STOP and report to the human; do not run further attempts.`,
          { ok: false, status: 'escalate' },
          { isError: true },
        )
      }
      const transition = nextAttempt(state, params.result)
      if (transition.status === 'passed') {
        await journalOutcome('passed', 0)
        retryStates.delete(params.ref)
        return toolResult(
          `flow_run_attempt: tests passed for ${params.ref} — commit the green change`,
          { ok: true, status: 'passed' },
        )
      }
      if (transition.status === 'retry') {
        await journalOutcome('retry', transition.state.attempts)
        retryStates.set(params.ref, transition.state)
        return toolResult(
          `flow_run_attempt: attempt ${transition.state.attempts}/${MAX_ATTEMPTS} failed for ${params.ref} — retry permitted (${MAX_ATTEMPTS - transition.state.attempts} left in budget)`,
          { ok: false, status: 'retry' },
        )
      }
      const e = transition.escalation
      const note = `escalated after ${MAX_ATTEMPTS} failed attempts — commands: ${e.commands.join(' ; ') || 'none recorded'}; last error: ${e.lastError}; hypothesis: ${e.hypothesis}`
      const noted = await writeAvenNote(params.ref, note)
      // AIDEV-NOTE: yolo 5.2 — best-effort `error` label on the escalation
      // path, yolo runs only. Mirrors 5.1: never throws, failure only adds a
      // suffix and never changes the escalation result; further attempts stay
      // refused as before.
      let labelSuffix = ''
      let yolo = false
      try {
        yolo = await isYoloRunFn(params.ref)
      } catch {
        yolo = false
      }
      if (yolo) {
        let labeled = false
        try {
          labeled = await applyErrorLabel(params.ref)
        } catch {
          labeled = false
        }
        if (!labeled) {
          labelSuffix = ' (error label write FAILED — record this manually)'
        }
      }
      await journalOutcome('escalate', MAX_ATTEMPTS)
      // Keep the exhausted state so further reports keep escalating instead
      // of silently restarting the budget.
      retryStates.set(params.ref, { attempts: MAX_ATTEMPTS })
      let suffix = labelSuffix
      if (!noted) {
        suffix += ' (aven note write FAILED — record this manually)'
      }
      return toolResult(
        `flow_run_attempt: retry budget exhausted for ${params.ref} — ESCALATE to the human. ${note}${suffix}`,
        { ok: false, status: 'escalate' },
        { isError: true },
      )
    },
  })
}
