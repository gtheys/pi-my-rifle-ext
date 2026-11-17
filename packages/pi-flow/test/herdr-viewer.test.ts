import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecResult } from '@earendil-works/pi-coding-agent'
import {
  buildViewerOpenEnv,
  decidePlacement,
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

// --- placement decision (PMR-9Q2S 3.2) ---

test('decidePlacement: explicit arg wins over config', () => {
  assert.deepEqual(decidePlacement('left', 'right'), {
    kind: 'placement',
    placement: 'left',
  })
  assert.deepEqual(decidePlacement('tab', 'below'), {
    kind: 'placement',
    placement: 'tab',
  })
})

test('decidePlacement: configured value used when no arg', () => {
  assert.deepEqual(decidePlacement(undefined, 'above'), {
    kind: 'placement',
    placement: 'above',
  })
})

test('decidePlacement: prompt when neither arg nor config', () => {
  assert.deepEqual(decidePlacement(undefined, undefined), { kind: 'prompt' })
})

test('decidePlacement: arg undefined + config set for every placement', () => {
  for (const placement of VIEWER_PLACEMENTS) {
    assert.deepEqual(decidePlacement(undefined, placement), {
      kind: 'placement',
      placement,
    })
  }
})

// --- PMR-ZGPY 5.3: replay mode plumbing + label-dedupe protection ---

import { composePaneLabel } from '../../../plugins/herdr/flow-viewer.mjs'
import { replayPaneLabel } from '../herdr/viewer.ts'

test('viewerPaneLabel stays byte-identical to composePaneLabel live output', () => {
  assert.equal(viewerPaneLabel('PMR-X'), composePaneLabel('PMR-X'))
  assert.equal(viewerPaneLabel('PMR-X'), 'flow · PMR-X')
})

test('replayPaneLabel matches composePaneLabel replay output and is distinct', () => {
  assert.equal(replayPaneLabel('PMR-X'), composePaneLabel('PMR-X', 'replay'))
  assert.equal(replayPaneLabel('PMR-X'), 'flow · PMR-X · replay')
  assert.notEqual(replayPaneLabel('PMR-X'), viewerPaneLabel('PMR-X'))
})

test('buildViewerOpenEnv: replay mode appends PI_FLOW_VIEWER_MODE=replay', () => {
  const env = buildViewerOpenEnv(
    'PMR-TEST',
    '/tmp/runs/PMR-TEST.json',
    'replay',
  )
  assert.deepEqual(env, [
    '--env',
    'PI_FLOW_REF=PMR-TEST',
    '--env',
    'PI_FLOW_RUN_FILE=/tmp/runs/PMR-TEST.json',
    '--env',
    'PI_FLOW_JOURNAL_FILE=/tmp/runs/PMR-TEST.journal.jsonl',
    '--env',
    'PI_FLOW_VIEWER_MODE=replay',
  ])
})

test('buildViewerOpenEnv: live mode (default) has no PI_FLOW_VIEWER_MODE', () => {
  const env = buildViewerOpenEnv('PMR-TEST', '/tmp/runs/PMR-TEST.json')
  assert.deepEqual(env, [
    '--env',
    'PI_FLOW_REF=PMR-TEST',
    '--env',
    'PI_FLOW_RUN_FILE=/tmp/runs/PMR-TEST.json',
    '--env',
    'PI_FLOW_JOURNAL_FILE=/tmp/runs/PMR-TEST.journal.jsonl',
  ])
  assert.ok(!env.some((arg) => arg.startsWith('PI_FLOW_VIEWER_MODE')))
})

// Scriptable fake exec: dispatches herdr responses by subcommand so open()
// flows (snapshot / current / open / focus) can run end-to-end.
type Call = { command: string; args: string[] }

function scriptedViewer(snapshotPanes: Array<Record<string, unknown>>): {
  viewer: FlowHerdrViewer
  calls: Call[]
} {
  const calls: Call[] = []
  let openedCount = 0
  const exec = (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args })
    let stdout = ''
    if (args.includes('snapshot')) {
      stdout = JSON.stringify({
        result: { snapshot: { panes: snapshotPanes } },
      })
    } else if (args.includes('current')) {
      stdout = JSON.stringify({
        result: {
          pane: {
            pane_id: 'w1:t1:p0',
            tab_id: 'w1:t1',
            workspace_id: 'w1',
            label: 'Pi',
          },
        },
      })
    } else if (args.includes('open')) {
      openedCount += 1
      stdout = JSON.stringify({
        result: {
          plugin_pane: {
            pane: {
              pane_id: `w1:t1:p${openedCount}`,
              tab_id: 'w1:t1',
              workspace_id: 'w1',
            },
          },
        },
      })
    }
    return Promise.resolve({
      code: 0,
      stdout,
      stderr: '',
      killed: false,
      truncated: false,
    })
  }
  return { viewer: new FlowHerdrViewer(exec), calls }
}

const paneWithLabel = (
  paneId: string,
  label: string,
): Record<string, unknown> => ({
  pane_id: paneId,
  tab_id: 'w1:t1',
  workspace_id: 'w1',
  label,
})

function openArgs(calls: Call[]): Call {
  const call = calls.find(
    (c) => c.command === 'herdr' && c.args.includes('open'),
  )
  assert.ok(call, 'expected a herdr plugin pane open call')
  return call
}

test('find: live find never matches a replay-labeled pane (ISC-10)', async () => {
  const { viewer } = scriptedViewer([
    paneWithLabel('w1:t1:p1', 'flow · PMR-X · replay'),
  ])
  const found = await viewer.find('PMR-X', 'live')
  assert.equal(found, undefined)
})

test('find: replay find never matches a live-labeled pane (ISC-10)', async () => {
  const { viewer } = scriptedViewer([paneWithLabel('w1:t1:p1', 'flow · PMR-X')])
  const found = await viewer.find('PMR-X', 'replay')
  assert.equal(found, undefined)
})

test('find: exact label match per mode', async () => {
  const { viewer } = scriptedViewer([
    paneWithLabel('w1:t1:p1', 'flow · PMR-X'),
    paneWithLabel('w1:t1:p2', 'flow · PMR-X · replay'),
  ])
  const live = await viewer.find('PMR-X', 'live')
  const replay = await viewer.find('PMR-X', 'replay')
  const liveDefault = await viewer.find('PMR-X')
  assert.equal(live?.paneId, 'w1:t1:p1')
  assert.equal(liveDefault?.paneId, 'w1:t1:p1')
  assert.equal(replay?.paneId, 'w1:t1:p2')
})

test('open(live): snapshot replay pane is NOT focused; live pane created', async () => {
  const { viewer, calls } = scriptedViewer([
    paneWithLabel('w1:t1:p9', 'flow · PMR-X · replay'),
  ])
  const result = await viewer.open('PMR-X', 'right')
  assert.equal(result.reused, false)
  const openCall = openArgs(calls)
  assert.ok(!openCall.args.some((a) => a.startsWith('PI_FLOW_VIEWER_MODE')))
  assert.ok(!calls.some((c) => c.args.includes('focus')))
})

test('open(replay): snapshot live pane is NOT focused; replay pane created with mode env', async () => {
  const { viewer, calls } = scriptedViewer([
    paneWithLabel('w1:t1:p9', 'flow · PMR-X'),
  ])
  const result = await viewer.open('PMR-X', 'right', 'replay')
  assert.equal(result.reused, false)
  const openCall = openArgs(calls)
  const idx = openCall.args.indexOf('PI_FLOW_VIEWER_MODE=replay')
  assert.ok(idx > 0)
  assert.equal(openCall.args[idx - 1], '--env')
  assert.ok(!calls.some((c) => c.args.includes('focus')))
})

test('open(replay) twice: second open reuses/focuses the replay pane', async () => {
  const { viewer, calls } = scriptedViewer([])
  const first = await viewer.open('PMR-X', 'right', 'replay')
  assert.equal(first.reused, false)
  const second = await viewer.open('PMR-X', 'right', 'replay')
  assert.equal(second.reused, true)
  assert.equal(second.paneId, first.paneId)
  const focusCount = calls.filter((c) => c.args.includes('focus')).length
  assert.equal(focusCount, 1)
})

test('open(live) twice: reuse semantics unchanged from today', async () => {
  const { viewer, calls } = scriptedViewer([])
  const first = await viewer.open('PMR-X', 'right')
  const second = await viewer.open('PMR-X', 'right')
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.paneId, first.paneId)
  const focusCount = calls.filter((c) => c.args.includes('focus')).length
  assert.equal(focusCount, 1)
})
