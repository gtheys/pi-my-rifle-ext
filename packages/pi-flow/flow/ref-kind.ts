// AIDEV-NOTE: Shared ref-kind classification (PMR-PCVK). `aven:<ref>` /
// `jira:<key>` prefix forces the kind and is stripped before validation;
// bare refs keep the historical letter-suffix heuristic, where a bare
// `<ALPHA>-<digits>` ref is Jira and anything else is aven. Pure — no pi
// imports — so every phase arg parser and /flow-view can share it.
// AIDEV-NOTE: PMR-F8HB — the bare heuristic misclassifies all-digit aven
// refs (PMR-2424) as Jira because they are shape-identical to Jira keys.
// aven project prefixes registered from `aven project list` (see
// aven/client.ts discoverAvenPrefixes + index.ts init) override the
// heuristic: a bare ref whose alpha prefix is a known aven project prefix
// is aven, never Jira. Unregistered prefixes keep the old heuristic.

export type RefKind =
  | { kind: 'jira'; jiraId: string }
  | { kind: 'aven'; ref: string }

const JIRA_RE = /^([a-zA-Z][a-zA-Z0-9]+)-(\d+)$/

const avenProjectPrefixes = new Set<string>()

/** Register aven project prefixes (e.g. 'PMR') for the bare-ref disambiguation above. */
export function registerAvenPrefixes(prefixes: readonly string[]): void {
  for (const raw of prefixes) {
    const prefix = raw.trim().toUpperCase()
    if (prefix !== '') avenProjectPrefixes.add(prefix)
  }
}

/** Test seam: clear the registry between cases. */
export function clearAvenPrefixes(): void {
  avenProjectPrefixes.clear()
}

export function knownAvenPrefixes(): readonly string[] {
  return [...avenProjectPrefixes]
}

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
    // PMR-F8HB: a Jira-shaped ref whose alpha prefix belongs to a known
    // aven project is an aven ref with an all-digit suffix (PMR-2424).
    if (avenProjectPrefixes.has(match[1].toUpperCase())) {
      return { kind: 'aven', ref: raw }
    }
    return { kind: 'jira', jiraId: `${match[1].toUpperCase()}-${match[2]}` }
  }
  return { kind: 'aven', ref: raw }
}
