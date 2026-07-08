import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEvaluationReport,
  buildGitDiffArgs,
  buildSemDiffArgs,
  compareCoverage,
  formatEvaluationReport,
  parseSemJsonOutput,
  pickImpactTargets,
  summarizeSemDiffPayload,
} from './core.mjs'

test('buildSemDiffArgs builds a range diff with extension filters', () => {
  const args = buildSemDiffArgs({
    from: 'origin/main',
    to: 'HEAD',
    fileExts: ['ts', '.md'],
  })
  assert.deepEqual(args, [
    'diff',
    '--from',
    'origin/main',
    '--to',
    'HEAD',
    '--file-exts',
    '.ts',
    '.md',
    '--format',
    'json',
  ])
})

test('buildGitDiffArgs includes pathspecs for extension filtering', () => {
  const args = buildGitDiffArgs({ staged: true, fileExts: ['ts'] })
  assert.deepEqual(args, [
    'diff',
    '--staged',
    '--unified=3',
    '--',
    ':(glob)**/*.ts',
  ])
})

test('parseSemJsonOutput normalizes empty sem diff output', () => {
  const payload = parseSemJsonOutput(
    'sem diff',
    '\u001b[2mNo changes detected.\u001b[0m',
  )
  assert.deepEqual(payload, {
    summary: { fileCount: 0, added: 0, modified: 0, deleted: 0, total: 0 },
    changes: [],
  })
})

test('compareCoverage reports missing and extra files', () => {
  const coverage = compareCoverage(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])
  assert.deepEqual(coverage.covered, ['b.ts'])
  assert.deepEqual(coverage.missing, ['a.ts'])
  assert.deepEqual(coverage.extra, ['c.ts'])
  assert.equal(coverage.coveragePercent, '50%')
})

test('evaluation report formats semantic summary and impact samples', () => {
  const semDiffJson = {
    summary: { fileCount: 2, added: 1, modified: 1, deleted: 0, total: 2 },
    changes: [
      {
        changeType: 'modified',
        entityType: 'function',
        entityName: 'buildReport',
        filePath: 'src/report.ts',
      },
      {
        changeType: 'added',
        entityType: 'class',
        entityName: 'SemRunner',
        filePath: 'src/runner.ts',
      },
    ],
  }

  assert.deepEqual(pickImpactTargets(semDiffJson, 5), [
    {
      entity: 'buildReport',
      file: 'src/report.ts',
      entityType: 'function',
      changeType: 'modified',
    },
    {
      entity: 'SemRunner',
      file: 'src/runner.ts',
      entityType: 'class',
      changeType: 'added',
    },
  ])

  const report = buildEvaluationReport({
    selection: { from: 'origin/main', to: 'HEAD' },
    gitDiffText: 'diff --git a/src/report.ts b/src/report.ts\n+foo\n',
    gitFiles: ['src/report.ts', 'src/runner.ts', 'README.md'],
    semDiffText: JSON.stringify(semDiffJson, null, 2),
    semDiffJson,
    impactResults: [
      {
        entity: 'buildReport',
        file: 'src/report.ts',
        result: { affectedTests: ['report.spec.ts', 'runner.spec.ts'] },
      },
    ],
  })

  const formatted = formatEvaluationReport(report)
  assert.match(formatted, /semantic coverage: 2\/3 \(67%\)/)
  assert.match(
    formatted,
    /entities changed: 2 \(added 1, modified 1, deleted 0\)/,
  )
  assert.match(formatted, /buildReport/)
  assert.match(formatted, /impact samples/)

  const summary = summarizeSemDiffPayload(semDiffJson)
  assert.equal(summary.summary.total, 2)
  assert.equal(summary.changesByFile['src/report.ts'], 1)
  assert.equal(summary.entityTypeCounts.function, 1)
})
