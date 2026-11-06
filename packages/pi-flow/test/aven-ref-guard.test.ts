import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ticketSnapshotFor } from '../aven/client.ts'

// --- PMR-F8HB: aven prefix-matches refs; snapshot classification must
// catch a resolved ref that differs from the requested one ---

test('ticketSnapshotFor: exact match returns the labels', () => {
  const snap = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned', 'active'] },
    'PMR-TPN7',
  )
  assert.ok(snap.ok)
  assert.deepEqual(snap.labels, ['planned', 'active'])
  assert.equal(snap.resolvedRef, 'PMR-TPN7')
})

test('ticketSnapshotFor: case variant of the same ref is not fuzzy', () => {
  const snap = ticketSnapshotFor({ ref: 'PMR-TPN7', labels: [] }, 'pmr-tpn7')
  assert.ok(snap.ok)
})

test('ticketSnapshotFor: aven prefix match (PMR-TPN -> PMR-TPN7) is fuzzy', () => {
  const snap = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'] },
    'PMR-TPN',
  )
  assert.ok(!snap.ok)
  if (!snap.ok) {
    assert.equal(snap.kind, 'fuzzy-match')
    assert.equal(snap.resolvedRef, 'PMR-TPN7')
  }
})

test('ticketSnapshotFor: missing labels array or non-object is bad-json', () => {
  assert.ok(!ticketSnapshotFor({ ref: 'PMR-TPN7' }, 'PMR-TPN7').ok)
  assert.ok(!ticketSnapshotFor('nope', 'PMR-TPN7').ok)
  assert.ok(!ticketSnapshotFor(null, 'PMR-TPN7').ok)
  // A ticket with labels but no ref field cannot be verified: reject it
  // (fail-closed) rather than trusting an unverifiable identity.
  const noRef = ticketSnapshotFor({ labels: ['planned'] }, 'PMR-TPN7')
  assert.ok(!noRef.ok)
})
