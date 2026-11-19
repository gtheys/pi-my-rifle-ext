// AIDEV-NOTE: Artifact renderer for the /brainstorm phase. Both flows share
// the skeleton; flow 1 gets "Ticket implications", flow 2 gets "Hypothesis
// chain" + "Evidence". Diagrams/flows are embedded as mermaid code fences.
// AIDEV-NOTE (PMR-85RV): the former findBrainstormArtifact + its
// "> brainstormed by pi-flow" marker are gone. The /flow pull-in caller was
// removed in PMR-Z2K7, so the rediscovery contract had no production reader
// left; the prompt no longer promises discovery nothing implements.

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
  lines.push(`# Brainstorm: ${input.title}`)
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
