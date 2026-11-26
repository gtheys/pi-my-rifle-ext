import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  lastAvenResolutionFailure,
  readAvenLabels,
  readAvenSnapshot,
  ticketSnapshotFor,
} from '../aven/client.ts'
import { mkTmpDir } from './tmpdir.ts'

// PMR-9DZ0 1.1: fake `aven` shim (same PATH-swap pattern as
// land-tool.test.ts / aven-workspace-cwd.test.ts). It echoes the JSON held
// in FAKE_AVEN_JSON on stdout and exits with FAKE_AVEN_EXIT (default 0), so
// a single script can drive the success / fuzzy / bad-json / exec-failure
// shapes readAvenSnapshot must reproduce byte-for-byte from the old
// readAvenLabels body.
const BIN_DIR = mkTmpDir('pi-flow-aven-snap-bin-')
writeFileSync(
  path.join(BIN_DIR, 'aven'),
  '#!/bin/sh\nprintf "%s\n" "$FAKE_AVEN_JSON"\nexit "$FAKE_AVEN_EXIT"\n',
)
chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

async function withFakeAven<T>(
  stdout: string,
  fn: () => Promise<T>,
  exit = 0,
): Promise<T> {
  const previousPath = process.env.PATH ?? ''
  const previousJson = process.env.FAKE_AVEN_JSON
  const previousExit = process.env.FAKE_AVEN_EXIT
  process.env.PATH = `${BIN_DIR}:${previousPath}`
  process.env.FAKE_AVEN_JSON = stdout
  process.env.FAKE_AVEN_EXIT = String(exit)
  try {
    return await fn()
  } finally {
    process.env.PATH = previousPath
    if (previousJson === undefined) delete process.env.FAKE_AVEN_JSON
    else process.env.FAKE_AVEN_JSON = previousJson
    if (previousExit === undefined) delete process.env.FAKE_AVEN_EXIT
    else process.env.FAKE_AVEN_EXIT = previousExit
  }
}

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

// --- PMR-9DZ0 1.1: the snapshot carries the ticket title, additively ---
// Title parsing must NEVER be a new failure mode: anything that is not a
// non-empty string becomes `undefined` while the snapshot stays ok:true.
test('ticketSnapshotFor: non-empty title string is carried on the ok variant', () => {
  const snap = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'], title: 'Show the ticket title' },
    'PMR-TPN7',
  )
  assert.ok(snap.ok)
  assert.equal(snap.title, 'Show the ticket title')
})

test('ticketSnapshotFor: absent title is undefined, still ok', () => {
  const snap = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'] },
    'PMR-TPN7',
  )
  assert.ok(snap.ok)
  assert.equal(snap.title, undefined)
})

test('ticketSnapshotFor: empty/non-string title is undefined, still ok', () => {
  const empty = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'], title: '' },
    'PMR-TPN7',
  )
  assert.ok(empty.ok)
  assert.equal(empty.title, undefined)
  const num = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'], title: 42 },
    'PMR-TPN7',
  )
  assert.ok(num.ok)
  assert.equal(num.title, undefined)
  const obj = ticketSnapshotFor(
    { ref: 'PMR-TPN7', labels: ['planned'], title: {} },
    'PMR-TPN7',
  )
  assert.ok(obj.ok)
  assert.equal(obj.title, undefined)
})

test('ticketSnapshotFor: a title without a labels array is still bad-json', () => {
  // labels remains the required field for ok — the title is purely additive.
  const snap = ticketSnapshotFor(
    { ref: 'PMR-TPN7', title: 'has a title' },
    'PMR-TPN7',
  )
  assert.ok(!snap.ok)
  if (!snap.ok) assert.equal(snap.kind, 'bad-json')
})

// --- PMR-9DZ0 1.1: readAvenSnapshot reproduces the old readAvenLabels
// shell-out/parse/failure-recording exactly, but hands back the snapshot;
// readAvenLabels stays a thin delegating wrapper (same results, same
// recorded messages). Workspace is passed explicitly so the read takes the
// `--workspace` short-circuit and never triggers per-ref resolution. ---

test('readAvenSnapshot: ok record carries labels + title; readAvenLabels delegates the labels', async () => {
  const out = JSON.stringify({
    ref: 'PMR-TPN7',
    labels: ['planned', 'active'],
    title: 'Show the ticket title',
  })
  await withFakeAven(out, async () => {
    const snap = await readAvenSnapshot('PMR-TPN7', 'ws')
    assert.ok(snap, 'expected a snapshot, not null')
    assert.ok(snap?.ok)
    if (snap?.ok) {
      assert.deepEqual(snap.labels, ['planned', 'active'])
      assert.equal(snap.title, 'Show the ticket title')
      assert.equal(snap.resolvedRef, 'PMR-TPN7')
    }
    const labels = await readAvenLabels('PMR-TPN7', 'ws')
    assert.deepEqual(labels, ['planned', 'active'])
  })
})

test('readAvenSnapshot: ok record without a title → undefined; readAvenLabels unchanged', async () => {
  const out = JSON.stringify({ ref: 'PMR-TPN7', labels: [] })
  await withFakeAven(out, async () => {
    const snap = await readAvenSnapshot('PMR-TPN7', 'ws')
    assert.ok(snap?.ok)
    if (snap?.ok) assert.equal(snap.title, undefined)
    assert.deepEqual(await readAvenLabels('PMR-TPN7', 'ws'), [])
  })
})

test('readAvenSnapshot: fuzzy match returns the failed snapshot + records the fuzzy message', async () => {
  const out = JSON.stringify({ ref: 'PMR-TPN7', labels: ['planned'] })
  await withFakeAven(out, async () => {
    const snap = await readAvenSnapshot('PMR-TPN', 'ws')
    assert.ok(snap)
    assert.ok(!snap?.ok)
    if (snap && !snap.ok) {
      assert.equal(snap.kind, 'fuzzy-match')
      assert.equal(snap.resolvedRef, 'PMR-TPN7')
    }
    // Identical wording to the pre-refactor readAvenLabels failure.
    assert.match(
      lastAvenResolutionFailure() ?? '',
      /aven matched PMR-TPN to PMR-TPN7 — not an exact ticket ref/,
    )
    // Delegation: the labels read still fails closed to null.
    assert.equal(await readAvenLabels('PMR-TPN', 'ws'), null)
  })
})

test('readAvenSnapshot: ticket without a labels array → bad-json snapshot + message; readAvenLabels null', async () => {
  const out = JSON.stringify({ ref: 'PMR-TPN7', title: 'no labels' })
  await withFakeAven(out, async () => {
    const snap = await readAvenSnapshot('PMR-TPN7', 'ws')
    assert.ok(snap)
    assert.ok(!snap?.ok)
    if (snap && !snap.ok) assert.equal(snap.kind, 'bad-json')
    assert.match(
      lastAvenResolutionFailure() ?? '',
      /aven show returned a ticket without a labels array/,
    )
    assert.equal(await readAvenLabels('PMR-TPN7', 'ws'), null)
  })
})

test('readAvenSnapshot: exec failure (non-zero exit) → null + recorded failure; readAvenLabels null', async () => {
  await withFakeAven(
    '',
    async () => {
      const snap = await readAvenSnapshot('PMR-TPN7', 'ws')
      assert.equal(snap, null)
      assert.ok(
        lastAvenResolutionFailure() !== undefined,
        'expected a recorded exec failure',
      )
      assert.equal(await readAvenLabels('PMR-TPN7', 'ws'), null)
    },
    1,
  )
})
