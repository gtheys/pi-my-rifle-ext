import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isValidRef,
  parseCurrentPane,
  parseOpenedPane,
  parseViewerPlacement,
  snapshotPanes,
  VIEWER_PLACEMENTS,
  viewerPaneLabel,
} from '../herdr/viewer.ts'

// --- placement parsing ---

test('parseViewerPlacement: all placements', () => {
  for (const placement of VIEWER_PLACEMENTS) {
    assert.equal(parseViewerPlacement(placement), placement)
  }
  assert.equal(parseViewerPlacement('diagonal'), undefined)
  assert.equal(parseViewerPlacement(''), undefined)
})

// --- ref validation + labels ---

test('isValidRef: ticket-like refs pass, traversal fails', () => {
  assert.equal(isValidRef('PMR-ABC123'), true)
  assert.equal(isValidRef('DP-71'), true)
  assert.equal(isValidRef('../etc/passwd'), false)
  assert.equal(isValidRef('a b'), false)
  assert.equal(isValidRef(''), false)
})

test('viewerPaneLabel: prefix + ref', () => {
  assert.equal(viewerPaneLabel('PMR-1'), 'flow · PMR-1')
})

// --- herdr JSON parsers (fail closed on junk) ---

test('parseCurrentPane: valid envelope', () => {
  const pane = parseCurrentPane({
    result: {
      pane: {
        pane_id: 'w1:t1:p1',
        tab_id: 'w1:t1',
        workspace_id: 'w1',
        label: 'Pi',
      },
    },
  })
  assert.equal(pane.paneId, 'w1:t1:p1')
  assert.equal(pane.label, 'Pi')
})

test('parseCurrentPane: missing pane throws', () => {
  assert.throws(() => parseCurrentPane({ result: {} }))
  assert.throws(() => parseCurrentPane('nope'))
})

test('parseOpenedPane: valid plugin pane response', () => {
  const opened = parseOpenedPane({
    result: {
      plugin_pane: {
        pane: { pane_id: 'w1:t1:p2', tab_id: 'w1:t1', workspace_id: 'w1' },
      },
    },
  })
  assert.equal(opened.paneId, 'w1:t1:p2')
})

test('parseOpenedPane: malformed throws', () => {
  assert.throws(() => parseOpenedPane({ result: { pane: {} } }))
})

test('snapshotPanes: finds viewer panes by label, tolerates junk entries', () => {
  const panes = snapshotPanes({
    result: {
      snapshot: {
        panes: [
          {
            pane_id: 'w1:t1:p1',
            tab_id: 'w1:t1',
            workspace_id: 'w1',
            label: 'flow · PMR-1',
          },
          {
            pane_id: 'w1:t1:p2',
            tab_id: 'w1:t1',
            workspace_id: 'w1',
            label: 'Pi',
          },
          { broken: true },
        ],
      },
    },
  })
  assert.equal(panes.length, 2)
  const viewer = panes.find((p) => p.label === viewerPaneLabel('PMR-1'))
  assert.ok(viewer)
  assert.equal(viewer.paneId, 'w1:t1:p1')
})

test('snapshotPanes: no panes key throws', () => {
  assert.throws(() => snapshotPanes({ result: { snapshot: {} } }))
})
