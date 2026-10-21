// AIDEV-NOTE: review-prompt builder for /spec-review (PMR-MR36). Pure
// module. The injected message makes the SESSION the reviewer: it loads the
// feature-plan-aven review-stage behavior, reads each plan.md fully, fixes
// the spec in place in one go, and may only transition a spec via the
// user's explicit "approve <REF>" — which runs the approveSpec aven edit
// and then /spec-publish. Never approve without that explicit word.

import type { PickedSpec } from './picker.ts'

export function buildReviewPrompt(picked: PickedSpec[]): string {
  const lines: string[] = []
  lines.push(
    'You are the spec reviewer for the following specs awaiting review.',
  )
  lines.push('')
  lines.push(
    'First, read the review-stage behavior of the feature-plan-aven skill:',
  )
  lines.push('skills/engineering/feature-plan-aven/SKILL.md')
  lines.push('')
  lines.push('Specs to review:')
  for (const spec of picked) {
    lines.push(`- ${spec.ref} — ${spec.title} (plan: ${spec.planPath})`)
  }
  lines.push('')
  lines.push('For each spec above:')
  lines.push(`1. Read its plan.md fully.`)
  lines.push(
    '2. Follow the feature-plan-aven review-stage behavior: verify the spec',
  )
  lines.push(
    '   against the codebase, and fix issues in the spec IN PLACE, all in',
  )
  lines.push('   one go. Do not wait for per-spec approval.')
  lines.push('3. Report what you checked and what you changed.')
  lines.push('')
  lines.push('Approval is explicit and manual:')
  lines.push(
    `- ONLY when the user explicitly says "approve <REF>" (for example`,
  )
  lines.push(`  "approve ${picked[0]?.ref ?? '<REF>'}"), run:`)
  lines.push(
    `    aven edit <REF> --metadata plan-state=approved --label plan --status todo`,
  )
  lines.push(`  and then run /spec-publish <REF>.`)
  lines.push(
    '- NEVER approve a spec without that explicit word, and never approve',
  )
  lines.push('  more than the ref the user named.')
  return lines.join('\n')
}
