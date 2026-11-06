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

// --- PMR-F8HB: aven project prefixes disambiguate Jira-shaped aven refs ---

import {
  clearAvenPrefixes,
  knownAvenPrefixes,
  registerAvenPrefixes,
} from '../flow/ref-kind.ts'

test('parseRefKind: registered aven prefix wins over the Jira shape', () => {
  clearAvenPrefixes()
  registerAvenPrefixes(['PMR', 'mnt'])
  // PMR-2424: all-digit suffix, Jira-shaped — the exact /flow PMR-2424 bug.
  assert.deepEqual(parseRefKind('PMR-2424'), { kind: 'aven', ref: 'PMR-2424' })
  // An unregistered prefix keeps the Jira heuristic (backward compatible).
  assert.deepEqual(parseRefKind('DP-71'), { kind: 'jira', jiraId: 'DP-71' })
  // Registration normalizes case; the original ref string passes through.
  assert.ok(knownAvenPrefixes().includes('MNT'))
  assert.deepEqual(parseRefKind('MNT-150'), { kind: 'aven', ref: 'MNT-150' })
  // Explicit prefixes still force the kind regardless of the registry.
  assert.deepEqual(parseRefKind('jira:PMR-2424'), {
    kind: 'jira',
    jiraId: 'PMR-2424',
  })
  assert.deepEqual(parseRefKind('aven:DP-71'), { kind: 'aven', ref: 'DP-71' })
  clearAvenPrefixes()
})

test('parseRefKind: registry cleared falls back to the Jira heuristic', () => {
  clearAvenPrefixes()
  assert.deepEqual(parseRefKind('PMR-2424'), {
    kind: 'jira',
    jiraId: 'PMR-2424',
  })
  assert.deepEqual(knownAvenPrefixes(), [])
})
