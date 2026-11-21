import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUTO_EXIT_HINT,
  AUTO_EXIT_SUMMARY_INSTRUCTION,
  composeChildTask,
  DEFAULT_HINT,
  DEFAULT_SUMMARY_INSTRUCTION,
} from '../pi-extension/subagents/task-composition.ts'

// Wrapper strings must stay byte-identical to index.ts constants.
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
