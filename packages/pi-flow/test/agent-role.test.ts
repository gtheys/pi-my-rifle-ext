import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { agentRole, ORCHESTRATOR_ROLE } from '../flow/agent-role.ts'
import { buildPushBody, buildWorkerRows } from '../flow/cost.ts'
import { recordRunEventJournalOnly, runStatePath } from '../run-state.ts'
import { flowAttributes } from '../telemetry/attributes.ts'
import { sessionSpanName } from '../telemetry/index.ts'

test('agentRole: type wins, else name before colon, else worker; lowercased and capped', () => {
  assert.equal(agentRole('Scout', 'Explore the auth module'), 'scout')
  assert.equal(agentRole(undefined, "Review: changes against 'abc'"), 'review')
  assert.equal(agentRole('', 'Deviation check: TP-1'), 'deviation check')
  assert.equal(agentRole(null, null), 'worker')
  assert.equal(agentRole(undefined, ''), 'worker')
  assert.equal(agentRole(undefined, 'x'.repeat(80)).length, 40)
  assert.equal(ORCHESTRATOR_ROLE, 'orchestrator')
})

test('flowAttributes maps PI_SUBAGENT_AGENT to agent.type', () => {
  assert.deepEqual(
    flowAttributes({ PI_SUBAGENT_NAME: 'n', PI_SUBAGENT_AGENT: 'scout' }),
    { 'agent.name': 'n', 'agent.type': 'scout' },
  )
  assert.deepEqual(flowAttributes({ PI_SUBAGENT_NAME: 'n' }), {
    'agent.name': 'n',
  })
})

test('sessionSpanName prefers agent.type over the free-text name', () => {
  assert.equal(
    sessionSpanName({
      'flow.ref': 'PMR-1',
      'agent.type': 'scout',
      'agent.name': 'Explore the auth module and report',
    }),
    'PMR-1 - scout',
  )
  assert.equal(
    sessionSpanName({ 'flow.ref': 'PMR-1', 'agent.name': 'Review: x' }),
    'PMR-1 - review',
  )
})

const SESSION = `${JSON.stringify({
  type: 'message',
  message: {
    role: 'assistant',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
    },
  },
})}\n`

test('worker rows take their role from the assignment record agent type; push body has one role_info per session', () => {
  const entries = SESSION.trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const rows = buildWorkerRows(
    [
      {
        childId: 'c1',
        name: 'Explore the auth module',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s1.jsonl',
        at: '',
        phase: 'plan' as const,
      },
      {
        childId: 'c2',
        name: 'Review: changes',
        kind: 'spawn' as const,
        subtask: null,
        sessionFile: '/s2.jsonl',
        at: '',
        phase: 'validate' as const,
      },
    ],
    [{ childId: 'c1', agent: 'scout', sessionFile: '/s1.jsonl' } as never],
    new Map([
      ['/s1.jsonl', entries],
      ['/s2.jsonl', entries],
    ]),
  )
  const roles = new Map(rows.map((r) => [r.childId, r.role]))
  assert.equal(roles.get('c1'), 'scout')
  assert.equal(roles.get('c2'), 'review')
  const body = buildPushBody('PMR-R', rows, [])
  const info = body
    .split('\n')
    .filter((l) => l.startsWith('pi_flow_run_role_info{'))
  assert.equal(info.length, 2)
  assert.ok(
    info.includes(
      'pi_flow_run_role_info{ref="PMR-R",session="c1",role="scout"} 1',
    ),
  )
  // existing series keep their original label sets (no role label added)
  assert.match(
    body,
    /pi_flow_run_cost_usd\{ref="PMR-R",phase="plan",agent="Explore the auth module",subtask="",session="c1"\}/,
  )
})

test('recordRunEventJournalOnly appends to the journal and never creates or touches the projection', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-flow-jo-'))
  try {
    const statePath = runStatePath(dir, 'PMR-N')
    assert.ok(statePath !== null)
    const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
    await recordRunEventJournalOnly(dir, {
      kind: 'note',
      at: '2026-11-07T07:00:00.000Z',
      ref: 'PMR-N',
      text: 'subagent c9 ("scout") spawn — attribution env stamped',
    })
    await recordRunEventJournalOnly(dir, {
      kind: 'note',
      at: '2026-11-07T07:00:01.000Z',
      ref: 'PMR-N',
      text: 'second',
    })
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).ref, 'PMR-N')
    assert.equal(existsSync(statePath), false)
    // invalid ref: silently ignored (never builds a path outside runs/)
    await recordRunEventJournalOnly(dir, {
      kind: 'note',
      at: 'x',
      ref: '../evil',
      text: 'x',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawnJournalTarget: loop owner uses the full path; a worker journals nested spawns via PI_FLOW_REF; non-flow ignores', async () => {
  const { spawnJournalTarget } = await import('../flow/attribution.ts')
  assert.deepEqual(spawnJournalTarget('PMR-1', {}), {
    ref: 'PMR-1',
    nested: false,
  })
  assert.deepEqual(spawnJournalTarget('PMR-1', { PI_FLOW_REF: 'PMR-2' }), {
    ref: 'PMR-1',
    nested: false,
  })
  assert.deepEqual(spawnJournalTarget(null, { PI_FLOW_REF: 'PMR-2' }), {
    ref: 'PMR-2',
    nested: true,
  })
  assert.equal(spawnJournalTarget(null, {}), null)
  assert.equal(spawnJournalTarget(null, { PI_FLOW_REF: '' }), null)
})
