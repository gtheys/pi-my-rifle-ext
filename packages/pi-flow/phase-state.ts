// AIDEV-NOTE: Shared phase-state vocabulary for the PIV flow (PMR-Z2K7:
// research left the lifecycle — 'researched' and 'research-skipped' were
// removed). Labels must exist in aven before first use — ensure-labels in
// index.ts creates them best-effort on session_start.

export const LIFECYCLE_LABELS = [
  'planned',
  'active',
  'review-passed',
  'done',
] as const

export const TYPE_LABELS = ['bug', 'oneshot', 'plan'] as const

export const ALL_LABELS: readonly string[] = [
  ...LIFECYCLE_LABELS,
  ...TYPE_LABELS,
]
