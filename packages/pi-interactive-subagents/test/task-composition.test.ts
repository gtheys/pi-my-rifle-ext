import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AUTO_EXIT_HINT,
  AUTO_EXIT_SUMMARY_INSTRUCTION,
  composeChildTask,
  DEFAULT_HINT,
  DEFAULT_SUMMARY_INSTRUCTION,
} from '../pi-extension/subagents/task-composition.ts'

// Byte-exactness enforcement point for the wrapper strings (PMR-ECQK): the
// originals these were copied from were removed from index.ts by PMR-ECJK,
// so these asserts ARE the invariant — update them only deliberately.
assert.equal(AUTO_EXIT_HINT, 'Complete your task autonomously.')
assert.equal(
  DEFAULT_HINT,
  'Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.',
)
assert.equal(
  AUTO_EXIT_SUMMARY_INSTRUCTION,
  'Your FINAL assistant message should summarize what you accomplished.',
)
assert.equal(
  DEFAULT_SUMMARY_INSTRUCTION,
  'Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.',
)

test('null identity → flag null, systemPromptIdentity null', () => {
  const r = composeChildTask({
    task: 'do the thing',
    identity: null,
    systemPromptMode: undefined,
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.equal(r.systemPromptIdentity, null)
  assert.equal(r.systemPromptFlag, null)
  assert.ok(r.taskMessage.includes('do the thing'))
})

test('non-fork + identity + explicit replace → --system-prompt', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'You are a scout.',
    systemPromptMode: 'replace',
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.equal(r.systemPromptIdentity, 'You are a scout.')
  assert.equal(r.systemPromptFlag, '--system-prompt')
})

test('explicit append → --append-system-prompt', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: 'append',
    autoExit: false,
    inheritsConversationContext: false,
  })
  assert.equal(r.systemPromptIdentity, 'id')
  assert.equal(r.systemPromptFlag, '--append-system-prompt')
})

test('non-fork, no mode → defaults to --append-system-prompt', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: undefined,
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.equal(r.systemPromptIdentity, 'id')
  assert.equal(r.systemPromptFlag, '--append-system-prompt')
})

test('invalid mode → treated as default append', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: 'bogus' as 'append' | 'replace' | undefined,
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.equal(r.systemPromptFlag, '--append-system-prompt')
})

test('non-fork taskMessage = modeHint + task + summary, no identity, no leading blank lines', () => {
  const r = composeChildTask({
    task: 'the actual task',
    identity: 'SECRET-IDENTITY',
    systemPromptMode: 'append',
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.ok(!r.taskMessage.includes('SECRET-IDENTITY'))
  assert.ok(!r.taskMessage.startsWith('\n\n'))
  assert.equal(
    r.taskMessage,
    'Complete your task autonomously.\n\nthe actual task\n\nYour FINAL assistant message should summarize what you accomplished.',
  )
})

test('non-fork default (non-autoExit) wrapper strings', () => {
  const r = composeChildTask({
    task: 't',
    identity: null,
    systemPromptMode: undefined,
    autoExit: false,
    inheritsConversationContext: false,
  })
  assert.equal(
    r.taskMessage,
    'Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.\n\nt\n\nYour FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.',
  )
})

test('fork → bare task, no wrappers, identity dropped when no mode', () => {
  const r = composeChildTask({
    task: 'bare task',
    identity: 'id',
    systemPromptMode: undefined,
    autoExit: true,
    inheritsConversationContext: true,
  })
  assert.equal(r.taskMessage, 'bare task')
  assert.equal(r.systemPromptIdentity, null)
  assert.equal(r.systemPromptFlag, null)
})

test('fork + explicit replace → identity via --system-prompt flag', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: 'replace',
    autoExit: true,
    inheritsConversationContext: true,
  })
  assert.equal(r.taskMessage, 't')
  assert.equal(r.systemPromptIdentity, 'id')
  assert.equal(r.systemPromptFlag, '--system-prompt')
})

test('fork + explicit append → identity via --append-system-prompt flag', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: 'append',
    autoExit: true,
    inheritsConversationContext: true,
  })
  assert.equal(r.taskMessage, 't')
  assert.equal(r.systemPromptIdentity, 'id')
  assert.equal(r.systemPromptFlag, '--append-system-prompt')
})

test('fork + invalid mode → identity dropped (existing semantics)', () => {
  const r = composeChildTask({
    task: 't',
    identity: 'id',
    systemPromptMode: 'bogus' as 'append' | 'replace' | undefined,
    autoExit: true,
    inheritsConversationContext: true,
  })
  assert.equal(r.systemPromptIdentity, null)
  assert.equal(r.systemPromptFlag, null)
})

test('byte stability: same role inputs, different task → systemPromptIdentity strictly equal', () => {
  const a = composeChildTask({
    task: 'task A with different bytes',
    identity: 'role identity',
    systemPromptMode: 'append',
    autoExit: false,
    inheritsConversationContext: false,
  })
  const b = composeChildTask({
    task: 'task B — totally different content',
    identity: 'role identity',
    systemPromptMode: 'append',
    autoExit: true,
    inheritsConversationContext: false,
  })
  assert.strictEqual(a.systemPromptIdentity, b.systemPromptIdentity)
  assert.strictEqual(a.systemPromptFlag, b.systemPromptFlag)
})

// AIDEV-NOTE: PMR-KTCT acceptance evidence — the stable guidance prefix
// (identity + flag) must be byte-identical across same-role spawns, and the
// task messages may only diverge at the task body itself.
describe('request composition: two same-role spawns with different tasks', () => {
  const IDENTITY = 'You are a worker agent. Follow repo conventions.'
  const TASK_A = 'Fix the flaky retry test in test.ts'
  const TASK_B = 'Document the flow-env module conventions'

  function commonPrefix(a: string, b: string): string {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) {
      i += 1
    }
    return a.slice(0, i)
  }

  const a = composeChildTask({
    task: TASK_A,
    identity: IDENTITY,
    systemPromptMode: undefined,
    autoExit: true,
    inheritsConversationContext: false,
  })
  const b = composeChildTask({
    task: TASK_B,
    identity: IDENTITY,
    systemPromptMode: undefined,
    autoExit: true,
    inheritsConversationContext: false,
  })
  const modeHint = AUTO_EXIT_HINT
  const summaryInstruction = AUTO_EXIT_SUMMARY_INSTRUCTION

  test('systemPromptIdentity strictly equal across spawns', () => {
    assert.strictEqual(a.systemPromptIdentity, IDENTITY)
    assert.strictEqual(b.systemPromptIdentity, IDENTITY)
  })

  test('systemPromptFlag equal across spawns', () => {
    assert.equal(a.systemPromptFlag, '--append-system-prompt')
    assert.equal(b.systemPromptFlag, a.systemPromptFlag)
  })

  test('task messages diverge exactly after modeHint + blank line', () => {
    const expectedPrefix = `${modeHint}\n\n`
    assert.equal(commonPrefix(a.taskMessage, b.taskMessage), expectedPrefix)
  })

  test('stable prefix contains no task text', () => {
    const identity = a.systemPromptIdentity
    assert.ok(identity !== null)
    assert.ok(!identity.includes(TASK_A))
    assert.ok(!identity.includes(TASK_B))
  })

  test('identity appears exactly once across identity + taskMessage', () => {
    const combined = `${IDENTITY}${a.taskMessage}`
    const first = combined.indexOf(IDENTITY)
    assert.equal(first, 0)
    assert.equal(combined.indexOf(IDENTITY, first + 1), -1)
  })

  test('modeHint and summaryInstruction each occur exactly once in taskMessage', () => {
    for (const r of [a, b]) {
      assert.equal(r.taskMessage.split(modeHint).length - 1, 1)
      assert.equal(r.taskMessage.split(summaryInstruction).length - 1, 1)
    }
  })
})
