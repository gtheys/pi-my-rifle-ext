// AIDEV-NOTE: Deviation gate (PMR-BAGD) — runs in the validate phase after a
// 0-blocker review. A fresh-context deviation reviewer compares the resolved
// spec against the diff; its artifact is parsed here. PURE only: no
// subagent spawn, no aven/Jira/git I/O — wiring lives in review/review.ts
// (subtask 2) and the handoff prompt in validate/prompt.ts (subtask 3).
//
// AIDEV-NOTE: deviations_count artifact contract (DEFINED HERE). The emitter
// (subtask 2's prompt) imports DEVIATION_VERDICT_HEADING and
// DEVIATION_CONTRACT_PROMPT so parser and emitter can never drift. Parsing is
// scoped to the section after the LAST deviation-verdict heading so contract
// text QUOTED elsewhere cannot false-positive. Parsing is STRICT and
// fail-closed: missing, duplicated, non-integer or negative counts are
// explicit errors — never a silent 0 (a silent 0 would skip the human gate).

export const DEVIATION_VERDICT_HEADING = '## Deviation Verdict'

// AIDEV-NOTE: Each deviation carries what / why (rationale always labelled
// inferred, with evidence) / file:line. The line format is the single owner
// of that shape:
//   - deviation: <what> | why: <why> (inferred: <evidence>) | <file>:<line>
export const DEVIATION_CONTRACT_PROMPT =
  '- deviation: <what> | why: <why> (inferred: <evidence>) | <file>:<line>'

export type DeviationArtifact =
  | {
      ok: true
      deviationsCount: number
      deviations: readonly {
        what: string
        why: string
        evidence: string | undefined
        file: string
        line: number
      }[]
    }
  | { ok: false; reason: string }

const COUNT_RE = /^deviations_count:\s*(\d+)\s*$/
const DEVIATION_RE =
  /^- deviation:\s*(.+?)\s*\|\s*why:\s*(.+?)\s*\|\s*(.+?):(\d+)\s*$/
const EVIDENCE_RE = /\(inferred:\s*(.+?)\)\s*$/

// AIDEV-NOTE: Scopes parsing to the deviation verdict section so a verdict
// that merely QUOTES the contract does not double-count. The section after
// the LAST "Deviation Verdict"-style heading ALWAYS wins (that is what the
// emitter writes canonically); only when no heading exists do we fall back to
// the LAST fenced block containing a count line, else the whole artifact. A
// quoted fenced example must NEVER override a real heading verdict — that
// would parse 0 and skip the human gate.
export function extractDeviationSection(artifact: string): string {
  const headings = [
    ...artifact.matchAll(/^[ \t]*#{1,6}[ \t]+deviation verdict\b[^\n]*$/gim),
  ]
  const lastHeading = headings[headings.length - 1]
  if (lastHeading !== undefined) {
    const start = (lastHeading.index ?? 0) + lastHeading[0].length
    const rest = artifact.slice(start)
    const nextHeading = /^[ \t]*#{1,6}[ \t]+\S/m.exec(rest)
    if (nextHeading?.index !== undefined) {
      return rest.slice(0, nextHeading.index)
    }
    return rest
  }
  const fences = [...artifact.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)]
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1]
    if (body !== undefined && /^deviations_count:\s*\d+\s*$/m.test(body)) {
      return body
    }
  }
  return artifact
}

export function parseDeviationArtifact(artifact: string): DeviationArtifact {
  const counts: number[] = []
  const deviations: Extract<
    Extract<DeviationArtifact, { ok: true }>['deviations'][number],
    unknown
  >[] = []
  for (const rawLine of extractDeviationSection(artifact).split('\n')) {
    const line = rawLine.trim()
    const countMatch = COUNT_RE.exec(line)
    if (countMatch !== null) {
      counts.push(Number.parseInt(countMatch[1] as string, 10))
      continue
    }
    const deviationMatch = DEVIATION_RE.exec(line)
    if (deviationMatch !== null) {
      const what = (deviationMatch[1] as string).trim()
      const why = (deviationMatch[2] as string).trim()
      const file = (deviationMatch[3] as string).trim()
      const lineNo = Number.parseInt(deviationMatch[4] as string, 10)
      const evidenceMatch = EVIDENCE_RE.exec(why)
      let evidence: string | undefined
      if (evidenceMatch !== null) {
        evidence = (evidenceMatch[1] as string).trim()
      }
      deviations.push({ what, why, evidence, file, line: lineNo })
    }
  }
  if (counts.length === 0) {
    return {
      ok: false,
      reason:
        'deviation artifact has no "deviations_count: <N>" line — re-run the deviation reviewer and ensure the artifact ends with the count',
    }
  }
  if (counts.length > 1) {
    return {
      ok: false,
      reason: `deviation artifact has multiple deviations_count lines (${counts.join(', ')}) — exactly one is required`,
    }
  }
  const count = counts[0] as number
  if (!Number.isInteger(count) || count < 0) {
    return { ok: false, reason: `invalid deviations_count value: ${count}` }
  }
  return { ok: true, deviationsCount: count, deviations }
}

export type DeviationDecision =
  | { route: 'validate-complete' }
  | { route: 'human-decision'; deviationsNote: string }

// AIDEV-NOTE: Pure gate decision. 0 deviations -> proceed to
// flow_phase_complete(validate). >0 -> a HUMAN decides: accept the deviations
// or send the work back to /implement. This function only builds the note;
// the accept/implement choice is made by the caller (subtask 3) with the user.
export function decideDeviationRoute(
  deviationsCount: number,
  deviations: readonly string[] = [],
): DeviationDecision {
  if (deviationsCount === 0) {
    return { route: 'validate-complete' }
  }
  const listed = deviations.filter((d) => d.length > 0)
  let deviationsNote: string
  if (listed.length > 0) {
    deviationsNote = `${deviationsCount} deviation(s) from spec:\n${listed
      .map((d) => `- ${d}`)
      .join(
        '\n',
      )}\nHuman decision required: accept deviations, or return to /implement`
  } else {
    deviationsNote = `${deviationsCount} deviation(s) from spec — see the deviation artifact for details. Human decision required: accept deviations, or return to /implement`
  }
  return { route: 'human-decision', deviationsNote }
}
