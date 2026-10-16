// AIDEV-NOTE: Artifact renderer for the /research phase. Both flows share the
// skeleton; flow 1 gets "Ticket implications", flow 2 gets "Hypothesis chain"
// + "Evidence". Diagrams/flows are embedded as mermaid code fences.

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
