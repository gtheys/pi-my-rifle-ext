// AIDEV-NOTE: PMR-422Q — the live-wait lease tunables. The lease deadline in
// flow/loop.ts is that guard's DEAD-MAN'S SWITCH: an armed live-wait hold may
// only suppress loop emissions while `now < leaseExpiresAt`, so a wait whose
// owning seam died (process exit, lost tool_result, a settle that closed a
// different wait) releases itself instead of latching the journal to
// `waiting_human` for the rest of the run.
//
// WINDOW/BEAT INVARIANT: LIVE_WAIT_LEASE_SECONDS must stay >= 2-3x the
// heartbeat interval (LIVE_WAIT_HEARTBEAT_MS), i.e. the window has to tolerate
// TWO OR THREE missed beats. A heartbeat that is merely late (an event loop
// under load, an unref'd timer firing after a long turn) must never be able to
// expire the lease: the board would flip to a non-waiting state while a human
// is still being asked, which is the exact wrongness the hold exists to
// prevent. Lowering the window or raising the interval breaks this;
// test/live-wait.test.ts pins the ratio.
//
// HEARTBEATS ARE IN-PROCESS PINGS — the lease is NEVER JOURNALED. A beat is a
// direct call (index.ts -> loop.renewLiveWaitLease), not a journal record: the
// hold flag is reset by start() and the deadline lives only in memory, so
// journal visibility would buy nothing while costing a write per beat on the
// single-writer journal and creating a second, competing source of truth for
// the wait state. Nothing outside this process may read or extend a lease.

/** Interval between lease-renewing heartbeat beats (flow/ask-emitter.ts). */
export const LIVE_WAIT_HEARTBEAT_MS = 60_000

/** Lease window in seconds — how long a beat keeps the hold alive. */
export const LIVE_WAIT_LEASE_SECONDS = 180

/**
 * Shift a fixed-width UTC ISO stamp (`2026-11-28T00:00:00.000Z`, 24 chars, as
 * every journal `at` is written) forward by `seconds`, returning the same
 * fixed-width shape so lexicographic comparison against another `at` string
 * stays a valid chronology test.
 *
 * An unparseable `at` yields an Invalid Date and `toISOString()` throws
 * RangeError — deliberate and fail-loud: a silently-garbage deadline either
 * expires a live wait early or never expires at all.
 */
export function addSecondsIso(at: string, seconds: number): string {
  return new Date(Date.parse(at) + seconds * 1000).toISOString()
}
