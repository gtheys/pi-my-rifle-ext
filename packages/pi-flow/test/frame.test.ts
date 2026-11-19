import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ThemeColor } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@mariozechner/pi-tui'
import { frameFlowStatusLines, phaseAccent } from '../flow/frame.ts'

// AIDEV-NOTE (PMR-MGWP): fake theme records which role the frame asked for;
// getFgAnsi returns a recognizable sentinel escape.
function makeFakeTheme(): {
  getFgAnsi(color: ThemeColor): string
  requested: ThemeColor[]
} {
  const requested: ThemeColor[] = []
  return {
    requested,
    getFgAnsi(color: ThemeColor): string {
      requested.push(color)
      return `\x1b[38;5;${color.length}m`
    },
  }
}

describe('phaseAccent', () => {
  it('maps each active phase to a distinct theme role', () => {
    assert.equal(phaseAccent('plan'), 'accent')
    assert.equal(phaseAccent('implement'), 'success')
    assert.equal(phaseAccent('validate'), 'warning')
    assert.equal(phaseAccent('feedback'), 'muted')
  })

  it('falls back to border without a phase', () => {
    assert.equal(phaseAccent(null), 'border')
  })
})

describe('frameFlowStatusLines', () => {
  it('wraps lines in a rounded box at the requested width', () => {
    const theme = makeFakeTheme()
    const framed = frameFlowStatusLines(
      ['flow PMR-ZGPY · work', '[ ] plan (planned)'],
      30,
      theme,
      'plan',
    )
    assert.equal(framed.length, 4)
    const bareBox = framed.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    assert.match(bareBox[0], /^╭─+╮$/)
    assert.match(bareBox[3], /^╰─+╯$/)
    for (const line of framed) {
      assert.equal(visibleWidth(line), 30)
    }
  })

  it('uses the phase accent of the current phase', () => {
    const theme = makeFakeTheme()
    frameFlowStatusLines(['flow X · work'], 20, theme, 'validate')
    assert.equal(theme.requested.length, 1)
    assert.equal(theme.requested[0], 'warning')
  })

  it('indents phase rows and inserts blank separators before block headers', () => {
    const theme = makeFakeTheme()
    const plain = [
      'flow PMR-ZGPY · work',
      '[x] plan (planned)',
      '[ ] implement (active)',
      'subtasks:',
      '  a — running',
      'gates:',
      '  gate one',
    ]
    const framed = frameFlowStatusLines(plain, 40, theme, 'implement')
    const bare = framed.map((l) =>
      l.replace(/\x1b\[[0-9;]*m/g, '').replace(/[│]/g, ''),
    )
    // phase rows indented under the header
    assert.ok(bare[2].trimStart().startsWith('[x]'))
    assert.ok(bare[3].trimStart().startsWith('[ ]'))
    // blank separator rows before subtasks: and gates:
    assert.equal(bare[4].replace(/[│]/g, '').trim(), '')
    assert.equal(bare[7].replace(/[│]/g, '').trim(), '')
    assert.ok(bare[5].trimStart().startsWith('subtasks:'))
    assert.ok(bare[8].trimStart().startsWith('gates:'))
  })

  it('returns lines unframed when width is too small', () => {
    const theme = makeFakeTheme()
    const lines = ['flow X · work']
    assert.deepEqual(frameFlowStatusLines(lines, 2, theme, 'plan'), lines)
  })

  it('truncates overlong rows to the inner width', () => {
    const theme = makeFakeTheme()
    const framed = frameFlowStatusLines(['x'.repeat(50)], 20, theme, 'plan')
    const bare = framed[1].replace(/\x1b\[[0-9;]*m/g, '')
    assert.equal(bare.length, 20)
    assert.equal(bare[0], '│')
    assert.equal(bare[19], '│')
  })
})
