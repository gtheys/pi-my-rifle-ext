// AIDEV-NOTE: Personal-mode /validate core (PMR-8449). No cluster here — the
// human IS the test environment. composeHumanTest turns the plan/research
// artifact sections into concrete runnable steps; empty/whitespace-only
// sections yield an explicit insufficient-context result instead of generic
// filler (that is the "not generic advice" acceptance criterion, tested in
// test/validate.test.ts). routePersonalOutcome is the pure outcome router:
// pass -> complete with a dated aven note; fail -> back to /implement with
// the human's failure description as the note and the retry budget reset.
// Both are side-effect-free; the command handler and the handoff prompt own
// all I/O (aven notes, ask_user_question).

export interface HumanTestInput {
  whatChanged: string
  planValidationNotes: string
  researchFindings: string
}

export type ComposedTest =
  | { ok: true; steps: string[]; expectedOutcome: string }
  | { ok: false; reason: string }

function hasContent(value: string): boolean {
  return value.trim().length > 0
}

export function composeHumanTest(input: HumanTestInput): ComposedTest {
  const sections: Array<[string, string]> = [
    ['what changed', input.whatChanged],
    ['plan validation notes', input.planValidationNotes],
    ['research findings', input.researchFindings],
  ]
  const present = sections.filter(([, v]) => hasContent(v))
  if (present.length === 0) {
    return {
      ok: false,
      reason:
        'insufficient context: none of whatChanged / planValidationNotes / researchFindings are present — read the ticket artifacts before composing test instructions',
    }
  }
  const steps: string[] = []
  steps.push(`Context — ${present[0]?.[0]}: ${present[0]?.[1].trim()}`)
  for (const [name, value] of present.slice(1)) {
    steps.push(`${name}: ${value.trim()}`)
  }
  let expectedOutcome: string
  if (hasContent(input.planValidationNotes)) {
    expectedOutcome = input.planValidationNotes.trim()
  } else if (hasContent(input.researchFindings)) {
    expectedOutcome = input.researchFindings.trim()
  } else {
    expectedOutcome = input.whatChanged.trim()
  }
  return { ok: true, steps, expectedOutcome }
}

// AIDEV-NOTE: Pure outcome router for the human pass/fail answer. The date is
// injected (not new Date()) so the router stays deterministic and testable.
export type PersonalOutcome =
  | { kind: 'pass' }
  | { kind: 'fail'; description: string }

export type PersonalRouting =
  | { action: 'complete'; avenNote: string }
  | {
      action: 'reimplement'
      avenNote: string
      route: '/implement'
      retryBudgetReset: boolean
    }
  | { action: 'invalid'; reason: string }

export function routePersonalOutcome(
  outcome: PersonalOutcome,
  date: string,
): PersonalRouting {
  if (outcome.kind === 'pass') {
    return { action: 'complete', avenNote: `validated by human, ${date}` }
  }
  if (!hasContent(outcome.description)) {
    return {
      action: 'invalid',
      reason: 'fail outcome requires the human’s failure description',
    }
  }
  return {
    action: 'reimplement',
    avenNote: outcome.description.trim(),
    route: '/implement',
    retryBudgetReset: true,
  }
}
