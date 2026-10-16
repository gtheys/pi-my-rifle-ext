// AIDEV-NOTE: Size-check heuristic for the personal /plan flow. PURE so it is
// unit-testable; the agent asks the human to confirm the split before acting
// on the verdict (never auto-decompose). Heuristic: keyword signals for
// data-model, cross-package, and multi-step test implications → 'plan';
// no signals → 'oneshot' (single-file / one-module change assumption).

export interface TicketInfo {
  title: string
  description: string
}

export interface SizeVerdict {
  size: 'oneshot' | 'plan'
  reasons: readonly string[]
}

const SIGNALS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\bmigration|schema|data[ -]?model|database|table\b/i,
    reason: 'touches the data model (migration/schema implications)',
  },
  {
    pattern:
      /\bcross[ -]?package|across packages|multiple packages|several packages\b/i,
    reason: 'cross-package change (more than one package affected)',
  },
  {
    pattern:
      /\bintegration tests?|e2e tests?|several suites|multiple suites\b/i,
    reason: 'multi-step test implications (integration/E2E or several suites)',
  },
]

export function classifySize(info: TicketInfo): SizeVerdict {
  const text = `${info.title}\n${info.description}`
  const reasons: string[] = []
  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) {
      reasons.push(signal.reason)
    }
  }
  if (reasons.length > 0) {
    return { size: 'plan', reasons }
  }
  return { size: 'oneshot', reasons: [] }
}
