// AIDEV-NOTE: Machine-readable verdict contract appended to every /review
// review artifact (PMR-5PCB). Since PMR-W8SG both sides live in pi-flow:
// validate/review-gate.ts owns the contract wording (VERDICT_HEADING,
// BLOCKER_LINE, REVIEW_CONTRACT_PROMPT) and parses the artifact; this module
// only composes the emitter instructions from those shared constants. Never
// reword the contract here — change review-gate.ts.
import { BLOCKER_LINE, VERDICT_HEADING } from '../validate/review-gate.ts'

export const REVIEW_VERDICT_INSTRUCTIONS = `7. End the review with a machine-readable verdict section:
   ${VERDICT_HEADING}
   blockers_count: <N>
${BLOCKER_LINE}
   where N is the number of must-fix (P0/P1) findings, 0 when clean.`
