import type { DiagramHeader, DiagramRecord } from './translate.ts'
import type { HpRenderer } from './vendor/harness-profiler/load.ts'

// AIDEV-NOTE: the fork's view.html carries a second data slot next to hp.js's
// /*DATA*/null (see PIN.md). hp.js's renderHtml already fills /*DATA*/null
// before returning, so this module owns ONLY the FLOW_HEADER slot. String.replace
// with a bare string replacement arg interprets `$&`-style patterns in the
// replacement — a replacer callback makes the JSON insert literal, matching
// hp.js's own `template.replace(DATA_SLOT, () => json)` technique.
const FLOW_HEADER_SLOT = '/*FLOW_HEADER*/null'

/**
 * Pure assembler: renders the diagram via the given renderer and splices the
 * ticket header JSON into the FLOW_HEADER slot. No fs, no Pi runtime imports.
 */
export function renderDiagramHtml(
  renderer: HpRenderer,
  header: DiagramHeader,
  records: readonly DiagramRecord[],
  runId: string,
): string {
  const template = renderer.renderHtml({ id: runId, records })
  // `<` is escaped so user data (e.g. a crafted PR url) cannot close the
  // surrounding <script> tag — same technique as hp.js's DATA slot.
  const json = JSON.stringify(header).replace(/</g, () => '\\u003c')
  return template.replace(FLOW_HEADER_SLOT, () => json)
}
