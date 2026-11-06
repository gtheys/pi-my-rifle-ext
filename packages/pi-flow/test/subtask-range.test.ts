import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// AIDEV-NOTE: PMR-6EEW per-subtask ranges — pure fixtures only, no git.

import {
  buildGateTarget,
  buildSubtaskGateTarget,
  extractReviewedCommits,
  gateTargetId,
  reviewedCommitsLine,
  verifyGateResult,
} from '../validate/gate-target.ts'
import {
  parseSubtaskLog,
  type SubtaskCommit,
  subtaskAttribution,
  subtaskCommitMap,
  unattributedCommits,
} from '../validate/subtask-range.ts'

const B = 'a'.repeat(40)
const H = 'b'.repeat(40)
const C1 = 'c'.repeat(40)
const C2 = 'd'.repeat(40)
const C3 = 'e'.repeat(40)

function logRecord(sha: string, message: string): string {
  return `${sha}\x1f${message}\x1e`
}

describe('parseSubtaskLog', () => {
  test('parses records and extracts Subtask trailers (deduped)', () => {
    const stdout = [
      logRecord(C1, 'feat: one\n\nSubtask: PMR-AA1\n'),
      logRecord(C2, 'feat: two\n\nSubtask: PMR-AA1\nSubtask: PMR-BB2\n'),
      logRecord(C3, 'chore: no trailer here'),
    ].join('\n')
    const parsed = parseSubtaskLog(stdout)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.commits.length, 3)
    assert.deepEqual(parsed.commits[0]?.subtaskRefs, ['PMR-AA1'])
    assert.deepEqual(parsed.commits[1]?.subtaskRefs, ['PMR-AA1', 'PMR-BB2'])
    assert.deepEqual(parsed.commits[2]?.subtaskRefs, [])
  })

  test('malformed sha is an error, never silent data loss', () => {
    const parsed = parseSubtaskLog(logRecord('deadbeef', 'msg'))
    assert.equal(parsed.ok, false)
  })

  test('empty log is an empty attribution', () => {
    const parsed = parseSubtaskLog('')
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(subtaskAttribution(parsed.commits), {
      bySubtask: [],
      unattributed: [],
    })
  })
})

describe('subtask attribution projection', () => {
  const commits: SubtaskCommit[] = [
    { sha: C1, message: 'm1', subtaskRefs: ['PMR-AA1'] },
    { sha: C2, message: 'm2', subtaskRefs: ['PMR-AA1', 'PMR-BB2'] },
    { sha: C3, message: 'm3', subtaskRefs: [] },
  ]

  test('map, unattributed, and sorted journal projection', () => {
    const map = subtaskCommitMap(commits)
    assert.deepEqual(map.get('PMR-AA1'), [C1, C2])
    assert.deepEqual(map.get('PMR-BB2'), [C2])
    assert.deepEqual(
      unattributedCommits(commits).map((c) => c.sha),
      [C3],
    )
    const attribution = subtaskAttribution(commits)
    assert.deepEqual(attribution.bySubtask, [
      { subtask: 'PMR-AA1', commits: [C1, C2] },
      { subtask: 'PMR-BB2', commits: [C2] },
    ])
    assert.deepEqual(attribution.unattributed, [C3])
  })
})

describe('buildSubtaskGateTarget', () => {
  const base = {
    gate: 'review' as const,
    ref: 'PMR-X',
    baseSha: B,
    headSha: H,
    diff: 'diff-bytes',
  }

  test('pins the subtask commit set', () => {
    const built = buildSubtaskGateTarget({
      ...base,
      subtaskRef: 'PMR-AA1',
      commits: [C1, C2],
    })
    assert.ok('subtask' in built)
    assert.deepEqual(built.subtask, { ref: 'PMR-AA1', commits: [C1, C2] })
  })

  test('rejects malformed subtask ref, empty and short-SHA commit lists', () => {
    assert.ok(
      !(
        'subtask' in
        buildSubtaskGateTarget({
          ...base,
          subtaskRef: 'not-a-ref',
          commits: [C1],
        })
      ),
    )
    assert.ok(
      !(
        'subtask' in
        buildSubtaskGateTarget({ ...base, subtaskRef: 'PMR-AA1', commits: [] })
      ),
    )
    assert.ok(
      !(
        'subtask' in
        buildSubtaskGateTarget({
          ...base,
          subtaskRef: 'PMR-AA1',
          commits: [C1.slice(0, 8)],
        })
      ),
    )
  })

  test('subtask targets get distinct ids; plain ids unchanged (backward compat)', () => {
    const plain = buildGateTarget(base)
    if (!('diffSha256' in plain)) throw new Error('unreachable')
    const withSub = buildSubtaskGateTarget({
      ...base,
      subtaskRef: 'PMR-AA1',
      commits: [C1],
    })
    if (!('subtask' in withSub)) throw new Error('unreachable')
    assert.notEqual(gateTargetId(plain), gateTargetId(withSub))
    assert.equal(gateTargetId(plain), gateTargetId({ ...plain }))
  })
})

describe('reviewed_commits echo contract', () => {
  test('line builder empty for whole-range targets', () => {
    const plain = buildGateTarget({
      gate: 'review',
      ref: 'PMR-X',
      baseSha: B,
      headSha: H,
      diff: 'd',
    })
    if (!('diffSha256' in plain)) throw new Error('unreachable')
    assert.equal(reviewedCommitsLine(plain), '')
  })

  test('extract echoes: last line wins, strict 40-hex comma list', () => {
    const artifact = [
      'reviewed_commits: nope',
      `reviewed_commits: ${C1}`,
      `reviewed_commits: ${C1},${C2}`,
    ].join('\n')
    assert.deepEqual(extractReviewedCommits(artifact), [C1, C2])
    assert.equal(extractReviewedCommits('nothing here'), null)
  })
})

describe('verifyGateResult with subtask targets', () => {
  function subTarget(commits: string[]) {
    const built = buildSubtaskGateTarget({
      gate: 'review',
      ref: 'PMR-X',
      baseSha: B,
      headSha: H,
      diff: 'd',
      subtaskRef: 'PMR-AA1',
      commits,
    })
    if (!('subtask' in built)) throw new Error('unreachable')
    return built
  }
  const rangeEcho = `reviewed_range: ${B}..${H}`

  test('exact echo of range + commits passes', () => {
    const t = subTarget([C1, C2])
    const verdict = verifyGateResult({
      target: t,
      artifact: `findings...\n${rangeEcho}\nreviewed_commits: ${C1},${C2}`,
      currentHeadSha: H,
    })
    assert.equal(verdict.ok, true)
  })

  test('missing commits echo fails with echo-missing', () => {
    const verdict = verifyGateResult({
      target: subTarget([C1]),
      artifact: `findings...\n${rangeEcho}`,
      currentHeadSha: H,
    })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.status, 'echo-missing')
    assert.match(verdict.reason, /reviewed_commits/)
  })

  test('wrong commit set fails with target-mismatch', () => {
    const verdict = verifyGateResult({
      target: subTarget([C1, C2]),
      artifact: `findings...\n${rangeEcho}\nreviewed_commits: ${C1},${C3}`,
      currentHeadSha: H,
    })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.status, 'target-mismatch')
    assert.match(verdict.reason, /PMR-AA1/)
  })

  test('reordered commits fail (order is attribution)', () => {
    const verdict = verifyGateResult({
      target: subTarget([C1, C2]),
      artifact: `findings...\n${rangeEcho}\nreviewed_commits: ${C2},${C1}`,
      currentHeadSha: H,
    })
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.status, 'target-mismatch')
  })

  test('whole-range targets never require the commits echo', () => {
    const plain = buildGateTarget({
      gate: 'review',
      ref: 'PMR-X',
      baseSha: B,
      headSha: H,
      diff: 'd',
    })
    if (!('diffSha256' in plain)) throw new Error('unreachable')
    const verdict = verifyGateResult({
      target: plain,
      artifact: `findings...\n${rangeEcho}`,
      currentHeadSha: H,
    })
    assert.equal(verdict.ok, true)
  })
})
