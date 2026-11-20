// AIDEV-NOTE: single phase-emoji map for BOTH widget surfaces — the frame
// accent prefix (flow/frame.ts stylePhaseRow, PMR-X7BH) and the footer text
// (flow/status.ts renderFooterStatus, PMR-C3B6). This module reconciles the
// two identical copies that existed while PMR-X7BH and PMR-C3B6 landed in
// parallel; add new phases here once. Hardcoded per the no-config decision;
// keyed loosely (Record<string, string>) so neither call site has to import
// run-state types into this leaf module.
export const PHASE_EMOJI: Readonly<Record<string, string>> = {
  plan: '📝',
  implement: '🔨',
  validate: '🔍',
  feedback: '🎁',
}
