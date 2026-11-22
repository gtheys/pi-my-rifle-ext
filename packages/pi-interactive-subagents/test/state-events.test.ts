// AIDEV-NOTE (PMR-3QMY): contract tests for the public state-event payload
// on the `pi-my-rifle-subagents:state` channel. These tests lock the WIRE
// contract for co-extensions (pi-flow and friends): envelope shape, sequencer
// behaviour, and the key-set pin that turns any payload addition into a
// deliberate version-policy decision. Pure module — no fs, no pi import,
// fake-bus pattern mirrors test/flow-env.test.ts.
//
// AIDEV-NOTE (PMR-3QMY) shared sequencer: `incarnation` is generated ONCE at
// module load and `seq` is a module-level 1-based counter shared by every
// build call in this file. Tests therefore assert RELATIVE properties
// (strictly increasing, stable incarnation) rather than absolute seq values,
// so the file stays green regardless of how many events an earlier test built.
import assert from 'node:assert/strict'
import { test } from 'node:test'
// AIDEV-NOTE (PMR-3QMY): importing the extension entrypoint into a node:test
// file is safe and is the established pattern (test/test.ts and
// test/system-prompt-mode.test.ts both `import * as subagentsModule`). We
// need the live `subagentStateEntries` derivation + the globalThis-backed
// runningSubagents map exposed on `__test__`, so the derivation is tested
// against the REAL projection seam, not a copy.
import {
  __test__,
  type RunningSubagent,
  subagentStateEntries,
} from '../pi-extension/subagents/index.ts'
import {
  buildSubagentStateSnapshot,
  buildSubagentStateStopped,
  publishStateEvent,
  SUBAGENT_STATE_CHANNEL,
  SUBAGENT_STATE_EVENT_VERSION,
  type SubagentStateEntry,
  type SubagentStateEvent,
  type SubagentStateStatus,
} from '../pi-extension/subagents/state-events.ts'
import {
  createStatusState,
  type SubagentStatusState,
} from '../pi-extension/subagents/status.ts'

// toISOString() always renders milliseconds + a trailing `Z` (UTC).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A per-test fake bus implementing the minimal `StateEventBus` shape. */
interface FakeBus {
  readonly events: { channel: string; data: unknown }[]
  emit(channel: string, data: unknown): void
}

function makeFakeBus(): FakeBus {
  const events: { channel: string; data: unknown }[] = []
  return {
    events,
    emit(channel: string, data: unknown): void {
      events.push({ channel, data })
    },
  }
}

// AIDEV-NOTE (PMR-3QMY): reference envelope key set. If a field is added or
// renamed here, the key-set pin test fails — that is the intended drift
// guard (ISC-9). Keep in sync with SubagentStateEvent in state-events.ts.
const ENVELOPE_KEYS = [
  'agents',
  'emittedAt',
  'incarnation',
  'seq',
  'type',
  'version',
]
const ENTRY_KEYS = ['id', 'name', 'status']

test('channel and version constants are stable', () => {
  assert.equal(SUBAGENT_STATE_CHANNEL, 'pi-my-rifle-subagents:state')
  assert.equal(SUBAGENT_STATE_EVENT_VERSION, 1)
})

test('snapshot envelope has the v1 shape and ISO emittedAt', () => {
  const entries: SubagentStateEntry[] = [
    { id: 'c1', name: 'worker-1', status: 'starting' },
  ]
  const event = buildSubagentStateSnapshot(entries, Date.UTC(2026, 10, 22, 12))
  assert.equal(event.type, 'snapshot')
  assert.equal(event.version, 1)
  assert.equal(event.emittedAt, '2026-11-22T12:00:00.000Z')
  assert.equal(ISO_RE.test(event.emittedAt), true)
})

test('initial snapshot carries the full entry list verbatim', () => {
  const entries: SubagentStateEntry[] = [
    { id: 'c1', name: 'worker-1', status: 'starting' },
    { id: 'c2', name: 'scout', status: 'working' },
  ]
  const event = buildSubagentStateSnapshot(entries)
  // AIDEV-NOTE (PMR-3QMY): buildSubagentStateSnapshot assigns the caller's
  // array BY REFERENCE (event.agents = entries, no copy/re-sort). Assert on
  // CONTENT, not identity, so the test pins the payload rather than this
  // internal implementation detail. The CALLER sorts by id (see index.ts).
  assert.deepEqual(event.agents, [
    { id: 'c1', name: 'worker-1', status: 'starting' },
    { id: 'c2', name: 'scout', status: 'working' },
  ])
})

test('stopped event carries empty agents', () => {
  const event = buildSubagentStateStopped(Date.UTC(2026, 10, 22, 13))
  assert.equal(event.type, 'stopped')
  assert.equal(event.version, 1)
  assert.deepEqual(event.agents, [])
  assert.equal(event.emittedAt, '2026-11-22T13:00:00.000Z')
})

test('sequencer: incarnation is stable and seq is strictly monotonic across snapshot -> snapshot -> stopped', () => {
  const entries: SubagentStateEntry[] = [
    { id: 'c1', name: 'worker-1', status: 'working' },
  ]
  const first = buildSubagentStateSnapshot(entries)
  const second = buildSubagentStateSnapshot(entries)
  const stopped = buildSubagentStateStopped()
  // One uuid per module load — same string across all three builds.
  assert.equal(first.incarnation, second.incarnation)
  assert.equal(second.incarnation, stopped.incarnation)
  // A uuid is 36 chars (8-4-4-4-12 with hyphens).
  assert.equal(first.incarnation.length, 36)
  // Strictly increasing: seq never reuses a number within an incarnation.
  assert.ok(second.seq > first.seq, 'second seq must exceed first')
  assert.ok(stopped.seq > second.seq, 'stopped seq must exceed second')
})

// AIDEV-NOTE (PMR-3QMY): key-set pin (ISC-9). Object.keys deepEqual on a
// snapshot entry AND on the envelope. Any payload creep (task, cwd,
// sessionFile, paneId, usage, ...) fails here until the version policy is
// consciously applied — this is the deliberate drift guard.
test('key-set pin: entry has exactly id/name/status and envelope has exactly the 6 v1 keys', () => {
  const entries: SubagentStateEntry[] = [
    { id: 'c1', name: 'worker-1', status: 'blocked' },
  ]
  const event = buildSubagentStateSnapshot(entries)
  assert.deepEqual(Object.keys(event).sort(), ENVELOPE_KEYS)
  assert.equal(event.agents.length, 1)
  assert.deepEqual(Object.keys(event.agents[0]).sort(), ENTRY_KEYS)
})

test('key-set pin: stopped envelope has the same 6 keys with an empty agents list', () => {
  const event = buildSubagentStateStopped()
  assert.deepEqual(Object.keys(event).sort(), ENVELOPE_KEYS)
  assert.deepEqual(event.agents, [])
})

// AIDEV-NOTE (PMR-3QMY): forward-compatibility consumer. v1 is additive-only:
// consumers MUST ignore unknown fields. The reference consumer derives live
// state purely from id/name/status + monotonic seq, and survives events that
// carry extra unknown keys (simulating a future additive version).
interface ConsumerAgent {
  id: string
  name: string
  status: string
}

function projectState(events: SubagentStateEvent[]): ConsumerAgent[] {
  // Replay in seq order; the latest snapshot wins. 'stopped' clears the set.
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  let live: ConsumerAgent[] = []
  for (const event of ordered) {
    if (event.type === 'stopped') {
      live = []
      continue
    }
    // Re-project only the known fields — unknown additive fields are dropped.
    const next: ConsumerAgent[] = []
    for (const agent of event.agents) {
      next.push({ id: agent.id, name: agent.name, status: agent.status })
    }
    live = next
  }
  return live
}

// AIDEV-NOTE (PMR-3QMY): v1 is additive-only, so a future payload may carry
// extra keys. These types model that WITHOUT casts: an entry/envelope that is
// structurally wider than the v1 contract. A correct consumer ignores them.
interface AdditiveStateEntry extends SubagentStateEntry {
  futureEntryField?: number
}

test('reference consumer tracks state from a burst and tolerates unknown additive fields', () => {
  const starting = buildSubagentStateSnapshot([
    { id: 'c1', name: 'a', status: 'starting' },
  ])
  const working = buildSubagentStateSnapshot([
    { id: 'c1', name: 'a', status: 'working' },
    { id: 'c2', name: 'b', status: 'starting' },
  ])
  // Highest-seq event carries one extra field per entry AND an extra
  // top-level envelope field.
  const latestEntries: AdditiveStateEntry[] = [
    { id: 'c1', name: 'a', status: 'working', futureEntryField: 42 },
    { id: 'c2', name: 'b', status: 'blocked' },
  ]
  const latestBase = buildSubagentStateSnapshot(latestEntries)
  const latest: SubagentStateEvent & { futureField?: string } = {
    ...latestBase,
    futureField: 'ignored',
  }

  // Deliver out of order (highest seq first) to prove the consumer keys on
  // seq, not arrival order.
  const live = projectState([latest, starting, working])
  assert.deepEqual(live, [
    { id: 'c1', name: 'a', status: 'working' },
    { id: 'c2', name: 'b', status: 'blocked' },
  ])

  // A trailing 'stopped' clears the live set even when received out of order.
  const stopped = buildSubagentStateStopped()
  assert.deepEqual(projectState([stopped, latest, starting, working]), [])
})

test('publishStateEvent: no-op (returns normally) for null/undefined bus', () => {
  const event = buildSubagentStateSnapshot([
    { id: 'c1', name: 'a', status: 'waiting' },
  ])
  publishStateEvent(null, event)
  publishStateEvent(undefined, event)
})

test('publishStateEvent: emits the event on the state channel', () => {
  const bus = makeFakeBus()
  const event = buildSubagentStateSnapshot([
    { id: 'c1', name: 'worker-1', status: 'working' },
  ])
  publishStateEvent(bus, event)
  assert.equal(bus.events.length, 1)
  assert.equal(bus.events[0].channel, SUBAGENT_STATE_CHANNEL)
  assert.equal(bus.events[0].data, event)
})

// AIDEV-NOTE (PMR-3QMY): isolation. A stale/throwing bus.emit must NEVER
// propagate into the status-maintenance path (spawn / tick / settle).
test('publishStateEvent: a throwing bus handler never escapes', () => {
  const throwing: FakeBus = {
    events: [],
    emit(_channel: string, _data: unknown): void {
      throw new Error('boom')
    },
  }
  const event = buildSubagentStateStopped()
  let threw = false
  try {
    publishStateEvent(throwing, event)
  } catch {
    threw = true
  }
  assert.equal(threw, false, 'publishStateEvent must swallow emit errors')
})

// ── Derivation (index.ts seam) ──
//
// AIDEV-NOTE (PMR-3QMY): `subagentStateEntries` is the live projection of
// the in-memory runningSubagents map (durable records stay authoritative).
// This test imports it from the entrypoint and drives it against fabricated
// RunningSubagent entries inserted into the SAME globalThis-backed map the
// production code reads (__test__.runningSubagents), so it exercises the
// real derivation seam. It asserts entries are sorted by id, carry exactly
// id/name/status, and that task/cwd/sessionFile are NOT projected (ISC-1,
// ISC-A-1). The insertions are cleaned up in a finally so no other test
// observes them.
function makeRunningSubagentFixture(
  overrides: Partial<RunningSubagent>,
): RunningSubagent {
  const base: RunningSubagent = {
    id: 'base',
    name: 'Base',
    task: 'do-not-leak-this-prompt',
    surface: 'pane-1',
    startTime: 0,
    sessionFile: '/tmp/secret-session.jsonl',
    statusState: createStatusState({ source: 'pi', startTimeMs: 0 }),
    interactive: false,
  }
  return { ...base, ...overrides }
}

// A present + blocked snapshot classifies to the `blocked` widget kind
// deterministically (statusKindOf does not depend on wall-clock for the
// blocked branch), so we can assert an exact status string.
function makeBlockedStatusState(): SubagentStatusState {
  const fresh = createStatusState({ source: 'pi', startTimeMs: 0 })
  return {
    ...fresh,
    snapshotState: 'present',
    phase: 'blocked',
    activeNow: false,
  }
}

test('subagentStateEntries: sorts by id, projects exactly id/name/status, drops task/cwd/sessionFile', () => {
  const runningMap = __test__.runningSubagents as Map<string, RunningSubagent>
  // Two ids chosen so insertion order (b1 then a2) is the REVERSE of sorted
  // order — a real check that the helper sorts rather than relying on Map
  // insertion order.
  runningMap.set(
    'b1',
    makeRunningSubagentFixture({
      id: 'b1',
      name: 'Beta',
      starting: true,
    }),
  )
  runningMap.set(
    'a2',
    makeRunningSubagentFixture({
      id: 'a2',
      name: 'Alpha',
      statusState: makeBlockedStatusState(),
    }),
  )
  try {
    const entries = subagentStateEntries()
    assert.deepEqual(entries, [
      { id: 'a2', name: 'Alpha', status: 'blocked' },
      { id: 'b1', name: 'Beta', status: 'starting' },
    ])
    // Sorted by id ascending.
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['a2', 'b1'],
    )
    // Each entry carries exactly the three contracted keys — task/cwd/
    // sessionFile and every other RunningSubagent field are not projected.
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'name', 'status'])
    }
  } finally {
    runningMap.delete('b1')
    runningMap.delete('a2')
  }
})

// AIDEV-NOTE (PMR-3QMY): the per-id `overrides` argument on
// `subagentStateEntries` is what fixes the blocked-on-ask race. At the
// `syncAssignmentStatus(running, 'blocked')` seam the child's activity has not
// yet flipped to `phase:'blocked'` (the `.ask` sidecar is written first and
// onAsk runs before onTick), so the DERIVED kind still reports the pre-ask
// state. The seam passes { [id]: status } so the published snapshot carries the
// authoritative transitioned status instead of the stale derivation. This test
// fabricates a running entry whose derived kind is NOT 'blocked' (a `starting`
// child), proves the derived path reports 'starting', then proves the override
// path reports 'blocked' — i.e. the override is exactly what changed the value.
test('subagentStateEntries: a per-id override wins over the stale activity-derived kind', () => {
  const runningMap = __test__.runningSubagents as Map<string, RunningSubagent>
  runningMap.set(
    'ov1',
    makeRunningSubagentFixture({
      id: 'ov1',
      name: 'Over',
      starting: true,
    }),
  )
  try {
    // Without the override, the live derivation reports the pre-ask kind.
    const derived = subagentStateEntries()
    const derivedEntry = derived.find((entry) => entry.id === 'ov1')
    assert.ok(derivedEntry, 'fixture must appear in the derived entries')
    assert.equal(derivedEntry.status, 'starting')

    // With the seam override, the published status is the just-transitioned
    // value even though the activity-derived kind lags behind.
    const overrides: Record<string, SubagentStateStatus> = { ov1: 'blocked' }
    const overridden = subagentStateEntries(overrides)
    const overriddenEntry = overridden.find((entry) => entry.id === 'ov1')
    assert.ok(overriddenEntry, 'fixture must appear in the overridden entries')
    assert.equal(overriddenEntry.status, 'blocked')
  } finally {
    runningMap.delete('ov1')
  }
})
