// AIDEV-NOTE: Machine-readable verdict contract appended to every /review
// review artifact (PMR-5PCB). Canonical wording lives in pi-flow's
// validate/review-gate.ts (REVIEW_CONTRACT_PROMPT); duplicated here because
// the packages are independently installable — never reword one side without
// the other. parseReviewArtifact in pi-flow scopes parsing to the
// "## Verdict" section, so the section must keep this exact heading.
export const REVIEW_VERDICT_INSTRUCTIONS = `7. End the review with a machine-readable verdict section:
   ## Verdict
   blockers_count: <N>
   - blocker: <description> (omit this line entirely when N is 0)
   where N is the number of must-fix (P0/P1) findings, 0 when clean.`
