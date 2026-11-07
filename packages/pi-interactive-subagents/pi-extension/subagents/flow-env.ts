// AIDEV-NOTE (PMR-HFK1, pi-flow observability M1): flow attribution env
// forwarding. Pure module — no fs, no process reads inside the helpers; the
// spawn/resume sites pass the parent env explicitly so tests stay pure. The
// /flow loop (pi-flow package) stamps PI_FLOW_REF / PI_FLOW_PHASE /
// PI_FLOW_TRACEPARENT into the MAIN process env; this module copies them
// into each child's `tab create --env` block and adds PI_FLOW_SUBTASK when
// the spawn maps 1:1 to a plan task. Children therefore join the flow's
// trace tree and per-ticket / per-subtask cost becomes computable.
//
// Values are validated BEFORE they enter env (same safe-charset rule as
// pi-flow's runFileName — a ref that can never be a filename can never be
// an env value either). Invalid parent values are dropped fail-closed, never
// forwarded mangled.

/** Safe charset for flow refs / phases / subtask refs (runFileName rule). */
export const FLOW_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** W3C traceparent shape (version-traceid-spanid-flags, lowercase hex). */
export const TRACEPARENT_RE =
  /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/

export function isValidFlowValue(value: string | undefined): boolean {
  if (value === undefined) return false
  return FLOW_VALUE_RE.test(value)
}

export function isValidTraceparent(value: string | undefined): boolean {
  if (value === undefined) return false
  return TRACEPARENT_RE.test(value)
}

/**
 * Copy the flow attribution vars from the parent env into a child env block.
 * Pure: mutates only `env`, reads only `parentEnv`. Keys absent or invalid
 * in the parent are simply not forwarded (fail-closed). `subtask` is the
 * agent-supplied plan-task ref for a 1:1 worker spawn — omitted (or invalid)
 * means the child is a scout/general worker and gets no subtask stamp.
 */
export function applyFlowEnv(
  env: Record<string, string>,
  parentEnv: Record<string, string | undefined>,
  subtask?: string,
): void {
  const ref = parentEnv.PI_FLOW_REF
  if (isValidFlowValue(ref)) env.PI_FLOW_REF = ref as string
  const phase = parentEnv.PI_FLOW_PHASE
  if (isValidFlowValue(phase)) env.PI_FLOW_PHASE = phase as string
  const traceparent = parentEnv.PI_FLOW_TRACEPARENT
  if (isValidTraceparent(traceparent)) {
    env.PI_FLOW_TRACEPARENT = traceparent as string
  }
  if (subtask !== undefined && isValidFlowValue(subtask)) {
    env.PI_FLOW_SUBTASK = subtask
  }
}

/** What the subagents package can tell a flow-aware caller about a spawn. */
export interface FlowSpawnInfo {
  /** 'spawn' = fresh tab; 'resume'/'reattach' = takeover of existing work. */
  kind: 'spawn' | 'resume' | 'reattach'
  childId: string
  name: string
  /** Plan-task ref when the spawn maps 1:1 to one; absent for scouts. */
  subtask?: string
}

export type FlowSpawnListener = (info: FlowSpawnInfo) => void

// AIDEV-NOTE: the registry lives on globalThis (same pattern as
// RUNNING_KEY / POLL_ABORT_KEY in index.ts). Pi loads this package's
// extension entrypoint directly while pi-flow imports it through the
// workspace package root — under some loaders those are distinct module
// instances, so a module-level Set would NOT be shared. globalThis is the
// established cross-instance channel in this codebase.
const FLOW_SPAWN_LISTENERS_KEY = 'pi-subagents-flow-spawn-listeners'

function flowSpawnListeners(): Set<FlowSpawnListener> {
  const holder = globalThis as Record<string, unknown>
  const existing = holder[FLOW_SPAWN_LISTENERS_KEY]
  if (existing instanceof Set) return existing as Set<FlowSpawnListener>
  const created = new Set<FlowSpawnListener>()
  holder[FLOW_SPAWN_LISTENERS_KEY] = created
  return created
}

/** Subscribe to spawn/resume/reattach events; returns an unsubscribe fn. */
export function onFlowSpawn(listener: FlowSpawnListener): () => void {
  const set = flowSpawnListeners()
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

/** Best-effort notify — a listener failure must never break a spawn. */
export function emitFlowSpawn(info: FlowSpawnInfo): void {
  for (const listener of flowSpawnListeners()) {
    try {
      listener(info)
    } catch {}
  }
}
