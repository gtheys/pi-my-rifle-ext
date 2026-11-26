// AIDEV-NOTE: PMR-ZV9Y 3.2 — tests for the v2 half of `tombstoneBody`
// (flow/reconcile.ts): the v2 gauge families render into the SAME stored group
// body as the frozen run-health lines, so a tombstone must flip
// `pi_flow_state{…state="halted"|"waiting_human"|"waiting_machine"}` and its
// `pi_flow_state_start_seconds` twin to `state="stale"` (ISC-8) with the exact
// label-VALUE-only surgery the retired v1 status line used to get.
//
// AIDEV-NOTE (PMR-ZV9Y 7.1): the v1 state vocabulary is retired, so this file
// is the ONLY tombstone shape: `tombstoneBody` flips the two v2 state families
// to `state="stale"`. AIDEV-NOTE (PMR-ZV9Y fix round 1, P3a — corrected this
// header's original "it DROPS no line at all any more" wording, which was wrong
// after P3a): the pass ALSO DROPS the transient `pi_flow_step{…}` open-step
// gauge (pinned by the drop test below); `pi_flow_step_seconds`,
// `pi_flow_phase` and `pi_flow_wait_seconds` stay byte-identical, and the
// halt_reason drop is gone with the v1 block itself. The fixtures keep one
// retired v1 line each as a regression guard that the engine no longer touches
// it.
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
  // AIDEV-NOTE (PMR-ZV9Y 7.1): the stored v1 status line in this fixture is a
  // REGRESSION GUARD — the engine must leave it byte-identical, because the v1
  // rewrite disappeared with the v1 lines. This fixture carries NO
  // `pi_flow_step{` line, so the P3a open-step drop has nothing to remove here
  // and every line survives (the drop itself is pinned separately below).
  assert.equal(
    got,
    body(
      'pi_flow_blocker_retries{job="pi-flow",mode="work",ref="DP-236"} 0',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="halted"} 1',
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
  // ISC-8 names the STATE lines only. pi_flow_phase / pi_flow_wait_seconds /
  // pi_flow_step_seconds carry no state label, and a rewrite keyed on a
  // lookalike label would be the free-text soup ISC-A-1 forbids. The OPEN-step
  // gauge `pi_flow_step{…} 1` IS dropped by the P3a decision (below) — this
  // fixture deliberately contains NO `pi_flow_step{` line so the "never
  // rewritten" posture for the remaining families stays pinned byte-identical.
  const lines = [
    'pi_flow_phase{job="pi-flow",mode="work",phase="plan",ref="DP-1"} 1',
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
    'pi_flow_state{job="pi-flow",mode="work",reason="escalation",ref="DP-1",state="stale"} 1',
  ])
})

// AIDEV-NOTE (PMR-ZV9Y fix round, P3a — tombstone-side decision):
// A tombstone retires a run to `stale`. The OPEN-step gauge `pi_flow_step{…} 1`
// is the ONLY v2 family with no `state` label whose whole meaning ("a step is
// in flight right now") is FALSE for a retired run, so it cannot be
// value-rewritten to stale the way the state pair can — dropping it is the
// correct and the only lever the tombstone has. It is dropped ONLY inside a
// tombstone pass that flips a state line (tombstoneBody returns null when
// nothing was rewritten, so the drop never reaches a POST that does not also
// carry the state→stale flip). This is correct under the official Pushgateway
// Replace semantics the whole reconcile round-trip is built for (push.ts
// P2-5). On the homelab gateway that MERGES on write (PMR-WBC2) the drop
// degrades to a no-op — the stored series simply persists — exactly like the
// retired halt_reason drop; it is never harmful, and the PRIMARY fix is the
// render-side suppression in state-metrics.ts `isTerminalState`, which stops
// NEW phantoms from ever being pushed. `pi_flow_step_seconds`, `pi_flow_phase`
// and `pi_flow_wait_seconds` are cumulative / no-state-label history and stay
// byte-identical — only the transient `pi_flow_step{` gauge is dropped.
test('tombstoneBody: the open-step pi_flow_step gauge is dropped, step_seconds/phase/wait kept', () => {
  const got = tombstoneBody(
    body(
      'pi_flow_phase{job="pi-flow",mode="work",phase="validate",ref="DP-1"} 1',
      'pi_flow_step{job="pi-flow",mode="work",phase="validate",ref="DP-1",step="validate.code-review"} 1',
      'pi_flow_step_seconds{job="pi-flow",mode="work",phase="validate",ref="DP-1",step="validate.deviation"} 90',
      'pi_flow_state{job="pi-flow",mode="work",reason="label_miss",ref="DP-1",state="halted"} 1',
    ),
  )
  assert.notEqual(got, null)
  const kept = String(got)
    .split('\n')
    .filter((line) => line.length > 0)
  assert.deepEqual(kept, [
    'pi_flow_phase{job="pi-flow",mode="work",phase="validate",ref="DP-1"} 1',
    // pi_flow_step{…} 1 dropped (no live step for a stale run)
    'pi_flow_step_seconds{job="pi-flow",mode="work",phase="validate",ref="DP-1",step="validate.deviation"} 90',
    'pi_flow_state{job="pi-flow",mode="work",reason="label_miss",ref="DP-1",state="stale"} 1',
  ])
  assert.ok(
    !String(got).includes('pi_flow_step{'),
    'open-step gauge must not survive a tombstone',
  )
  assert.ok(
    String(got).includes('pi_flow_step_seconds{'),
    'cumulative step_seconds must survive',
  )
})

test('tombstoneBody: a drop only happens when a state line is actually flipped', () => {
  // A running run with an open step is NOT a tombstone candidate (the rewrite
  // returns null), so we never silently drop a pi_flow_step for a live run.
  const running = tombstoneBody(
    body(
      'pi_flow_step{job="pi-flow",mode="work",phase="validate",ref="DP-1",step="validate.code-review"} 1',
      'pi_flow_state{job="pi-flow",mode="work",reason="",ref="DP-1",state="running"} 1',
    ),
  )
  assert.equal(running, null, 'running state is not a tombstone target → null')
})

test('tombstoneBody: running and done are NOT flipped (unchanged posture)', () => {
  // AIDEV-NOTE (PMR-ZV9Y 3.2 running-state decision, unchanged by 7.1): v2
  // leaves `state="running"` and `state="done"` alone — they are outside the
  // tombstone targets, and a group holding ONLY such a line reads as
  // "already clean" (null) because the candidate filter is journal-keyed
  // (livenessStatusOf). That mirrors what the retired v1 status rewrite did for
  // `status="running"|"done"`, so the known limitation P2-4 (a stored group
  // that shows a status the journal has already moved past is not retired by
  // this pass) behaves the same way as before the retirement.
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

test('tombstoneBody: a v1-only body is no longer a target at all (7.1)', () => {
  // The retired vocabulary: `pi_flow_run_status` used to flip to
  // `status="stale"` and `pi_flow_run_halt_reason` used to be DROPPED from the
  // re-POSTed body. Both behaviours disappeared with the lines themselves — a
  // body that carries no v2 state line is now "already clean" and is never
  // re-pushed, and every line in it survives byte-identical.
  const got = tombstoneBody(
    body(
      'pi_flow_run_halt_reason{job="pi-flow",mode="work",reason="boom",ref="DP-1"} 1',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-1",status="paused"} 1',
      'pi_flow_gate_wait_seconds{choice="reject",gate="spec-review",job="pi-flow",mode="work",n="1",ref="DP-1"} 1830',
      'pi_flow_human_wait_seconds{job="pi-flow",mode="work",ref="DP-1"} 1830',
    ),
  )
  assert.equal(got, null)
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
  // the retired v1 status line is gone from the rendered body, and the v2
  // state lines flipped in its place
  assert.ok(
    !String(tombstoned).includes('pi_flow_run_status'),
    String(tombstoned),
  )
  assert.ok(!String(tombstoned).includes('state="halted"'), String(tombstoned))
  // AIDEV-NOTE (PMR-ZV9Y 7.1): nothing may disappear from the body any more —
  // the halt_reason drop retired with its metric, so the line count is equal.
  assert.equal(
    String(tombstoned)
      .split('\n')
      .filter((line) => line.length > 0).length,
    rendered.split('\n').filter((line) => line.length > 0).length,
    'a tombstone must rewrite values without dropping a line',
  )
})
