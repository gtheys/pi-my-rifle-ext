// AIDEV-NOTE: Shared phase-state vocabulary for the RPIV flow. Labels must
// exist in aven before first use — ensure-labels in index.ts creates them
// best-effort on session_start.

export const LIFECYCLE_LABELS = [
  'researched',
  'planned',
  'active',
  'review-passed',
  'done',
] as const

export const TYPE_LABELS = ['bug', 'oneshot', 'plan'] as const

// AIDEV-NOTE: research-skipped marks research explicitly skipped by the
// user (--skip-research at /flow or /implement). It is durable skip state:
// gates and the phase resolver treat research as satisfied when it is
// present, so a later /implement never demands the flag again. An aven note
// alone is invisible to the label-based gates.
export const SKIP_LABELS = ['research-skipped'] as const

export const ALL_LABELS: readonly string[] = [
  ...LIFECYCLE_LABELS,
  ...TYPE_LABELS,
  ...SKIP_LABELS,
]
