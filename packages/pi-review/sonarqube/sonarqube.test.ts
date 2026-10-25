import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runSonarAnalysis } from './sonarqube.ts'

// Canned SonarCloud API responses
const coverageMeasures = {
  component: {
    measures: [
      { metric: 'coverage', value: '85.0' },
      { metric: 'new_coverage', value: '90.0' },
      { metric: 'branch_coverage', value: '80.0' },
      { metric: 'new_branch_coverage', value: '75.0' },
      { metric: 'uncovered_lines', value: '10' },
      { metric: 'lines_to_cover', value: '100' },
    ],
  },
}

const duplicationMeasures = {
  component: {
    measures: [
      { metric: 'duplicated_lines_density', value: '2.0' },
      { metric: 'duplicated_lines', value: '20' },
      { metric: 'duplicated_blocks', value: '2' },
      { metric: 'duplicated_files', value: '1' },
    ],
  },
}

const dupTree = {
  components: [
    {
      key: 'proj:src/a.ts',
      measures: [
        { metric: 'duplicated_lines_density', value: '5.0' },
        { metric: 'duplicated_blocks', value: '1' },
        { metric: 'duplicated_lines', value: '30' },
      ],
    },
  ],
}

const dupShow = {
  duplications: [{ blocks: [{ from: 1, size: 10, _ref: '0' }] }],
  files: { '0': { key: 'proj:src/b.ts', name: 'b.ts' } },
}

const issuesPage = {
  total: 2,
  issues: [
    {
      rule: 'typescript:S100',
      severity: 'CRITICAL',
      type: 'CODE_SMELL',
      component: 'proj:src/a.ts',
      message: 'bad name',
      line: 5,
    },
    {
      rule: 'typescript:S200',
      severity: 'MINOR',
      type: 'CODE_SMELL',
      component: 'proj:src/c.ts',
      message: 'meh',
      line: 9,
    },
  ],
}

function cannedFetch(url: string): unknown {
  const u = new URL(url)
  if (u.pathname.endsWith('/measures/component')) {
    if (u.searchParams.get('metricKeys')?.startsWith('duplicated')) {
      return duplicationMeasures
    }
    return coverageMeasures
  }
  if (u.pathname.endsWith('/measures/component_tree')) return dupTree
  if (u.pathname.endsWith('/duplications/show')) return dupShow
  if (u.pathname.endsWith('/issues/search')) return issuesPage
  throw new Error(`unexpected url ${url}`)
}

function withCannedFetch(fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(cannedFetch(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = orig
  })
}

// PATH shim dir containing a fake `gh` that reports PR number 42
function makeGhShim(): string {
  return execFileSync(
    'node',
    [
      '-e',
      `
    const { mkdtempSync, writeFileSync, chmodSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const path = require('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'gh-shim-'));
    const gh = path.join(dir, 'gh');
    writeFileSync(gh, '#!/bin/sh\\necho 42\\n');
    chmodSync(gh, 0o755);
    process.stdout.write(dir);
  `,
    ],
    { encoding: 'utf8' },
  )
}

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonar-proj-'))
  writeFileSync(
    path.join(dir, 'sonar-project.properties'),
    'sonar.projectKey=proj\nsonar.organization=org\n',
  )
  return dir
}

test('runSonarAnalysis returns report and structured analysis', async () => {
  const dir = makeProjectDir()
  const prevToken = process.env.SONARQUBE_TOKEN
  process.env.SONARQUBE_TOKEN = 't'
  try {
    await withCannedFetch(async () => {
      const result = await runSonarAnalysis({ cwd: dir, prNumber: '42' })
      assert.match(result.report, /PR #42/)
      assert.match(result.report, /Overall Line Coverage: 85%/)
      assert.match(result.report, /Total Issues: 2/)
      assert.equal(result.prNumber, '42')
      assert.equal(result.config.projectKey, 'proj')
      assert.equal(result.coverage.overallCoverage, 85)
      assert.equal(result.issues.total, 2)
      assert.ok(result.duplication)
      assert.equal(result.duplication?.status, 'PASS')
      assert.ok(result.details.prNumber === '42')
      assert.equal(result.details.projectKey, 'proj')
      assert.equal(result.details.coverageOverall, 85)
      assert.equal(result.details.issuesTotal, 2)
    })
  } finally {
    if (prevToken === undefined) delete process.env.SONARQUBE_TOKEN
    else process.env.SONARQUBE_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runSonarAnalysis classifies missing token', async () => {
  const dir = makeProjectDir()
  const prev = process.env.SONARQUBE_TOKEN
  delete process.env.SONARQUBE_TOKEN
  try {
    const err = await runSonarAnalysis({ cwd: dir, prNumber: '1' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err instanceof Error)
    assert.equal((err as Error & { kind?: string }).kind, 'token')
  } finally {
    if (prev !== undefined) process.env.SONARQUBE_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runSonarAnalysis classifies missing config', async () => {
  const prev = process.env.SONARQUBE_TOKEN
  process.env.SONARQUBE_TOKEN = 't'
  const dir = mkdtempSync(path.join(tmpdir(), 'no-sonar-'))
  try {
    const err = await runSonarAnalysis({ cwd: dir, prNumber: '1' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.equal((err as Error & { kind?: string }).kind, 'config')
  } finally {
    if (prev === undefined) delete process.env.SONARQUBE_TOKEN
    else process.env.SONARQUBE_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runSonarAnalysis detects PR number via gh shim', async () => {
  const dir = makeProjectDir()
  const shimDir = makeGhShim()
  const prevPath = process.env.PATH
  const prevToken = process.env.SONARQUBE_TOKEN
  process.env.SONARQUBE_TOKEN = 't'
  process.env.PATH = `${shimDir}:${prevPath}`
  try {
    await withCannedFetch(async () => {
      const result = await runSonarAnalysis({ cwd: dir })
      assert.equal(result.prNumber, '42')
      assert.match(result.report, /PR #42/)
    })
  } finally {
    process.env.PATH = prevPath
    if (prevToken === undefined) delete process.env.SONARQUBE_TOKEN
    else process.env.SONARQUBE_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
    rmSync(shimDir, { recursive: true, force: true })
  }
})
