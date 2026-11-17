// AIDEV-NOTE: Type declarations for the plain-.mjs herdr plugin pane script
// (PMR-ZGPY 5.3) — lets TS tests import composePaneLabel to pin viewer.ts
// label constants byte-equal to the pane's own labels. Pure helpers only;
// the module's main-guard executes nothing on import.
export function composePaneLabel(
  ref: string,
  mode?: 'live' | 'replay',
): string
export function nextCursor(
  k: number,
  n: number,
  key: string | undefined,
): number
export function shouldEnableKeyloop(stdinIsTty: unknown): boolean
export function replayFooter(k: number, n: number): string
