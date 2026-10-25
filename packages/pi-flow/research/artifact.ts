// AIDEV-NOTE: Artifact renderer for the /research phase. Both flows share the
// skeleton; flow 1 gets "Ticket implications", flow 2 gets "Hypothesis chain"
// + "Evidence". Diagrams/flows are embedded as mermaid code fences.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveResearchDir, slugify } from './paths.ts'

// Marker the ticket-research prompt (research/prompt.ts) dictates for
// pure-Jira research — the acli-fallback branch has no aven ref to label,
// so the artifact header carries the completion record instead.
const RESEARCHED_MARKER = /> researched by pi-flow/

// AIDEV-NOTE: /flow label inheritance. Pure-Jira research (acli fallback,
// no aven ref) cannot land the "researched" label; when /flow later pulls in
// the local epic, this finds the prior artifact so the epic can be marked
// without rerunning research. Newest file wins (date-prefixed names).
export async function findResearchedArtifact(
  notesRoot: string | undefined,
  repoName: string,
  gitToplevel: string,
  jiraId: string,
): Promise<string | null> {
  // AIDEV-NOTE: the only caller (/flow Jira pull-in, index.ts) is work-mode
  // only — Jira IDs are rejected in personal repos — so this always resolves
  // against the work branch of resolveResearchDir.
  const dir = resolveResearchDir(
    'work',
    notesRoot,
    undefined,
    repoName,
    gitToplevel,
  )
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const suffix = `-${slugify(jiraId)}.md`
  const candidates = entries.filter((name) => name.endsWith(suffix)).sort()
  for (const name of candidates.reverse()) {
    try {
      const content = await readFile(join(dir, name), 'utf8')
      if (RESEARCHED_MARKER.test(content)) return join(dir, name)
    } catch {
      // unreadable candidate — try the next one
    }
  }
  return null
}

export interface ArtifactInput {
  kind: 'feature' | 'debug'
  title: string
  date: string
  mode: string
  questions: readonly string[]
  findings: readonly string[]
  diagrams: readonly string[]
  ticketImplications?: readonly string[]
  hypothesisChain?: readonly string[]
  evidence?: readonly string[]
}

function bullets(items: readonly string[]): string {
  if (items.length === 0) return '_None yet_'
  return items.map((item) => `- ${item}`).join('\n')
}

export function renderArtifact(input: ArtifactInput): string {
  const lines: string[] = []
  lines.push(`# Research: ${input.title}`)
  lines.push('')
  lines.push(`- Date: ${input.date}`)
  lines.push(`- Flow: ${input.kind}`)
  lines.push(`- Mode: ${input.mode}`)
  lines.push('')
  lines.push('## Questions')
  lines.push('')
  lines.push(bullets(input.questions))
  lines.push('')
  lines.push('## Findings')
  lines.push('')
  lines.push(bullets(input.findings))
  lines.push('')
  if (input.diagrams.length > 0) {
    lines.push('## Diagrams')
    lines.push('')
    for (const diagram of input.diagrams) {
      lines.push(diagram)
      lines.push('')
    }
  }
  if (input.kind === 'feature') {
    lines.push('## Ticket implications')
    lines.push('')
    lines.push(bullets(input.ticketImplications ?? []))
    lines.push('')
  } else {
    lines.push('## Hypothesis chain')
    lines.push('')
    lines.push(bullets(input.hypothesisChain ?? []))
    lines.push('')
    lines.push('## Evidence')
    lines.push('')
    lines.push(bullets(input.evidence ?? []))
    lines.push('')
  }
  return lines.join('\n')
}
