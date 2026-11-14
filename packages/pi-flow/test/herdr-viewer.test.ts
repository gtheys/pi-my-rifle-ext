import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecResult } from '@earendil-works/pi-coding-agent'
import {
  buildViewerOpenEnv,
  FlowHerdrViewer,
  isValidRef,
  parseCurrentPane,
  parseOpenedPane,
  parseViewerPlacement,
  pluginVersionStatus,
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

// --- viewer open env ---

test('buildViewerOpenEnv: passes PI_FLOW_REF, PI_FLOW_RUN_FILE and PI_FLOW_JOURNAL_FILE', () => {
  const env = buildViewerOpenEnv('PMR-TEST', '/tmp/runs/PMR-TEST.json')
  assert.deepEqual(env, [
    '--env',
    'PI_FLOW_REF=PMR-TEST',
    '--env',
    'PI_FLOW_RUN_FILE=/tmp/runs/PMR-TEST.json',
    '--env',
    'PI_FLOW_JOURNAL_FILE=/tmp/runs/PMR-TEST.journal.jsonl',
  ])
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

// --- pluginVersionStatus (PMR-9Q2S 2.2) ---

test('pluginVersionStatus: undefined installed -> not-installed', () => {
  assert.deepEqual(pluginVersionStatus(undefined, '0.9.1'), {
    status: 'not-installed',
  })
})

test('pluginVersionStatus: matching version + enabled -> ok', () => {
  assert.deepEqual(
    pluginVersionStatus({ version: '0.9.1', enabled: true }, '0.9.1'),
    {
      status: 'ok',
    },
  )
})

test('pluginVersionStatus: disabled with matching version -> disabled', () => {
  assert.deepEqual(
    pluginVersionStatus({ version: '0.9.1', enabled: false }, '0.9.1'),
    {
      status: 'disabled',
      installed: '0.9.1',
    },
  )
})

test('pluginVersionStatus: different version while enabled -> drift with both versions', () => {
  assert.deepEqual(
    pluginVersionStatus({ version: '0.7.0', enabled: true }, '0.9.1'),
    { status: 'drift', installed: '0.7.0', expected: '0.9.1' },
  )
})

test('pluginVersionStatus: disabled + different version -> disabled wins', () => {
  assert.deepEqual(
    pluginVersionStatus({ version: '0.7.0', enabled: false }, '0.9.1'),
    {
      status: 'disabled',
      installed: '0.7.0',
    },
  )
})

// --- installedPlugin via fake exec ---

function fakeViewer(
  stdout: string,
  code = 0,
): {
  viewer: FlowHerdrViewer
  calls: Array<{ command: string; args: string[] }>
} {
  const calls: Array<{ command: string; args: string[] }> = []
  const exec = (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    return Promise.resolve({
      code,
      stdout,
      stderr: '',
      killed: false,
      truncated: false,
    })
  }
  return { viewer: new FlowHerdrViewer(exec), calls }
}

const pluginListJson = (version: string, enabled: boolean): string =>
  JSON.stringify({
    result: {
      plugins: [
        {
          plugin_id: 'gtheys.pi-my-rifle-ext',
          plugin_root: '/repo',
          version,
          enabled,
        },
      ],
    },
  })

test('installedPlugin: parses the plugin record from herdr plugin list', async () => {
  const { viewer, calls } = fakeViewer(pluginListJson('0.9.1', true))
  const plugin = await viewer.installedPlugin()
  assert.ok(plugin)
  assert.equal(plugin.version, '0.9.1')
  assert.equal(plugin.enabled, true)
  assert.deepEqual(calls[0].args, [
    'plugin',
    'list',
    '--plugin',
    'gtheys.pi-my-rifle-ext',
    '--json',
  ])
})

test('installedPlugin: herdr failure -> undefined (treated as not-installed)', async () => {
  const { viewer } = fakeViewer('', 1)
  assert.equal(await viewer.installedPlugin(), undefined)
})
