// AIDEV-NOTE: Pure retry-budget state machine (3 TOTAL attempts, so 2 retries
// before escalate). nextAttempt is the ONLY transition; a failed test never
// silently passes through — after the 3rd failed attempt the machine returns
// an escalation record instead of a retry (PMR-2N3C).
// The "3 attempts total then escalates" acceptance criterion is tested against
// this module directly with an always-failing attempt (test/implement.test.ts).
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

// Total failing attempts permitted before escalate (retries = MAX_ATTEMPTS - 1).
export const MAX_ATTEMPTS = 3

export function startRetry(): RetryState {
  return { attempts: 0 }
}

export function nextAttempt(
  state: RetryState,
  result: AttemptResult,
): RetryTransition {
  if (result.ok) return { status: 'passed' }
  const attempts = state.attempts + 1
  if (attempts < MAX_ATTEMPTS) {
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
