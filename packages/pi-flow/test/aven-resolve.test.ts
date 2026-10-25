import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isUnknownRef,
  overrideFailureReason,
  parseWorkspaceList,
  searchHasExactRef,
  unknownRefFailureReason,
  workspaceSearchOrder,
} from '../flow/aven-resolve.ts'

describe('isUnknownRef', () => {
  it('matches aven unknown-ref stderr', () => {
    assert.equal(isUnknownRef('error unknown-ref\n'), true)
  })
  it('rejects other failures', () => {
    assert.equal(isUnknownRef('error db-locked\n'), false)
    assert.equal(isUnknownRef(undefined), false)
    assert.equal(isUnknownRef(''), false)
  })
})

describe('searchHasExactRef', () => {
  const hit = JSON.stringify([
    { ref: 'PMR-AAAA', title: 'other' },
    { ref: 'PMR-QCFT', title: 'target' },
  ])
  it('finds an exact ref match', () => {
    assert.equal(searchHasExactRef(hit, 'PMR-QCFT'), true)
  })
  it('misses when only other refs are present', () => {
    assert.equal(searchHasExactRef(hit, 'PMR-ZZZZ'), false)
  })
  it('does not match partial refs', () => {
    assert.equal(searchHasExactRef(hit, 'PMR-QC'), false)
  })
  it('handles empty results and invalid JSON', () => {
    assert.equal(searchHasExactRef('[]', 'PMR-QCFT'), false)
    assert.equal(searchHasExactRef('not json', 'PMR-QCFT'), false)
  })
})

describe('parseWorkspaceList', () => {
  it('extracts names in listed order', () => {
    const out = 'default name="default"\npersonal name="personal"\n'
    assert.deepEqual(parseWorkspaceList(out), ['default', 'personal'])
  })
  it('skips blank lines', () => {
    assert.deepEqual(parseWorkspaceList('\n\nsolo key="solo"\n'), ['solo'])
  })
})

describe('workspaceSearchOrder', () => {
  it('preserves listed order and skips tried workspaces', () => {
    assert.deepEqual(workspaceSearchOrder(['a', 'b', 'c'], ['b']), ['a', 'c'])
  })
  it('dedupes', () => {
    assert.deepEqual(workspaceSearchOrder(['a', 'a', 'b'], []), ['a', 'b'])
  })
  it('returns empty when everything is tried', () => {
    assert.deepEqual(workspaceSearchOrder(['a'], ['a']), [])
  })
})

describe('failure reasons are actionable', () => {
  it('unknown-ref names both fixes', () => {
    const reason = unknownRefFailureReason('PMR-QCFT')
    assert.match(reason, /aven project path add pi-my-rifle-ext/)
    assert.match(reason, /avenWorkspace/)
    assert.match(reason, /PMR-QCFT/)
  })
  it('override failure names the workspace and cause', () => {
    const reason = overrideFailureReason('PMR-QCFT', 'projects', 'spawn failed')
    assert.match(reason, /"projects"/)
    assert.match(reason, /spawn failed/)
  })
})
