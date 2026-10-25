// Tests for the landing gate (PMR-06RH): pure decisions consumed by the
// flow_land tool and the bash tool_call interceptor.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { landDecision, landingBashBlock } from '../flow/land-gate.ts'

describe('landDecision', () => {
  it('refuses without the review-passed label', () => {
    const d = landDecision(['planned', 'active'], null)
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /review-passed/)
  })

  it('refuses on unreadable labels', () => {
    const d = landDecision(null, null)
    assert.equal(d.ok, false)
  })

  it('allows with review-passed label and no artifact', () => {
    assert.deepEqual(landDecision(['review-passed'], null), { ok: true })
  })

  it('allows with a clean review artifact', () => {
    const d = landDecision(['review-passed'], 'notes\nblockers_count: 0\n')
    assert.deepEqual(d, { ok: true })
  })

  it('refuses when the artifact reports blockers', () => {
    const d = landDecision(
      ['review-passed'],
      'blockers_count: 2\n- blocker: a\n- blocker: b\n',
    )
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /2/)
  })

  it('refuses a malformed artifact instead of treating it as clean', () => {
    const d = landDecision(['review-passed'], 'looks fine to me')
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /blockers_count/)
  })
})

describe('landingBashBlock', () => {
  it('blocks git push while a flow ref is active', () => {
    const reason = landingBashBlock('git push origin feat/x', 'PMR-ABC1')
    assert.ok(reason !== null)
    assert.match(reason, /flow_land/)
    assert.match(reason, /PMR-ABC1/)
  })

  it('blocks gh pr create while a flow ref is active', () => {
    const reason = landingBashBlock('gh pr create --title x', 'PMR-ABC1')
    assert.ok(reason !== null)
    assert.match(reason, /flow_land/)
  })

  it('allows normal git use when no flow ref is active', () => {
    assert.equal(landingBashBlock('git push origin feat/x', null), null)
    assert.equal(landingBashBlock('gh pr create', null), null)
  })

  it('allows non-landing commands even with an active ref', () => {
    assert.equal(landingBashBlock('git status', 'PMR-ABC1'), null)
    assert.equal(landingBashBlock('git commit -m x', 'PMR-ABC1'), null)
    assert.equal(landingBashBlock('gh pr view 12', 'PMR-ABC1'), null)
  })

  it('does not match git pushd-like words', () => {
    assert.equal(landingBashBlock('echo git push', 'PMR-ABC1'), null)
  })
})
