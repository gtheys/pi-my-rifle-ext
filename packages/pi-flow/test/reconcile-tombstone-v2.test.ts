// AIDEV-NOTE: PMR-ZV9Y 3.2 — tests for the v2 half of `tombstoneBody`
// (flow/reconcile.ts): the six v2 gauge families render into the SAME stored
// group body as the frozen v1 lines, so a tombstone must flip
// `pi_flow_state{…state="halted"|"waiting_human"|"waiting_machine"}` and its
// `pi_flow_state_start_seconds` twin to `state="stale"` (ISC-8) with the exact
// label-VALUE-only surgery v1 applies to `status="…"`. Deliberately a NEW file
// so `test/reconcile.test.ts` stays untouched (ISC-A-4); the v1-only cases it
// owns are the proof that the v1 behaviour did not move.
//
// Fixtures keep reconcile.test.ts's REAL shape: what `fetchGroupBody` reads
// back from a live gateway, i.e. alphabetical labels (job, mode, reason, ref,
// state), no `#` comment lines (push.ts drops them), no `instance=""` pair.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tombstoneBody } from '../flow/reconcile.ts'
import { renderRunHealthLines } from '../flow/run-health.ts'
import type { FlowRunEvent } from '../run-state.ts'

function body(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

/** A stored work group for a run that halted with a closed-enum reason. */
function haltedV2Lines(): string[] {
  return [
    'pi_flow_blocker_retries{job="pi-flow",mode="work",ref="DP-236"} 0',
    'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="halted"} 1',
    'pi_flow_state{job="pi-flow",mode="work",reason="label_miss",ref="DP-236",state="halted"} 1',
    'pi_flow_state_start_seconds{job="pi-flow",mode="work",reason="label_miss",ref="DP-236",state="halted"} 1795428060',
  ]
}

test('tombstoneBody: v2 halted state lines flip to stale, values untouched', () => {
  const got = tombstoneBody(body(...haltedV2Lines()))
  assert.notEqual(got, null)
  assert.equal(
    got,
    body(
      'pi_flow_blocker_retries{job="pi-flow",mode="work",ref="DP-236"} 0',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="stale"} 1',
      'pi_flow_state{job="pi-flow",mode="work",reason="label_miss",ref="DP-236",state="stale"} 1',
      'pi_flow_state_start_seconds{job="pi-flow",mode="work",reason="label_miss",ref="DP-236",state="stale"} 1795428060',
    ),
  )
})

test('tombstoneBody: waiting_human and waiting_machine flip to stale', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_state{job="pi-flow",mode="work",reason="spec_approval_pending",ref="DP-1",state="waiting_human"} 1',
      'pi_flow_state{job="pi-flow",mode="work",reason="subagent_in_flight",ref="DP-1",state="waiting_machine"} 1',
      'pi_flow_state_start_seconds{job="pi-flow",mode="work",reason="subagent_in_flight",ref="DP-1",state="waiting_machine"} 42',
    ),
  )
  assert.notEqual(got, null)
  assert.equal(String(got).match(/state="stale"/g)?.length, 3)
  assert.ok(!String(got).includes('state="waiting_human"'))
  assert.ok(!String(got).includes('state="waiting_machine"'))
})

test('tombstoneBody: the empty reason label survives the rewrite', () => {
  // A legacy journal renders `reason=""` (ISC-6), so the stale line must keep
  // the empty label rather than drop it — the series identity has to stay
  // identical apart from the state value, or the boards/alerts lose the join.
  const got = tombstoneBody(
    body(
      'pi_flow_state{job="pi-flow",ref="PMR-C0WG",reason="",state="waiting_human"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_state{job="pi-flow",ref="PMR-C0WG",reason="",state="stale"} 1',
    ),
  )
})

test('tombstoneBody: every sibling label and the trailing value stay byte-identical', () => {
  const got = tombstoneBody(`${haltedV2Lines().join('\n')}\n`)
  assert.notEqual(got, null)
  const state = String(got)
    .split('\n')
    .find((line) => line.startsWith('pi_flow_state{'))
  assert.equal(
    state,
    'pi_flow_state{job="pi-flow",mode="work",reason="label_miss",ref="DP-236",state="stale"} 1',
  )
  // the block-6 counter line was not rewritten at all
  assert.ok(
    String(got).includes(
      'pi_flow_blocker_retries{job="pi-flow",mode="work",ref="DP-236"} 0',
    ),
  )
})

test('tombstoneBody: the phase/step/wait v2 families are never tombstoned', () => {
  // ISC-8 names the STATE lines only. pi_flow_phase / pi_flow_step /
  // pi_flow_wait_seconds carry no state label, and a rewrite keyed on a
  // lookalike label would be the free-text soup ISC-A-1 forbids.
  const lines = [
    'pi_flow_phase{job="pi-flow",mode="work",phase="plan",ref="DP-1"} 1',
    'pi_flow_step{job="pi-flow",mode="work",phase="plan",ref="DP-1",step="plan.spec-approval"} 1',
    'pi_flow_wait_seconds{job="pi-flow",mode="work",reason="spec_approval_pending",ref="DP-1",wait_kind="human"} 540',
    'pi_flow_step_seconds{job="pi-flow",mode="work",phase="plan",ref="DP-1",step="plan.spec-approval"} 60',
    'pi_flow_state{job="pi-flow",mode="work",reason="escalation",ref="DP-1",state="waiting_human"} 1',
  ]
  const got = tombstoneBody(body(...lines))
  assert.notEqual(got, null)
  const kept = String(got)
    .split('\n')
    .filter((line) => line.length > 0)
  assert.deepEqual(kept, [
    lines[0],
    lines[1],
    lines[2],
    lines[3],
    'pi_flow_state{job="pi-flow",mode="work",reason="escalation",ref="DP-1",state="stale"} 1',
  ])
})

test('tombstoneBody: running and done are NOT flipped (v1 mirror)', () => {
  // AIDEV-NOTE (PMR-ZV9Y 3.2 running-state decision): v1 leaves
  // `pi_flow_run_status{status="running"}` and `status="done"` alone — they are
  // outside LIVENESS_STATUSES, and a group holding ONLY such a line reads as
  // "already clean" (null) because the candidate filter is journal-keyed
  // (livenessStatusOf). v2 mirrors that exactly: running/done/stale are not a
  // tombstone target, so the known limitation P2-4 (a stored group that shows a
  // status the journal has already moved past is not retired by this pass)
  // behaves identically for both vocabularies instead of half-tombstoning one.
  const running = tombstoneBody(
    body(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="running"} 1',
      'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="running"} 1',
      'pi_flow_state_start_seconds{job="pi-flow",mode="work",reason="",ref="DP-1",state="running"} 42',
    ),
  )
  assert.equal(running, null)
  const done = tombstoneBody(
    body(
      'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="done"} 1',
    ),
  )
  assert.equal(done, null)
  // an already-tombstoned v2 line needs no second rewrite (idempotent pass)
  assert.equal(
    tombstoneBody(
      body(
        'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="stale"} 1',
      ),
    ),
    null,
  )
})

test('tombstoneBody: only the state-bearing v2 metrics get surgery (decoy)', () => {
  // A foreign/kept series that happens to carry a `state="halted"`-shaped
  // label must pass through untouched — the rewrite is keyed on the metric
  // NAME, exactly like the v1 `pi_flow_run_status` keying.
  const decoy =
    'pi_flow_run_cost_usd{agent="main",job="pi-flow",mode="work",ref="DP-1",state="halted"} 0.25'
  const got = tombstoneBody(
    body(
      decoy,
      'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="halted"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      decoy,
      'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="stale"} 1',
    ),
  )
  assert.equal(String(got).match(/state="stale"/g)?.length, 1)
})

test('tombstoneBody: an escaped state-like label value is not the state label', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_state{job="pi-flow",note="still state=\\"halted\\"",ref="DP-1",state="halted"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_state{job="pi-flow",note="still state=\\"halted\\"",ref="DP-1",state="stale"} 1',
    ),
  )
})

test('tombstoneBody: comment lines pass through untouched (type-line rule)', () => {
  // state-metrics.ts emits BARE sample lines (no `# TYPE`), and push.ts strips
  // every `#` line when it reads a group back — a tombstone must still not
  // invent or rewrite one, so the re-POST keeps the untyped shape that made
  // PMR-WBC2 work.
  const got = tombstoneBody(
    body(
      '# HELP pi_flow_state Auto-detected based on sample values below.',
      '# TYPE pi_flow_state untyped',
      'pi_flow_state{job="pi-flow",ref="DP-1",reason="",state="waiting_machine"} 1',
    ),
  )
  assert.equal(
    got,
    body(
      '# HELP pi_flow_state Auto-detected based on sample values below.',
      '# TYPE pi_flow_state untyped',
      'pi_flow_state{job="pi-flow",ref="DP-1",reason="",state="stale"} 1',
    ),
  )
})

test('tombstoneBody: a v1-only body behaves exactly as before', () => {
  // The v1 pattern (test/reconcile.test.ts) pinned here once more for the
  // mixed-vocabulary call site: halted status -> stale, halt_reason dropped.
  const got = tombstoneBody(
    body(
      'pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="boom",ref="DP-1"} 1',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="paused"} 1',
      'pi_flow_gate_wait_seconds{choice="reject",gate="spec-review",job="pi-flow",mode="work",n="1",ref="DP-1"} 1830',
    ),
  )
  assert.equal(
    got,
    body(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="stale"} 1',
      'pi_flow_gate_wait_seconds{choice="reject",gate="spec-review",job="pi-flow",mode="work",n="1",ref="DP-1"} 1830',
    ),
  )
})

test('tombstoneBody: an empty body and a body with no state line mean null', () => {
  assert.equal(tombstoneBody(''), null)
  assert.equal(
    tombstoneBody(
      body('pi_flow_tokens_total{job="pi-flow",ref="DP-1",kind="input"} 100'),
    ),
    null,
  )
})

// ---------------------------------------------------------------------------
// PMR-ZV9Y 3.2: the render -> tombstone round-trip.
//
// Everything above feeds tombstoneBody a hand-written, GATEWAY-SHAPED body
// (alphabetical labels), which is what fetchGroupBody really returns. This
// case closes the other half of the seam: the body this package RENDERS keeps
// emitter label order (`ref,state,reason`), so the state surgery must find the
// token there too. If the two shapes ever diverge in a way that breaks the
// rewrite, a tombstone would silently leave a dead run on the Waiting-on-me
// queue (ISC-8).
// ---------------------------------------------------------------------------

test('tombstoneBody: a body rendered by this package round-trips to stale', () => {
  const ref = 'PMR-H'
  const t0 = '2026-11-23T10:00:00.000Z'
  const shift = (seconds: number) =>
    new Date(Date.parse(t0) + seconds * 1000).toISOString()
  // Annotated (not cast) so a drifted event shape is a compile error here
  // rather than a silently unrendered line.
  const events: FlowRunEvent[] = [
    { kind: 'run-start', at: t0, ref, mode: 'personal' },
    {
      kind: 'loop-state',
      at: shift(1),
      ref,
      loop: {
        phase: 'validate',
        awaitingOutcome: false,
        blockerRetries: 0,
        validateStartedAt: shift(1),
        status: 'halted',
      },
    },
    {
      kind: 'state-change',
      at: shift(2),
      ref,
      state: 'halted',
      reason: 'label_miss',
    },
  ]
  const rendered = `${renderRunHealthLines(ref, events).join('\n')}\n`
  // emitter order, not gateway alphabetical order
  assert.ok(rendered.includes('{ref="PMR-H",state="halted"'), rendered)
  const tombstoned = tombstoneBody(rendered)
  assert.notEqual(tombstoned, null)
  assert.ok(
    String(tombstoned).includes(
      'pi_flow_state{ref="PMR-H",state="stale",reason="label_miss"} 1',
    ),
    String(tombstoned),
  )
  assert.ok(
    String(tombstoned).includes(
      'pi_flow_state_start_seconds{ref="PMR-H",state="stale",reason="label_miss"}',
    ),
    String(tombstoned),
  )
  // the v1 status line flipped in the same pass, and nothing else moved
  assert.ok(String(tombstoned).includes('status="stale"'), String(tombstoned))
  assert.ok(!String(tombstoned).includes('state="halted"'), String(tombstoned))
  assert.equal(
    String(tombstoned)
      .split('\n')
      .filter((line) => line.length > 0).length,
    rendered.split('\n').filter((line) => line.length > 0).length - 1,
    'only pi_flow_run_halt_reason may disappear from the body',
  )
})
