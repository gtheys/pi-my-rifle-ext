// AIDEV-NOTE: Shared ref-kind classification (PMR-PCVK). `aven:<ref>` /
// `jira:<key>` prefix forces the kind and is stripped before validation;
// bare refs keep the historical letter-suffix heuristic, where a bare
// `<ALPHA>-<digits>` ref is Jira and anything else is aven. Pure — no pi
// imports — so every phase arg parser and /flow-view can share it.

export type RefKind =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }

const JIRA_RE = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/

export function parseRefKind(raw: string): RefKind {
  if (raw.startsWith('aven:')) {
    return { kind: 'aven', ref: raw.slice('aven:'.length) }
  }
  if (raw.startsWith('jira:')) {
    const key = raw.slice('jira:'.length)
    const match = JIRA_RE.exec(key)
    if (match) {
      return { kind: 'jira', jiraId: `${match[1].toUpperCase()}-${match[2]}` }
    }
    return { kind: 'jira', jiraId: key.toUpperCase() }
  }
  const match = JIRA_RE.exec(raw)
  if (match) {
    return { kind: 'jira', jiraId: `${match[1].toUpperCase()}-${match[2]}` }
  }
  return { kind: 'aven', ref: raw }
}
