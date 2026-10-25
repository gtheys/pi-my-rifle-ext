import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseImplementArgs } from '../implement/args.ts'
import { buildImplementPrompt } from '../implement/prompt.ts'
import { nextAttempt, startRetry } from '../implement/retry.ts'
import { routeFor } from '../implement/routing.ts'

describe('parseImplementArgs', () => {
  it('parses jira ref', () => {
    assert.deepEqual(parseImplementArgs('dp-71'), {
      kind: 'jira',
      jiraId: 'DP-71',
      skipResearch: false,
    })
  })
  it('parses aven ref', () => {
    assert.deepEqual(parseImplementArgs('fix-login-flow'), {
      kind: 'aven',
      ref: 'fix-login-flow',
      skipResearch: false,
    })
  })
  it('parses non-jira aven ref with skip flag', () => {
    assert.deepEqual(parseImplementArgs('my-ticket --skip-research'), {
      kind: 'aven',
      ref: 'my-ticket',
      skipResearch: true,
    })
  })
  it('empty is help', () => {
    assert.equal(parseImplementArgs('').kind, 'help')
  })
})

describe('routeFor', () => {
  it('refuses without planned label', () => {
    const r = routeFor('jira', ['bug'], false)
    assert.equal(r.kind, 'refuse')
  })
  it('bug label routes to bug', () => {
    const r = routeFor('jira', ['planned', 'researched', 'bug'], false)
    assert.deepEqual(r, { kind: 'ok', route: 'bug', researchSkip: false })
  })
  it('plan label routes to plan', () => {
    const r = routeFor('aven', ['planned', 'researched', 'plan'], false)
    assert.deepEqual(r, { kind: 'ok', route: 'plan', researchSkip: false })
  })
  it('oneshot label routes to oneshot', () => {
    const r = routeFor('aven', ['planned', 'researched', 'oneshot'], false)
    assert.deepEqual(r, { kind: 'ok', route: 'oneshot', researchSkip: false })
  })
  it('missing type label defaults to oneshot', () => {
    const r = routeFor('jira', ['planned', 'researched'], false)
    assert.deepEqual(r, { kind: 'ok', route: 'oneshot', researchSkip: false })
  })
  it('missing researched without flag is skip-required', () => {
    const r = routeFor('jira', ['planned', 'bug'], false)
    assert.deepEqual(r, { kind: 'skip-required' })
  })
  it('missing researched with flag records skip', () => {
    const r = routeFor('jira', ['planned', 'bug'], true)
    assert.deepEqual(r, { kind: 'ok', route: 'bug', researchSkip: true })
  })
})

describe('retry state machine', () => {
  it('starts at attempt 0', () => {
    const s = startRetry()
    assert.equal(s.attempts, 0)
  })
  it('failing attempts retry up to 3 total attempts then escalate', () => {
    let s = startRetry()
    const fail = {
      ok: false as const,
      lastError: 'boom',
      commands: ['bun test'],
    }
    for (let i = 1; i <= 2; i++) {
      const r = nextAttempt(s, fail)
      assert.equal(r.status, 'retry')
      s = r.state
      assert.equal(s.attempts, i)
    }
    const r = nextAttempt(s, fail)
    assert.equal(r.status, 'escalate')
    assert.ok(r.escalation)
    assert.equal(r.escalation.lastError, 'boom')
    assert.deepEqual(r.escalation.commands, ['bun test'])
    assert.equal(typeof r.escalation.hypothesis, 'string')
  })
  it('passing attempt stops immediately', () => {
    const r = nextAttempt(startRetry(), { ok: true as const })
    assert.equal(r.status, 'passed')
  })
  it('escalation carries hypothesis', () => {
    let s = startRetry()
    let r = nextAttempt(s, {
      ok: false as const,
      lastError: 'e',
      hypothesis: 'flaky timer',
    })
    while (r.status === 'retry') {
      s = r.state
      r = nextAttempt(s, {
        ok: false as const,
        lastError: 'e',
        hypothesis: 'flaky timer',
      })
    }
    assert.equal(r.status, 'escalate')
    if (r.status === 'escalate') {
      assert.equal(r.escalation.hypothesis, 'flaky timer')
    }
  })
})

describe('buildImplementPrompt', () => {
  it('oneshot prompt demands worktree, test, commit', () => {
    const p = buildImplementPrompt({
      mode: 'work',
      ref: 'DP-71',
      route: 'oneshot',
    })
    assert.match(p, /worktree/)
    assert.match(p, /test/i)
    assert.match(p, /jira_create_branch/)
  })
  it('plan prompt walks epic children in order', () => {
    const p = buildImplementPrompt({
      mode: 'personal',
      ref: 'PMR-56NR',
      route: 'plan',
    })
    assert.match(p, /implement-plan-aven/)
    assert.match(p, /IN ORDER/)
    assert.match(p, /ALL subtasks are done/)
    assert.match(p, /"active" label/)
  })
  it('plan prompt skips dep-blocked subtasks', () => {
    const p = buildImplementPrompt({
      mode: 'personal',
      ref: 'PMR-56NR',
      route: 'plan',
    })
    assert.match(p, /never start a\s+subtask that is blocked/i)
  })
  it('bug prompt requires reproduce-first', () => {
    const p = buildImplementPrompt({ mode: 'work', ref: 'DP-72', route: 'bug' })
    assert.match(p, /reproduce/i)
  })
  it('retry escalation instructions present', () => {
    const p = buildImplementPrompt({
      mode: 'work',
      ref: 'DP-71',
      route: 'oneshot',
    })
    assert.match(p, /3 total attempts/)
    assert.match(p, /flow_run_attempt/)
    assert.match(p, /aven note/)
  })
  it('personal ref uses conventional branch', () => {
    const p = buildImplementPrompt({
      mode: 'personal',
      ref: 'feat-thing',
      route: 'oneshot',
    })
    assert.match(p, /feat-thing/)
    assert.match(p, /conventional branch/)
  })
  it('research skip recorded via aven note', () => {
    const p = buildImplementPrompt({
      mode: 'personal',
      ref: 'x',
      route: 'oneshot',
      researchSkip: true,
    })
    assert.match(p, /aven note.*research skip/i)
  })

  it('kind prefixes force the kind (PMR-PCVK)', () => {
    assert.deepEqual(parseImplementArgs('aven:DP-71 --skip-research'), {
      kind: 'aven',
      ref: 'DP-71',
      skipResearch: true,
    })
    assert.deepEqual(parseImplementArgs('jira:DP-71'), {
      kind: 'jira',
      jiraId: 'DP-71',
      skipResearch: false,
    })
  })
})
