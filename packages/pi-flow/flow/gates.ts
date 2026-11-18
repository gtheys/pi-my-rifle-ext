// AIDEV-NOTE (PMR-ZGPY 2.1, D4/D5/D6; fix round 2): pure open-gate derivation
// over run projections — the shared data source for the flow-status widget and
// the answer picker. No IO here beyond the GateDeps interface declaration (2.2
// wires real IO); D4: the code-review gate is journal-derived (receipt
// presence), no in-memory state. D6 anti-false-open, REAL-WRITER SEMANTICS
// (fix round 2): closers exist only for spec-review/code-review kinds —
// gate-decisions are written only by tools/deviation.ts (gate 'deviation'),
// gate-answers only carry 'spec-review' | 'code-review' (flow/answer.ts
// GATE_JOURNAL). 'review' pins (journalled by /review, review/review.ts) have
// NO closer, so they are EXCLUDED from answer-gate derivation entirely — the
// validate-phase code-review gate rule covers that same human decision and
// genuinely closes when the human passes (receipt/answer lands) or when the
// phase progresses. Suppression rule: a state that emits the code-review gate
// emits NO answer-gates (one human decision per phase boundary; the
// code-review decision subsumes them). Paused runs whose ref also has
// plan-state=review are deduped in collectOpenGates (2.2), not here — no
// aven knowledge in this module.

import { readdir, readFile } from 'node:fs/promises'
import { listOpenTicketRefs, listPlansAtReviewRefs } from '../aven/client.ts'
import type { FlowRunState } from '../run-state.ts'
import { isFlowRunState, runsDir } from '../run-state.ts'

/** One actionable gate the user can open or answer. */
export interface OpenGate {
  ref: string
  kind: 'plan-review' | 'flow-paused' | 'code-review' | 'answer-gate'
  /** Single-line, lead with the ref. */
  title: string
  /** Only for answer-gates; the choice itself is supplied by the picker menu. */
  answerCommand?: string
}

// AIDEV-NOTE: IO seam only — implemented and wired by collectOpenGates in
// 2.2. listOpenRefs (PMR-384R) is the aven-status truth source: null means
// aven FAILED (suppress nothing, ISC-13); an array is the live-ref universe
// (absent ref = terminal or no record = suppress).
export interface GateDeps {
  /** Refs of plan-state=review tickets (aven list; --all-projects). */
  listPlansAtReview(): Promise<string[]>
  /** Refs with a live (nonterminal) aven ticket, all projects; null = aven
   *  failed. Fail-closed per ISC-13: unverifiable status suppresses nothing. */
  listOpenRefs(): Promise<string[] | null>
  /** Validated FlowRunState projections from the local runs dir. */
  readRuns(): Promise<FlowRunState[]>
}

// AIDEV-NOTE: injectable fs seam for readRunsFromDisk (the readRunEvents io
// param pattern) — tests inject a fake fs; no real disk touched.
export interface GateIo {
  readdir(dir: string): Promise<string[]>
  readFile(path: string): Promise<string>
}

const nodeGateIo: GateIo = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, 'utf8'),
}

function hasCodeReviewReceipt(state: FlowRunState): boolean {
  const receipts = state.receipts ?? []
  return receipts.some((r) => r.command === 'code_review')
}

// AIDEV-NOTE (fix round 2): the phase-derived code-review gate closes via the
// conservative OR over every record mechanism a REAL writer can produce for
// the code-review kind — a code_review command receipt, a gate-answer
// ('code-review', from /flow answer pass|fail), or a gate-decision. Receipt
// alone was the round-1 shape; the OR matches isAnswered's D6 semantics.
function isCodeReviewGateClosed(state: FlowRunState): boolean {
  const answers = state.gateAnswers ?? []
  const decisions = state.gateDecisions ?? []
  return (
    hasCodeReviewReceipt(state) ||
    answers.some((a) => a.gate === 'code-review') ||
    decisions.some((d) => d.gate === 'code-review')
  )
}

function isAnswered(
  state: FlowRunState,
  targetId: string,
  gate: GateTargetGate,
): boolean {
  const decisions = state.gateDecisions ?? []
  const answers = state.gateAnswers ?? []
  // D6 conservative OR: either record closes the gate.
  return (
    decisions.some((d) => d.targetId === targetId) ||
    answers.some((a) => a.gate === gate)
  )
}

type GateTargetGate = NonNullable<FlowRunState['gateTargets']>[number]['gate']

/** Pure derivation: one or more open gates per run projection, in input order. */
export function deriveRunGates(states: readonly FlowRunState[]): OpenGate[] {
  const gates: OpenGate[] = []
  for (const state of states) {
    if (state.loop?.status === 'paused') {
      gates.push({
        ref: state.ref,
        kind: 'flow-paused',
        title: `${state.ref} — flow run paused`,
      })
    }
    const codeReviewGateOpen =
      state.currentPhase === 'validate' && !isCodeReviewGateClosed(state)
    if (codeReviewGateOpen) {
      gates.push({
        ref: state.ref,
        kind: 'code-review',
        title: `${state.ref} — validate phase awaiting code review`,
      })
    }
    // Suppression (fix round 2): the code-review decision subsumes any
    // answer-gates for this state — one human decision per phase boundary.
    if (codeReviewGateOpen) continue
    const targets = state.gateTargets ?? []
    for (const target of targets) {
      // 'review' pins have no real closer (see module AIDEV-NOTE) — never
      // derive an answer-gate for them; the code-review gate rule above owns
      // that decision.
      if (target.gate === 'review') continue
      if (!isAnswered(state, target.targetId, target.gate)) {
        gates.push({
          ref: state.ref,
          kind: 'answer-gate',
          title: `${state.ref} — ${target.gate} gate awaiting answer`,
          answerCommand: `/flow answer ${state.ref}`,
        })
      }
    }
  }
  return gates
}

// AIDEV-NOTE (PMR-ZGPY 2.2, D5): disk scan of runsDir(agentDir) — one
// validated FlowRunState per *.json file. Fail-soft per file: unreadable,
// unparsable, or non-conforming files are skipped (a corrupt run file must
// never blank the widget). io is injectable so tests run without disk.
export async function readRunsFromDisk(
  agentDir: string,
  io: GateIo = nodeGateIo,
): Promise<FlowRunState[]> {
  const dir = runsDir(agentDir)
  let entries: string[]
  try {
    entries = await io.readdir(dir)
  } catch {
    return []
  }
  const runs: FlowRunState[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = await io.readFile(`${dir}/${entry}`)
      const parsed: unknown = JSON.parse(raw)
      if (isFlowRunState(parsed)) runs.push(parsed)
    } catch {
      // corrupt/missing file — skip
    }
  }
  return runs
}

// AIDEV-NOTE (PMR-ZGPY 2.2): real GateDeps factory for phases 3–4 consumers.
// Aven boundary rule: the aven shell-out itself lives in aven/client.ts
// (listPlansAtReviewRefs) — this module only calls through it; nothing else
// in flow/ may exec aven.
export function createGateDeps(agentDir: string): GateDeps {
  return {
    listPlansAtReview: () => listPlansAtReviewRefs(),
    listOpenRefs: () => listOpenTicketRefs(),
    readRuns: () => readRunsFromDisk(agentDir),
  }
}

// AIDEV-NOTE (PMR-ZGPY 2.2, D5, ISC-13; PMR-384R): merges run-derived gates
// with the aven plan-state=review list. Each source fails closed
// INDEPENDENTLY — an aven failure keeps run-derived gates, a runs-scan
// failure keeps plan-review gates, and (PMR-384R) an aven-status failure
// (listOpenRefs → null) suppresses NOTHING — so one broken source never
// blanks the other's signal. Dedupe per D5: a ref that already has ANY
// run-derived gate (in practice the flow-paused gate, whose title already
// mentions the pause) appears exactly once; only review refs with no
// run-derived gate get a fresh plan-review row.
// PMR-384R suppression: aven ticket status is the truth (user invariant — a
// stale journal gate record cannot override it). When the open-ref universe
// is available (non-null), gates whose ref is absent from it are dropped:
// the ticket is terminal (done/canceled) or has no aven record at all
// (ungrounded projection — an unanswerable gate). [] is a REAL "zero open
// tickets" answer and suppresses everything; only null keeps gates.
// Cross-project scope note: the universe is deliberately --all-projects so
// other projects' terminal tickets (e.g. TP-85GY) suppress gates that leak
// in via the shared runsDir; the runsDir scan itself is left unfiltered —
// scoping accepted per the PMR-384R acceptance criteria (raw journal
// display in flow-viewer renders immutable history, not derived gates).
export async function collectOpenGates(deps: GateDeps): Promise<OpenGate[]> {
  const [runs, reviewRefs, openRefs] = await Promise.all([
    deps.readRuns().catch(() => [] as FlowRunState[]),
    deps.listPlansAtReview().catch(() => [] as string[]),
    deps.listOpenRefs().catch(() => null),
  ])
  const runGates = deriveRunGates(runs)
  const gatedRefs = new Set(runGates.map((g) => g.ref))
  const gates = [...runGates]
  for (const ref of reviewRefs) {
    if (gatedRefs.has(ref)) continue
    gates.push({
      ref,
      kind: 'plan-review',
      title: `${ref} · plan awaiting approval`,
      answerCommand: `/flow answer ${ref}`,
    })
  }
  if (openRefs !== null) {
    const open = new Set(openRefs)
    return gates.filter((g) => open.has(g.ref))
  }
  return gates
}
