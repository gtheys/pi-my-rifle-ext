import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import { parseHerdrStatus, runHerdr } from '../pi-extension/subagents/herdr.ts'
import { herdrPaneAlive } from '../pi-extension/subagents/spawn.ts'
import { installMockHerdr, type MockHerdr } from './mock-herdr.ts'

// AIDEV-NOTE: unit tests for the mock-herdr PATH shim fixture (PMR-X8MS).
// Each shim invocation is a fresh process, so these also prove state
// persistence across processes via the shim's state file.
describe('mock-herdr shim', () => {
  let mock: MockHerdr
  let savedPath: string | undefined

  before(() => {
    mock = installMockHerdr()
    savedPath = process.env.PATH
    process.env.PATH = `${mock.binDir}:${savedPath ?? ''}`
  })

  after(() => {
    process.env.PATH = savedPath
    mock.dispose()
  })

  it('answers --version and status --json above the version gate', () => {
    assert.match(runHerdr(['--version']), /^herdr 0\.\d+\.\d+/)
    const status = parseHerdrStatus(runHerdr(['status', '--json']))
    assert.equal(status.server?.running, true)
    assert.ok(status.server?.version)
  })

  it('persists tabs and panes across processes', () => {
    const raw = mock.run([
      'tab',
      'create',
      '--workspace',
      'w1',
      '--cwd',
      '/tmp',
      '--label',
      'test-tab',
      '--no-focus',
    ])
    const created = JSON.parse(raw) as {
      result: {
        root_pane: { pane_id: string }
        tab: { tab_id: string }
      }
    }
    const paneId = created.result.root_pane.pane_id
    const tabId = created.result.tab.tab_id
    assert.ok(paneId)
    assert.ok(tabId)

    // Fresh process: pane get + tab list still see the created tab/pane.
    assert.equal(herdrPaneAlive(paneId), true)
    const listRaw = mock.run(['tab', 'list', '--workspace', 'w1'])
    const list = JSON.parse(listRaw) as { result: { tabs: string[] } }
    assert.deepEqual(
      list.result.tabs.map((t) => t.tab_id),
      [tabId],
    )
  })

  it('pane get on a missing pane exits 1 (herdrPaneAlive false)', () => {
    assert.equal(herdrPaneAlive('w99:t99:p99'), false)
  })

  it('pane run appends output to the pane log and pane read returns it', () => {
    const created = JSON.parse(
      mock.run([
        'tab',
        'create',
        '--workspace',
        'w1',
        '--cwd',
        '/tmp',
        '--label',
        'read-tab',
        '--no-focus',
      ]),
    ) as { result: { root_pane: { pane_id: string } } }
    const paneId = created.result.root_pane.pane_id

    mock.run(['pane', 'run', paneId, 'echo', 'hello-mock'])
    const output = runHerdr([
      'pane',
      'read',
      paneId,
      '--source',
      'recent',
      '--lines',
      '10',
    ])
    assert.match(output, /hello-mock/)
  })

  it('wait-output matches after pane run', () => {
    const created = JSON.parse(
      mock.run([
        'tab',
        'create',
        '--workspace',
        'w1',
        '--cwd',
        '/tmp',
        '--label',
        'wait-tab',
        '--no-focus',
      ]),
    ) as { result: { root_pane: { pane_id: string } } }
    const paneId = created.result.root_pane.pane_id

    mock.run(['pane', 'run', paneId, 'echo', 'marker-xyz'])
    const raw = mock.run([
      'pane',
      'wait-output',
      '--regex',
      '^marker-xyz$',
      paneId,
      '--timeout',
      '2000',
    ])
    const result = JSON.parse(raw) as {
      result: { matched_line: string; pane_id: string }
    }
    assert.equal(result.result.matched_line, 'marker-xyz')
    assert.equal(result.result.pane_id, paneId)
  })

  it('wait-output times out with nonzero exit', () => {
    const created = JSON.parse(
      mock.run([
        'tab',
        'create',
        '--workspace',
        'w1',
        '--cwd',
        '/tmp',
        '--label',
        'timeout-tab',
        '--no-focus',
      ]),
    ) as { result: { root_pane: { pane_id: string } } }
    const paneId = created.result.root_pane.pane_id

    assert.throws(
      () =>
        execFileSync(mock.shimPath, [
          'pane',
          'wait-output',
          '--regex',
          'never-appears',
          paneId,
          '--timeout',
          '150',
        ]),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /timeout/)
        return true
      },
    )
  })

  it('registers agents across processes (start/list/get)', () => {
    const created = JSON.parse(
      mock.run([
        'tab',
        'create',
        '--workspace',
        'w1',
        '--cwd',
        '/tmp',
        '--label',
        'agent-tab',
        '--no-focus',
      ]),
    ) as { result: { root_pane: { pane_id: string }; tab: { tab_id: string } } }
    const paneId = created.result.root_pane.pane_id
    const tabId = created.result.tab.tab_id

    mock.run([
      'agent',
      'start',
      'worker',
      '--kind',
      'pi',
      '--pane',
      paneId,
      '--timeout',
      '1000',
      '--',
      'pi',
      'hello',
    ])

    // Fresh process: agent list and agent get see the registration.
    const list = JSON.parse(mock.run(['agent', 'list'])) as {
      result: { agents: Array<{ agent: string; pane_id: string }> }
    }
    assert.equal(list.result.agents.length, 1)
    assert.equal(list.result.agents[0]?.agent, 'worker')
    assert.equal(list.result.agents[0]?.pane_id, paneId)

    const got = JSON.parse(mock.run(['agent', 'get', 'worker'])) as {
      result: { agent: { agent: string; tab_id: string } | null }
    }
    assert.equal(got.result.agent?.tab_id, tabId)

    // agent read returns the pane log raw text.
    mock.run(['pane', 'send-text', paneId, 'typed line'])
    mock.run(['pane', 'send-keys', paneId, 'return'])
    const read = runHerdr([
      'agent',
      'read',
      'worker',
      '--source',
      'recent-unwrapped',
      '--format',
      'text',
    ])
    assert.match(read, /typed line/)
  })

  it('agent get on unknown target returns null agent (exit 0)', () => {
    const got = JSON.parse(mock.run(['agent', 'get', 'nope'])) as {
      result: { agent: unknown }
    }
    assert.equal(got.result.agent, null)
  })

  it('focus verbs and pane/tab/agent close succeed', () => {
    mock.run(['workspace', 'focus', 'w1'])
    mock.run(['tab', 'focus', 't1'])
    const layoutRaw = mock.run(['pane', 'layout', '--pane', 't1:p1'])
    const layout = JSON.parse(layoutRaw) as { result: { pane_id: string } }
    assert.equal(layout.result.pane_id, 't1:p1')

    const created = JSON.parse(
      mock.run([
        'tab',
        'create',
        '--workspace',
        'w1',
        '--cwd',
        '/tmp',
        '--label',
        'close-tab',
        '--no-focus',
      ]),
    ) as { result: { root_pane: { pane_id: string }; tab: { tab_id: string } } }
    runHerdr(['pane', 'close', created.result.root_pane.pane_id])
    assert.equal(herdrPaneAlive(created.result.root_pane.pane_id), false)
    runHerdr(['tab', 'close', created.result.tab.tab_id])
  })

  it('pane list returns all panes', () => {
    const list = JSON.parse(mock.run(['pane', 'list'])) as {
      result: { panes: Array<{ pane_id: string }> }
    }
    assert.ok(list.result.panes.length >= 1)
  })
})
