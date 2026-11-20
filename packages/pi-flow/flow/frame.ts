// AIDEV-NOTE (PMR-MGWP): pure framing helper for the flow-status widget —
// wraps plain status lines in a rounded box (╭─╮ │ │ ╰─╯) modeled on
// boxWidgetLines in pi-interactive-subagents (subagents/index.ts), but the
// frame color comes from the ACTIVE flow phase via Pi theme roles
// (theme.fg), never hardcoded RGB. Byte-shaping of the inner content lives
// HERE (indentation, blank separators, the PMR-X7BH styling pass: ✅ swap
// with 4-col mark-column normalization, per-phase emoji, bold header,
// bold+underline current phase row, italic status words, lazily-accented
// bold running marker, bold subtask names), not in flow/status.ts, because
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
 * ANSI-aware truncation to the inner width, right-padded to it. Styled
 * rows arrive with all SGR attributes already closed, so padding never
 * carries emphasis. */

// AIDEV-NOTE (PMR-X7BH): raw SGR styling constants — narrow resets only,
// never \x1b[0m in content rows (pi-tool-pills/icons.ts precedent). The
// frame border re-opens its color after each row, and frameRow pads AFTER
// these closes, so underlines never bleed into padding.
const BOLD = '\x1b[1m'
const BOLD_RST = '\x1b[22m'
const ITALIC = '\x1b[3m'
const ITALIC_RST = '\x1b[23m'
const UNDERLINE = '\x1b[4m'
const UNDERLINE_RST = '\x1b[24m'
const FG_RST = '\x1b[39m'

const PHASE_ORDER = ['plan', 'implement', 'validate', 'feedback'] as const
const PHASE_EMOJI: Readonly<Record<string, string>> = {
  plan: '📝',
  implement: '🔨',
  validate: '🔍',
  feedback: '🎁',
}

/** Style a `flow <REF> · <mode>` header row: bold. */
function styleHeader(line: string): string {
  return `${BOLD}${line}${BOLD_RST}`
}

/** Style a phase checkbox row (PMR-X7BH): `[x]`→`✅` with the mark column
 * padded to 4 visible cols, per-phase emoji between mark and name, italic
 * `(label)`, accent-bold ` <- running`, and bold+underline for the current
 * phase row. Emphasis is fully closed before returning so frameRow's
 * padding stays plain. */
function stylePhaseRow(
  line: string,
  currentPhase: string | null,
  theme: FramingTheme,
): string {
  const done = line.startsWith('[x] ')
  const rest = line.slice(4) // '[x] ' and '[ ] ' are both 4 chars
  const phase = PHASE_ORDER.find((p) => rest.startsWith(p))
  if (phase === undefined) return line
  const tail = rest.slice(phase.length) // pad spaces + '(label)' + optional ' <- running'
  const runningAt = tail.indexOf(' <- running')
  let padLabel = tail
  let running = ''
  if (runningAt !== -1) {
    padLabel = tail.slice(0, runningAt)
    running = tail.slice(runningAt)
  }
  const parenAt = padLabel.indexOf('(')
  if (parenAt === -1) return line
  const pad = padLabel.slice(0, parenAt)
  const label = padLabel.slice(parenAt) // '(planned)' etc.
  // Mark-column normalization: '✅' is 2 visible cols vs '[x]'/'[ ]' 3 —
  // pad done marks with one extra space so the emoji column stays aligned.
  let mark = '[ ] '
  if (done) mark = '✅  ' // 2-col emoji + 2 spaces = 4 visible cols
  let emojiPrefix = ''
  if (PHASE_EMOJI[phase] !== undefined) emojiPrefix = `${PHASE_EMOJI[phase]} `
  // Lazy accent: only ask the theme when a running row is actually styled
  // (frame.test.ts asserts requested.length === 1 without a runner).
  let runningPart = ''
  if (running !== '') {
    runningPart = ` ${theme.getFgAnsi('accent')}${BOLD}${running.slice(1)}${BOLD_RST}${FG_RST}`
  }
  const body = `${mark}${emojiPrefix}${phase}${pad}${ITALIC}${label}${ITALIC_RST}${runningPart}`
  if (phase !== currentPhase) return body
  // Whole current row bold+underlined; closes emit BEFORE frameRow pads.
  return `${BOLD}${UNDERLINE}${body}${UNDERLINE_RST}${BOLD_RST}`
}

/** Dispatch a raw status line to its styling. Gates rows and block headers
 * pass through unchanged (PMR-X7BH). */
function styleContentLine(
  line: string,
  currentPhase: string | null,
  theme: FramingTheme,
  block: 'subtasks' | 'gates' | null,
): string {
  if (line.startsWith('flow ')) return styleHeader(line)
  if (line.startsWith('[x] ') || line.startsWith('[ ] ')) {
    return stylePhaseRow(line, currentPhase, theme)
  }
  if (block === 'subtasks' && line.startsWith('  ')) {
    const idx = line.indexOf(' — ')
    if (idx > 2) {
      return `  ${BOLD}${line.slice(2, idx)}${BOLD_RST}${line.slice(idx)}`
    }
  }
  return line
}
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
  // Track which block we are in so subtask names can be bolded (PMR-X7BH).
  let block: 'subtasks' | 'gates' | null = null
  for (const line of lines) {
    // Presentation shaping: blank line before each block header.
    if ((line === 'subtasks:' || line === 'gates:') && previous !== '') {
      framed.push(`${open}│${close}${frameRow('', '', inner)}${open}│${close}`)
    }
    if (line === 'subtasks:') block = 'subtasks'
    else if (line === 'gates:') block = 'gates'
    // Phase rows (checkbox rows) indent under the header line — indent is
    // keyed on the RAW status.ts vocabulary, before styling.
    let indent = ''
    if (line.startsWith('[x] ') || line.startsWith('[ ] ')) {
      indent = '  '
    }
    framed.push(
      `${open}│${close}${frameRow(styleContentLine(line, currentPhase, theme, block), indent, inner)}${open}│${close}`,
    )
    previous = line
  }
  framed.push(`${open}╰${'─'.repeat(inner)}╯${close}`)
  return framed
}
