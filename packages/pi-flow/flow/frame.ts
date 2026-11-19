// AIDEV-NOTE (PMR-MGWP): pure framing helper for the flow-status widget —
// wraps plain status lines in a rounded box (╭─╮ │ │ ╰─╯) modeled on
// boxWidgetLines in pi-interactive-subagents (subagents/index.ts), but the
// frame color comes from the ACTIVE flow phase via Pi theme roles
// (theme.fg), never hardcoded RGB. Byte-shaping of the inner content lives
// HERE (indentation, blank separators), not in flow/status.ts, because
// flow-status.test.ts asserts renderFlowStatusLines output byte-identical.

import type { ThemeColor } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'

/** Minimal structural slice of Theme we rely on — keeps this module pure
 * and unit-testable with a fake. getFgAnsi gives the raw opening SGR
 * sequence, which is what border chrome needs (no reset churn per cell). */
export interface FramingTheme {
  getFgAnsi(color: ThemeColor): string
}

/** Phase → theme role for the frame. No phase (state null / idle) falls back
 * to the normal border token. */
export function phaseAccent(currentPhase: string | null): ThemeColor {
  if (currentPhase === 'plan') return 'accent'
  if (currentPhase === 'implement') return 'success'
  if (currentPhase === 'validate') return 'warning'
  if (currentPhase === 'feedback') return 'muted'
  return 'border'
}

/** Render one inner row: two-space indent (only when there is content),
 * ANSI-aware truncation to the inner width, right-padded to it. */
function frameRow(line: string, indent: string, inner: number): string {
  const indented = indent + line
  const trunc = truncateToWidth(indented, inner)
  const pad = Math.max(0, inner - visibleWidth(trunc))
  return trunc + ' '.repeat(pad)
}

/** Wrap plain status lines in a phase-colored rounded box.
 * Blank separators are inserted before `subtasks:` / `gates:` blocks and
 * phase rows are indented under the header — presentation-only shaping that
 * must NOT leak into flow/status.ts (its output is asserted byte-identical). */
export function frameFlowStatusLines(
  lines: readonly string[],
  width: number,
  theme: FramingTheme,
  currentPhase: string | null,
): string[] {
  if (width <= 2) return [...lines]
  const inner = width - 2
  const open = theme.getFgAnsi(phaseAccent(currentPhase))
  const close = '\x1b[0m'
  const framed: string[] = [`${open}╭${'─'.repeat(inner)}╮${close}`]
  let previous = ''
  for (const line of lines) {
    // Presentation shaping: blank line before each block header.
    if ((line === 'subtasks:' || line === 'gates:') && previous !== '') {
      framed.push(`${open}│${close}${frameRow('', '', inner)}${open}│${close}`)
    }
    // Phase rows (checkbox rows) indent under the header line.
    let indent = ''
    if (line.startsWith('[x] ') || line.startsWith('[ ] ')) {
      indent = '  '
    }
    framed.push(
      `${open}│${close}${frameRow(line, indent, inner)}${open}│${close}`,
    )
    previous = line
  }
  framed.push(`${open}╰${'─'.repeat(inner)}╯${close}`)
  return framed
}
