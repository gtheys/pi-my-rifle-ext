import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRefKind } from '../flow/ref-kind.ts'

test('parseRefKind: bare jira-shaped ref', () => {
  assert.deepEqual(parseRefKind('DP-71'), { kind: 'jira', jiraId: 'DP-71' })
  assert.deepEqual(parseRefKind('dp-42'), { kind: 'jira', jiraId: 'DP-42' })
})

test('parseRefKind: bare aven ref', () => {
  assert.deepEqual(parseRefKind('PMR-TGJ9'), { kind: 'aven', ref: 'PMR-TGJ9' })
})

test('parseRefKind: aven: prefix forces aven (escape hatch)', () => {
  assert.deepEqual(parseRefKind('aven:DP-71'), { kind: 'aven', ref: 'DP-71' })
  assert.deepEqual(parseRefKind('aven:PMR-TGJ9'), {
    kind: 'aven',
    ref: 'PMR-TGJ9',
  })
})

test('parseRefKind: jira: prefix forces jira (escape hatch)', () => {
  assert.deepEqual(parseRefKind('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
  assert.deepEqual(parseRefKind('jira:dp-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})
