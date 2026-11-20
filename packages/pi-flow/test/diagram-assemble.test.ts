import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderDiagramHtml } from '../flow-diagram/assemble.ts'
import type {
  DiagramHeader,
  DiagramRecord,
  SpawnCallRecord,
} from '../flow-diagram/translate.ts'
import {
  type HpRenderer,
  loadHpRenderer,
} from '../flow-diagram/vendor/harness-profiler/load.ts'

// AIDEV-NOTE: stub mimics hp.js's real contract — renderHtml fills its own
// /*DATA*/null slot internally, so the stub template only carries the fork's
// /*FLOW_HEADER*/null slot, which assemble.ts is responsible for filling.
const FLOW_SLOT = '/*FLOW_HEADER*/null'

function stubRenderer(
  template: string,
  capture: { records?: unknown; id?: string } = {},
): HpRenderer {
  return {
    renderHtml(session) {
      capture.records = session.records
      capture.id = session.id
      return template
    },
  }
}

function headerFixture(): DiagramHeader {
  return {
    ref: 'PMR-DDXC',
    runIndex: 1,
    runCount: 2,
    mode: 'personal',
    phases: [{ phase: 'implement', seconds: 120 }],
    commitsBySubtask: [{ subtask: '3.2', commits: ['abc1234'] }],
    unattributed: [],
    prUrl: 'https://github.com/example/repo/pull/42',
  }
}

function recordsFixture(): DiagramRecord[] {
  const spawn: SpawnCallRecord = {
    v: 2,
    harness: 'pi',
    at: '2026-11-20T00:00:00.000Z',
    session: 'PMR-DDXC run 1',
    agent_id: 'main',
    tool: 'Agent',
    tool_use_id: 'spawn-child-1',
    name: 'worker',
    child_agent_id: 'child-1',
    duration_ms: 5000,
  }
  return [spawn]
}

test('fills the FLOW_HEADER slot with escaped header JSON', () => {
  const capture: { records?: unknown; id?: string } = {}
  const renderer = stubRenderer(
    `<html><script>const FLOW_HEADER = ${FLOW_SLOT};</script></html>`,
    capture,
  )
  const header = headerFixture()
  const html = renderDiagramHtml(renderer, header, recordsFixture(), 'run-1')
  assert.ok(html.includes('const FLOW_HEADER = {"ref":"PMR-DDXC"'))
  assert.ok(html.includes('abc1234'))
  assert.ok(html.includes('github.com/example/repo/pull/42'))
  assert.ok(
    !html.includes(FLOW_SLOT),
    'FLOW_HEADER slot literal must be replaced',
  )
  // escape: no raw `<` inside the injected JSON
  assert.ok(html.includes('\\u003c') || !JSON.stringify(header).includes('<'))
  // renderHtml was called with the exact records and runId
  assert.deepEqual(capture.records, recordsFixture())
  assert.equal(capture.id, 'run-1')
})

test('replacer escapes `<` in user data so script tags cannot be closed', () => {
  const capture: { records?: unknown; id?: string } = {}
  const renderer = stubRenderer(
    `<html>const FLOW_HEADER = ${FLOW_SLOT};</html>`,
    capture,
  )
  const header = headerFixture()
  header.prUrl = 'https://example.com/x?a=1</script><script>alert(1)</script>'
  const html = renderDiagramHtml(renderer, header, [], 'run-1')
  assert.ok(
    !html.includes('</script><script>alert'),
    'raw </script> must not survive inside the slot',
  )
  assert.ok(html.includes('\\u003c/script>'))
})

test('self-containment with the real vendored renderer', () => {
  const renderer = loadHpRenderer()
  assert.ok(renderer, 'vendored renderer should load')
  const html = renderDiagramHtml(
    renderer,
    headerFixture(),
    recordsFixture(),
    'run-1',
  )
  assert.ok(html.includes('PMR-DDXC'))
  assert.ok(html.includes('github.com/example/repo/pull/42'))
  assert.ok(!html.includes(FLOW_SLOT))
  assert.ok(!html.includes('src="http'), 'no external scripts/images')
  assert.ok(
    !html.includes('href="http'),
    'no external links (user-data JSON text only)',
  )
  assert.ok(!html.includes('<script src='), 'no external script tags')
})

test('no-op degradation when the FLOW_HEADER slot is absent', () => {
  const capture: { records?: unknown; id?: string } = {}
  const template = '<html><body>plain page, no fork slot</body></html>'
  const renderer = stubRenderer(template, capture)
  const html = renderDiagramHtml(
    renderer,
    headerFixture(),
    recordsFixture(),
    'run-1',
  )
  assert.equal(html, template)
})
