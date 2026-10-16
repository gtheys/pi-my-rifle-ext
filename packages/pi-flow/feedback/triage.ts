// AIDEV-NOTE: Pure feedback triage core (PMR-XDRB phase 5). classify() is the
// work-mode decision over a SonarQube / review finding: small mechanical
// findings are fixed immediately; anything behavioral/architectural/data
// touching MUST become a new task through the flow gates — feedback can never
// re-open implementation silently. canClose() is the completion guard: the
// personal-mode outcome summary note must exist before the ticket goes done.
// All pure — the command handler and handoff prompt own all I/O.
//
// AIDEV-NOTE: Classifier thresholds are JUDGMENT CALLS, documented here:
//   - Mechanical set = {minor, style, naming}: cosmetic, zero behavior risk.
//   - ANY finding whose description mentions behavior/architecture/data/
//     migration/schema/API-contract escalates even if severity says "minor" —
//     severity labels lie more often than descriptions do.
//   - UNKNOWN severity escalates (fail-closed): silence beats a broken fix.
//   - major/critical/blocker always escalate: too big to "just fix" while
//     closing out a phase.

export interface Finding {
  severity?: string
  description?: string
}

export type TriageAction = 'fix-now' | 'new-task'

export interface TriageDecision {
  action: TriageAction
}

export const FIX_NOW_SEVERITIES = new Set(['minor', 'style', 'naming'])

const BEHAVIORAL_RE =
  /\b(behaviou?r|architect|data|migration|schema|api contract|breaking|logic)\b/i

export function classify(finding: Finding): TriageDecision {
  const description = finding.description ?? ''
  if (BEHAVIORAL_RE.test(description)) {
    return { action: 'new-task' }
  }
  const severity = finding.severity
  if (severity === undefined) {
    return { action: 'new-task' }
  }
  if (FIX_NOW_SEVERITIES.has(severity.toLowerCase())) {
    return { action: 'fix-now' }
  }
  return { action: 'new-task' }
}

export interface OutcomeSummaryInput {
  whatShipped: string
  testEvidence: string
  reviewVerdict: string
}

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function outcomeSummary(input: OutcomeSummaryInput): string {
  const sections: Array<[string, string]> = [
    ['What shipped', input.whatShipped],
    ['Test evidence', input.testEvidence],
    ['Review verdict', input.reviewVerdict],
  ]
  for (const [name, value] of sections) {
    if (!hasContent(value)) {
      return `insufficient context: outcome summary section "${name}" is empty — fill every section before closing the ticket`
    }
  }
  return [
    '## Outcome summary',
    '',
    '### What shipped',
    input.whatShipped.trim(),
    '',
    '### Test evidence',
    input.testEvidence.trim(),
    '',
    '### Review verdict',
    input.reviewVerdict.trim(),
  ].join('\n')
}

// AIDEV-NOTE: Completion guard — done REQUIRES the outcome summary note to
// have been written. Fail-closed by design.
export function canClose(summaryWritten: boolean): boolean {
  return summaryWritten
}
