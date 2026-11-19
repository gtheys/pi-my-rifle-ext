import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ThemeColor } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@mariozechner/pi-tui'
import { frameFlowStatusLines, phaseAccent } from '../flow/frame.ts'
import type { OpenGate } from '../flow/gates.ts'
import { renderFlowStatusLines } from '../flow/status.ts'
import type { FlowRunState } from '../run-state.ts'

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

  // AIDEV-NOTE (PMR-CT52): pins the vocabulary contract between
  // flow/status.ts and flow/frame.ts — frame.ts keys its shaping on the
  // exact literals 'subtasks:', 'gates:', '[x] '/'[ ] ' from
  // renderFlowStatusLines. Both sides are unit-tested in isolation, so a
  // wording change in status.ts would otherwise silently drop the blank
  // separators / indentation (cosmetic-only regression). If this test
  // fails, update the frame.ts matchers together with the status.ts
  // wording.
  it('shapes real renderFlowStatusLines output: headers and checkbox rows', () => {
    const state: FlowRunState = {
      schema: 'gtheys.pi-flow.run.v1',
      ref: 'PMR-ZGPY',
      mode: 'work',
      startedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
      completedPhases: ['plan'],
      currentPhase: 'implement',
      notes: [],
    }
    const gate: OpenGate = {
      ref: 'PMR-ZGPY',
      kind: 'flow-paused',
      title: 'PMR-ZGPY — flow run paused',
    }
    const lines = renderFlowStatusLines({
      state,
      subtasks: [{ name: 'worker-a', status: 'completed' }],
      gates: [gate],
    })
    // Fixture sanity: the vocabulary frame.ts keys on is actually present,
    // so this test cannot pass vacuously if status.ts stops emitting
    // subtasks/gates blocks or completed/pending rows.
    assert.ok(lines.includes('subtasks:'))
    assert.ok(lines.includes('gates:'))
    assert.ok(lines.some((l) => l.startsWith('[x] ')))
    assert.ok(lines.some((l) => l.startsWith('[ ] ')))

    const theme = makeFakeTheme()
    const framed = frameFlowStatusLines(lines, 60, theme, 'implement')
    // Strip ANSI + border chrome; trimEnd drops the right-padding so each
    // entry is the bare content of one framed row.
    const content = framed.map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, '')
        .slice(1, -1)
        .trimEnd(),
    )

    // Blank separator row directly above each block header (drift-proof:
    // the sentinel is looked up in the REAL rendered lines, not hand-written).
    for (const header of ['subtasks:', 'gates:']) {
      const idx = content.findIndex((c) => c === header)
      assert.ok(idx > 0, `${header} header missing from framed output`)
      assert.equal(
        content[idx - 1],
        '',
        `blank separator row missing before ${header}`,
      )
    }
    // Every checkbox row indents two spaces under its block header.
    for (const line of lines) {
      if (line.startsWith('[x] ') || line.startsWith('[ ] ')) {
        assert.ok(
          content.includes(`  ${line}`),
          `checkbox row not indented in frame: ${line}`,
        )
      }
    }
  })
})
