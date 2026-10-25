// PMR-06RH — the retry budget the flow_run_attempt tool enforces: the tool
// feeds every reported attempt into nextAttempt; this test drives the exact
// 3-failed-attempt sequence the acceptance criterion names.
// PMR-2N3C — retry semantics are 3 TOTAL attempts (2 retries, then escalate);
// this test drives the exact 3-failed-attempts sequence.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AttemptResult,
  nextAttempt,
  startRetry,
} from '../implement/retry.ts'

const fail: AttemptResult = { ok: false, lastError: 'test run red' }

describe('flow_run_attempt retry budget', () => {
  it('returns retry for the first two failing attempts, escalate on the 3rd', () => {
    let state = startRetry()
    const statuses: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = nextAttempt(state, fail)
      statuses.push(r.status)
      if (r.status === 'retry') state = r.state
    }
    assert.deepEqual(statuses, ['retry', 'retry', 'escalate'])
  })

  it('a passing attempt ends the budget immediately', () => {
    let state = startRetry()
    state = { attempts: 2 }
    const r = nextAttempt(state, { ok: true })
    assert.equal(r.status, 'passed')
  })
})
