// AIDEV-NOTE: PMR-06RH — tooling-owned retry budget. The agent reports each
// attempt's outcome here instead of counting in its head: the tool owns the
// in-memory RetryState (per ref, per session — no persistence by design;
// aven notes are the durable record) and nextAttempt decides retry vs
// escalate. Escalation is surfaced as a tool error AND an aven note; after
// it, further attempts for the ref are refused without a new note (PMR-2HFC).
// The state is in-memory per session: a session restart or a passing attempt
// clears it, so the budget is NOT durable across restarts.
import type {
  AgentToolResult,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { writeAvenNote } from '../aven/client.ts'
import {
  type AttemptResult,
  MAX_ATTEMPTS,
  nextAttempt,
  type RetryState,
  startRetry,
} from '../implement/retry.ts'
import { toolResult } from './result.ts'

export function registerRunAttemptTool(pi: ExtensionAPI): void {
  const retryStates = new Map<string, RetryState>()
  pi.registerTool({
    name: 'flow_run_attempt',
    label: 'flow run attempt',
    description:
      'Record one test attempt for a flow task and get the retry decision from the owned budget (3 total attempts, then escalate). The 3rd failing attempt returns an escalation error — STOP and report to the human; further attempts are refused (the budget is per session and resets when the session restarts).',
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
      const state = retryStates.get(params.ref) ?? startRetry()
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
        retryStates.delete(params.ref)
        return toolResult(
          `flow_run_attempt: tests passed for ${params.ref} — commit the green change`,
          { ok: true, status: 'passed' },
        )
      }
      if (transition.status === 'retry') {
        retryStates.set(params.ref, transition.state)
        return toolResult(
          `flow_run_attempt: attempt ${transition.state.attempts}/${MAX_ATTEMPTS} failed for ${params.ref} — retry permitted (${MAX_ATTEMPTS - transition.state.attempts} left in budget)`,
          { ok: false, status: 'retry' },
        )
      }
      const e = transition.escalation
      const note = `escalated after ${MAX_ATTEMPTS} failed attempts — commands: ${e.commands.join(' ; ') || 'none recorded'}; last error: ${e.lastError}; hypothesis: ${e.hypothesis}`
      const noted = await writeAvenNote(params.ref, note)
      // Keep the exhausted state so further reports keep escalating instead
      // of silently restarting the budget.
      retryStates.set(params.ref, { attempts: MAX_ATTEMPTS })
      let suffix = ''
      if (!noted) {
        suffix = ' (aven note write FAILED — record this manually)'
      }
      return toolResult(
        `flow_run_attempt: retry budget exhausted for ${params.ref} — ESCALATE to the human. ${note}${suffix}`,
        { ok: false, status: 'escalate' },
        { isError: true },
      )
    },
  })
}
