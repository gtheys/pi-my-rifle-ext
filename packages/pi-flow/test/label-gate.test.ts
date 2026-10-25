// PMR-EZHA — pure lifecycle-label gate: tool-boundary enforcement for
// flow_phase_complete and the direct-mutation blocklist. Tests here pin the
// gate reasons the tool surfaces on refusal.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkPhaseCompletion,
  lifecycleLabelMutation,
} from '../flow/label-gate.ts'

describe('checkPhaseCompletion', () => {
  it('refuses done without review-passed, with the missing-label reason', () => {
    const r = checkPhaseCompletion('feedback', [
      'researched',
      'planned',
      'active',
    ])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /review-passed/)
  })

  it('refuses review-passed without active', () => {
    const r = checkPhaseCompletion('validate', ['researched', 'planned'])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /active/)
  })

  it('refuses implement without planned via canImplement reason', () => {
    const r = checkPhaseCompletion('implement', ['researched'])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /planned/)
    assert.match(r.reason ?? '', /\/plan/)
  })

  it('refuses implement without research or skip via needsResearchSkip', () => {
    const r = checkPhaseCompletion('implement', ['planned'])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /research/)
  })

  it('ok for implement with planned + researched', () => {
    assert.equal(
      checkPhaseCompletion('implement', ['planned', 'researched']).ok,
      true,
    )
  })

  it('ok for implement with planned + research-skipped', () => {
    assert.equal(
      checkPhaseCompletion('implement', ['planned', 'research-skipped']).ok,
      true,
    )
  })

  it('ok for plan with researched (research satisfied)', () => {
    assert.equal(checkPhaseCompletion('plan', ['researched']).ok, true)
  })

  it('ok for plan with research-skipped', () => {
    assert.equal(checkPhaseCompletion('plan', ['research-skipped']).ok, true)
  })

  it('refuses plan without research record', () => {
    const r = checkPhaseCompletion('plan', [])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /research/)
  })

  it('ok (already complete) when the phase label is present — idempotent', () => {
    const r = checkPhaseCompletion('plan', ['researched', 'planned'])
    assert.equal(r.ok, true)
  })

  it('ok for research with no preconditions', () => {
    assert.equal(checkPhaseCompletion('research', []).ok, true)
  })
})

describe('lifecycleLabelMutation', () => {
  it('blocks aven edit --label with a lifecycle label', () => {
    assert.equal(lifecycleLabelMutation('aven edit PMR-1 --label done'), 'done')
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label review-passed'),
      'review-passed',
    )
  })

  it('blocks aven label add/remove legacy syntax', () => {
    assert.equal(
      lifecycleLabelMutation('aven label add PMR-1 planned'),
      'planned',
    )
    assert.equal(
      lifecycleLabelMutation("aven label remove PMR-1 'active'"),
      'active',
    )
  })

  it('blocks lifecycle label inside a chained command', () => {
    assert.equal(
      lifecycleLabelMutation('git add -A && aven edit PMR-1 --label done'),
      'done',
    )
  })

  it('allows non-lifecycle labels', () => {
    assert.equal(lifecycleLabelMutation('aven edit PMR-1 --label bug'), null)
    assert.equal(lifecycleLabelMutation('aven edit PMR-1 --label plan'), null)
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label research-skipped'),
      null,
    )
  })

  it('allows non-label aven commands and non-aven commands', () => {
    assert.equal(lifecycleLabelMutation('aven show PMR-1 --json'), null)
    assert.equal(lifecycleLabelMutation('aven note PMR-1 "active work"'), null)
    assert.equal(lifecycleLabelMutation('bun run test'), null)
  })
})
