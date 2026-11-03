// AIDEV-NOTE: Pure /research ticket-ref classification — unit-testable
// without pi. Shared by the /research command and the /flow loop via
// researchPrompt, so a human invocation and a flow-driven one can never
// drift. Same Jira-ID pattern as flow/args.ts (duplication deliberate —
// that file owns /flow parsing, this owns /research targets).
import { MODE_PROFILE } from '../mode-profile.ts'

export type ResearchTarget =
  | { kind: 'topic'; text: string }
  | { kind: 'ticket'; jiraId: string }

const JIRA_ID_RE = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/

export interface ClassifyInput {
  /** 'force': text is a known Jira ID (ID= prefix or /flow jira kind). */
  force: boolean
  /** 'explicit': text came from a bare /research topic argument. */
  explicit: boolean
  mode: 'work' | 'personal'
}

// AIDEV-NOTE: bare jira-shaped refs auto-detect ONLY in work mode — in
// personal repos an aven ref (e.g. PMR-5900) matches the same pattern, so
// bare stays topic there (PMR-PCVK ambiguity). ID= forces the ticket path
// everywhere as the escape hatch. The mode rule is data: mode-profile.ts.
export function classifyResearchTarget(
  text: string,
  opts: ClassifyInput,
): ResearchTarget {
  const trimmed = text.trim()
  if (opts.force) {
    return { kind: 'ticket', jiraId: trimmed.toUpperCase() }
  }
  if (!JIRA_ID_RE.test(trimmed)) {
    return { kind: 'topic', text: trimmed }
  }
  if (opts.explicit && MODE_PROFILE[opts.mode].acceptsJiraRefs) {
    return { kind: 'ticket', jiraId: trimmed.toUpperCase() }
  }
  return { kind: 'topic', text: trimmed }
}
