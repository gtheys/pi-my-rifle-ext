// AIDEV-NOTE (PMR-HFK1, pi-flow observability M1): attribution env stamping
// for the MAIN process. The /flow loop is the root of the trace tree: run
// start stamps PI_FLOW_REF / PI_FLOW_PHASE / PI_FLOW_TRACEPARENT into the
// main process env, phase transitions re-stamp PI_FLOW_PHASE, and every
// terminal transition (halt, pause, done) clears all flow keys so a later
// non-flow session can never be misattributed to a dead run.
//
// Children do not inherit these by accident — the subagents package copies
// them into each `tab create --env` block (applyFlowEnv, pure) and adds
// PI_FLOW_SUBTASK for 1:1 worker spawns. The traceparent is W3C shape so a
// later telemetry module can join children onto the flow's trace tree.
//
// Every value is charset-validated BEFORE it enters env (the runFileName
// rule): a ref that can never be a filename can never be an env value.
import { randomBytes } from 'node:crypto'
import { FLOW_VALUE_RE, TRACEPARENT_RE } from '@gtheys/pi-interactive-subagents'

/** Env keys owned by this module (PI_FLOW_SUBTASK is child-only). */
export const FLOW_ENV_KEYS = [
  'PI_FLOW_REF',
  'PI_FLOW_PHASE',
  'PI_FLOW_TRACEPARENT',
  // AIDEV-NOTE: work/personal separation. PI_FLOW_REF stays the AVEN ref (the
  // journal + aven operations key on it); PI_FLOW_TRACK_REF is the ref humans
  // TRACK the run by (the Jira key in work mode, the aven ref in personal
  // mode) and is what telemetry/metrics/dashboards show. PI_FLOW_MODE is
  // 'work' | 'personal'.
  'PI_FLOW_TRACK_REF',
  'PI_FLOW_MODE',
] as const

export type FlowEnv = Record<string, string | undefined>

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Fresh W3C traceparent root: `00-<32-hex trace id>-<16-hex span id>-01`
 * (16 + 8 bytes of randomness). Randomness is injected so tests are
 * deterministic. A fresh root per /flow invocation (never reused across
 * runs): a crashed run's env may survive in the process, and reusing its
 * trace id would merge two invocations of the same (or worse, a different)
 * ref into one trace tree. Cost rollup keys on PI_FLOW_REF, not the trace
 * id, so per-invocation roots lose nothing.
 */
export function newTraceparent(
  rng: () => Uint8Array = () => randomBytes(24),
): string {
  const bytes = rng()
  const traceId = toHex(bytes.subarray(0, 16))
  const spanId = toHex(bytes.subarray(16, 24))
  return `00-${traceId}-${spanId}-01`
}

export type StampResult = { ok: true } | { ok: false; reason: string }

/**
 * Stamp a flow start into `env`: ref + phase + a fresh traceparent root.
 * An invalid ref fails closed with a reason (the caller aborts the run —
 * the journal filename would be unusable anyway).
 */
export interface StampExtras {
  /** Tracking ref (Jira key in work mode); falls back to `ref` when absent/invalid. */
  trackRef?: string
  mode?: 'work' | 'personal'
}

export function stampFlowStart(
  env: FlowEnv,
  ref: string,
  phase: string,
  rng?: () => Uint8Array,
  extras?: StampExtras,
): StampResult {
  if (!FLOW_VALUE_RE.test(ref)) {
    return {
      ok: false,
      reason: `invalid flow ref "${ref}" (must match [A-Za-z0-9][A-Za-z0-9._-]{0,99})`,
    }
  }
  if (!FLOW_VALUE_RE.test(phase)) {
    return { ok: false, reason: `invalid flow phase "${phase}"` }
  }
  env.PI_FLOW_REF = ref
  env.PI_FLOW_PHASE = phase
  // a stale tracking ref/mode from a superseded run must never survive
  delete env.PI_FLOW_TRACK_REF
  delete env.PI_FLOW_MODE
  if (extras?.trackRef !== undefined && FLOW_VALUE_RE.test(extras.trackRef)) {
    env.PI_FLOW_TRACK_REF = extras.trackRef
  }
  if (extras?.mode === 'work' || extras?.mode === 'personal') {
    env.PI_FLOW_MODE = extras.mode
  }
  let generated = newTraceparent(rng)
  if (!TRACEPARENT_RE.test(generated)) {
    // AIDEV-NOTE: defensive — an injected rng returning short byte arrays
    // would produce a malformed root. Pad is impossible to do honestly, so
    // fall back to real randomness rather than stamping a broken value.
    generated = newTraceparent()
  }
  env.PI_FLOW_TRACEPARENT = generated
  return { ok: true }
}

/** Re-stamp the phase on a transition (ref must already be stamped). */
export function stampFlowPhase(env: FlowEnv, phase: string): void {
  if (!FLOW_VALUE_RE.test(phase)) return
  env.PI_FLOW_PHASE = phase
}

/** Clear every flow env key — terminal transitions only. */
export function clearFlowEnv(env: FlowEnv): void {
  for (const key of FLOW_ENV_KEYS) delete env[key]
  delete env.PI_FLOW_SUBTASK
}

/**
 * Which run journal a subagent spawn belongs to. The main process, while its
 * loop runs, owns the full journal + projection path. A flow WORKER (scouts
 * spawned by a plan agent, ...) has no running loop but inherited
 * PI_FLOW_REF, so its spawns still belong to that flow — those go to the
 * journal only (see recordRunEventJournalOnly). null = not part of any flow.
 */
export function spawnJournalTarget(
  activeRef: string | null,
  env: FlowEnv,
): { ref: string; nested: boolean } | null {
  if (activeRef !== null) return { ref: activeRef, nested: false }
  const envRef = env.PI_FLOW_REF
  if (envRef === undefined || envRef.length === 0) return null
  return { ref: envRef, nested: true }
}
