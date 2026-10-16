// AIDEV-NOTE: Pure retry-budget state machine (budget 3). nextAttempt is the
// ONLY transition; a failed test never silently passes through — after 3
// failed attempts the machine returns an escalation record instead of a retry.
// The "retries <=3 then escalates" acceptance criterion is tested against this
// module directly with an always-failing attempt (test/implement.test.ts).
// Invariant: callers must STOP and surface the escalation to the human; the
// machine itself has no side effects so the caller owns aven notes / status.

export interface AttemptResult {
  ok: boolean
  lastError?: string
  commands?: readonly string[]
  hypothesis?: string
}

export interface RetryState {
  attempts: number
}

export type RetryTransition =
  | { status: 'passed' }
  | { status: 'retry'; state: RetryState }
  | {
      status: 'escalate'
      escalation: {
        commands: readonly string[]
        lastError: string
        hypothesis: string
      }
    }

export const RETRY_BUDGET = 3

export function startRetry(): RetryState {
  return { attempts: 0 }
}

export function nextAttempt(
  state: RetryState,
  result: AttemptResult,
): RetryTransition {
  if (result.ok) return { status: 'passed' }
  const attempts = state.attempts + 1
  if (attempts <= RETRY_BUDGET) {
    return { status: 'retry', state: { attempts } }
  }
  return {
    status: 'escalate',
    escalation: {
      commands: result.commands ?? [],
      lastError: result.lastError ?? 'unknown error',
      hypothesis: result.hypothesis ?? 'no hypothesis recorded',
    },
  }
}
