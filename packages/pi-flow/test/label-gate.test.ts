// PMR-EZHA — pure lifecycle-label gate: tool-boundary enforcement for
// flow_phase_complete and the direct-mutation blocklist. Tests here pin the
// gate reasons the tool surfaces on refusal.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkPhaseCompletion,
  lifecycleLabelMutation,
  receiptMetadataMutation,
} from '../flow/label-gate.ts'

describe('checkPhaseCompletion', () => {
  it('refuses done without review-passed, with the missing-label reason', () => {
    const r = checkPhaseCompletion('feedback', ['planned', 'active'])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /review-passed/)
  })

  it('refuses review-passed without active', () => {
    const r = checkPhaseCompletion('validate', ['planned'])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /active/)
  })

  it('refuses implement without planned via canImplement reason', () => {
    const r = checkPhaseCompletion('implement', [])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /planned/)
    assert.match(r.reason ?? '', /\/plan/)
  })

  it('ok for implement with planned only (no research gate, PMR-Z2K7)', () => {
    assert.equal(checkPhaseCompletion('implement', ['planned']).ok, true)
  })

  it('ok for plan with no preconditions', () => {
    assert.equal(checkPhaseCompletion('plan', []).ok, true)
  })

  it('ok (already complete) when the phase label is present — idempotent', () => {
    const r = checkPhaseCompletion('plan', ['planned'])
    assert.equal(r.ok, true)
  })

  it('refuses implement without planned even with legacy research labels', () => {
    const r = checkPhaseCompletion('implement', [
      'researched',
      'research-skipped',
    ])
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /planned/)
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

  it('blocks aven add --label with a lifecycle label (PMR-TCE5)', () => {
    assert.equal(
      lifecycleLabelMutation('aven add "title" --label done'),
      'done',
    )
    assert.equal(
      lifecycleLabelMutation('aven add "title" --label  active'),
      'active',
    )
    assert.equal(
      lifecycleLabelMutation('aven add "title" --label=planned'),
      'planned',
    )
    assert.equal(lifecycleLabelMutation('aven add "title" --label bug'), null)
  })

  it('blocks aven bulk-update --label with a lifecycle label (PMR-8N7C)', () => {
    assert.equal(
      lifecycleLabelMutation('aven bulk-update --status inbox --label done'),
      'done',
    )
    assert.equal(
      lifecycleLabelMutation(
        'aven bulk-update --all --remove-label review-passed',
      ),
      'review-passed',
    )
    assert.equal(
      lifecycleLabelMutation('aven bulk-update --all --label=active'),
      'active',
    )
    assert.equal(
      lifecycleLabelMutation('aven bulk-update --status inbox --label bug'),
      null,
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
      lifecycleLabelMutation('aven edit PMR-1 --label researched'),
      null,
    )
  })

  it('blocks a lifecycle label behind repeated --label flags (PMR-9P9E)', () => {
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label bug --label done'),
      'done',
    )
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label done --label bug'),
      'done',
    )
    assert.equal(
      lifecycleLabelMutation(
        'aven edit PMR-1 --label bug --label plan --remove-label active',
      ),
      'active',
    )
    assert.equal(
      lifecycleLabelMutation('aven add "title" --label bug --label planned'),
      'planned',
    )
  })

  it('allows repeated --label flags when all are type labels', () => {
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label bug --label plan'),
      null,
    )
  })

  it('allows read-only aven commands with a lifecycle --label (PMR-5RFR)', () => {
    assert.equal(
      lifecycleLabelMutation('aven search --label done --json'),
      null,
    )
    assert.equal(lifecycleLabelMutation('aven list --label planned'), null)
  })

  it('blocks aven edit --label with extra whitespace (PMR-5RFR)', () => {
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label  done'),
      'done',
    )
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --label   review-passed'),
      'review-passed',
    )
    assert.equal(lifecycleLabelMutation('aven edit PMR-1 --label=done'), 'done')
    assert.equal(
      lifecycleLabelMutation('aven edit PMR-1 --remove-label  active'),
      'active',
    )
  })

  it('allows non-label aven commands and non-aven commands', () => {
    assert.equal(lifecycleLabelMutation('aven show PMR-1 --json'), null)
    assert.equal(lifecycleLabelMutation('aven note PMR-1 "active work"'), null)
    assert.equal(lifecycleLabelMutation('bun run test'), null)
  })
})

describe('receiptMetadataMutation', () => {
  it('blocks aven edit writing a receipt metadata key', () => {
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata spec-answer=approve'),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata review-answer=pass'),
      'review-answer',
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata spec-answer=reject'),
      'spec-answer',
    )
  })

  it('blocks receipt keys under aven add and aven bulk-update', () => {
    assert.equal(
      receiptMetadataMutation(
        'aven add "title" --metadata spec-answer=approve',
      ),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation(
        'aven bulk-update --query "PMR-1" --metadata review-answer=fail',
      ),
      'review-answer',
    )
  })

  it('blocks receipt keys with extra whitespace and quoted values', () => {
    assert.equal(
      receiptMetadataMutation(
        'aven edit PMR-1 --metadata  spec-answer=approve',
      ),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation(
        'aven edit PMR-1 --metadata "spec-answer=approve"',
      ),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'review-answer=pass'",
      ),
      'review-answer',
    )
  })

  it('blocks the one-token --metadata=key=value form', () => {
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata=spec-answer=approve'),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata=review-answer=pass'),
      'review-answer',
    )
  })

  it('blocks a receipt key smuggled as a second --metadata flag (PMR-9P9E)', () => {
    assert.equal(
      receiptMetadataMutation(
        'aven edit PMR-1 --metadata plan-state=draft --metadata spec-answer=approve',
      ),
      'spec-answer',
    )
  })

  it('blocks space-before-equals receipt metadata (PMR-SB3H, live-verified aven syntax)', () => {
    // aven accepts `--metadata 'spec-answer =approve'` verbatim (verified
    // live 2026-11-19: stored key spec-answer with a CLEAN value approve;
    // the strict list filter matches the same syntax) — a working forge
    // that evaded the key-immediately-followed-by-'=' match.
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'spec-answer =approve'",
      ),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'spec-answer = approve'",
      ),
      'spec-answer',
    )
    assert.equal(
      receiptMetadataMutation(
        'aven edit PMR-1 --metadata spec-answer =approve',
      ),
      'spec-answer',
    )
    // plan-state variant with the same evasion shape.
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'plan-state = approved'",
      ),
      'plan-state=approved',
    )
    // Non-gated keys with the same shape must still pass, and plan-state
    // values other than approved stay allowed.
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'other-key = whatever'",
      ),
      null,
    )
    assert.equal(
      receiptMetadataMutation(
        "aven edit PMR-1 --metadata 'plan-state = review'",
      ),
      null,
    )
  })

  it('blocks plan-state=approved but allows draft and review', () => {
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata plan-state=approved'),
      'plan-state=approved',
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata=plan-state=approved'),
      'plan-state=approved',
    )
    assert.equal(
      receiptMetadataMutation(
        'aven edit PMR-1 --metadata  "plan-state=approved"',
      ),
      'plan-state=approved',
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata plan-state=draft'),
      null,
    )
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata plan-state=review'),
      null,
    )
  })

  it('allows non-receipt metadata keys', () => {
    assert.equal(
      receiptMetadataMutation('aven edit PMR-1 --metadata other-key=whatever'),
      null,
    )
  })

  it('allows read-only aven commands and non-aven commands', () => {
    assert.equal(
      receiptMetadataMutation('aven show PMR-1 --metadata spec-answer=approve'),
      null,
    )
    assert.equal(receiptMetadataMutation('aven note PMR-1 "hi"'), null)
    assert.equal(receiptMetadataMutation('bun run test'), null)
    assert.equal(receiptMetadataMutation(''), null)
  })
})
