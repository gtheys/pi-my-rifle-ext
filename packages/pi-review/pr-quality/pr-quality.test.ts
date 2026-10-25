import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gatherPrQualityData, PrQualityError } from './index.ts'

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

const issuesPage = {
  total: 1,
  issues: [
    {
      rule: 'typescript:S100',
      severity: 'CRITICAL',
      type: 'CODE_SMELL',
      component: 'proj:src/a.ts',
      message: 'bad name',
      line: 5,
    },
  ],
}

const graphqlResponse = {
  data: {
    repository: {
      pullRequest: {
        title: 'Test PR title',
        url: 'https://github.com/owner/repo/pull/42',
        reviewThreads: {
          totalCount: 1,
          nodes: [
            {
              id: 'T1',
              isResolved: false,
              isOutdated: false,
              path: 'src/a.ts',
              line: 5,
              startLine: null,
              comments: {
                nodes: [
                  {
                    body: 'this is wrong',
                    author: { login: 'reviewer' },
                    createdAt: '2026-10-25T00:00:00Z',
                    url: 'https://github.com/owner/repo/pull/42#discussion-r1',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
}

function cannedFetch(url: string): unknown {
  const u = new URL(url)
  if (u.pathname.endsWith('/measures/component')) return coverageMeasures
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

// PATH shim dir with a fake `gh`: `gh pr view` prints a statusCheckRollup,
// `gh api graphql` prints canned PR thread data.
function makeGhShim(checksJson: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gh-shim-'))
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "pr" ]; then',
    `  echo '${checksJson.replace(/'/g, "'\\''")}'`,
    'else',
    `  echo '${JSON.stringify(graphqlResponse).replace(/'/g, "'\\''")}'`,
    'fi',
  ].join('\n')
  writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 })
  return dir
}

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prq-proj-'))
  writeFileSync(
    path.join(dir, 'sonar-project.properties'),
    'sonar.projectKey=proj\nsonar.organization=org\n',
  )
  return dir
}

const DONE_CHECKS =
  '{"statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}]}'
const PENDING_CHECKS =
  '{"statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"test","status":"IN_PROGRESS","conclusion":null}]}'

test('gatherPrQualityData returns prompt and structured details', async () => {
  const dir = makeProjectDir()
  const shimDir = makeGhShim(DONE_CHECKS)
  const prevPath = process.env.PATH
  const prevToken = process.env.SONARQUBE_TOKEN
  process.env.SONARQUBE_TOKEN = 't'
  process.env.PATH = `${shimDir}:${prevPath}`
  try {
    await withCannedFetch(async () => {
      const result = await gatherPrQualityData({ cwd: dir, prNumber: '42' })
      assert.equal(result.prNumber, '42')
      assert.match(result.prompt, /PR #42: Test PR title/)
      assert.match(result.prompt, /Section 2 — Unresolved Review Threads \(1\)/)
      assert.match(result.prompt, /reviewer/)
      assert.match(result.prompt, /Overall Line \| 85%/)
      assert.match(result.prompt, /\*\*Total:\*\* 1/)
      assert.equal(result.details.prNumber, '42')
      assert.equal(result.details.prTitle, 'Test PR title')
      assert.equal(result.details.unresolvedCount, 1)
      assert.equal(result.details.issuesTotal, 1)
      assert.equal(result.details.issuesBySeverity.CRITICAL, 1)
      assert.equal(result.details.projectKey, 'proj')
    })
  } finally {
    process.env.PATH = prevPath
    if (prevToken === undefined) delete process.env.SONARQUBE_TOKEN
    else process.env.SONARQUBE_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
    rmSync(shimDir, { recursive: true, force: true })
  }
})

test('gatherPrQualityData classifies missing token', async () => {
  const dir = makeProjectDir()
  const prev = process.env.SONARQUBE_TOKEN
  delete process.env.SONARQUBE_TOKEN
  try {
    const err = await gatherPrQualityData({ cwd: dir, prNumber: '1' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err instanceof PrQualityError)
    assert.equal(err.kind, 'token')
  } finally {
    if (prev !== undefined) process.env.SONARQUBE_TOKEN = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gatherPrQualityData classifies CI-pending distinctly from hard failures', async () => {
  const dir = makeProjectDir()
  const shimDir = makeGhShim(PENDING_CHECKS)
  const prevPath = process.env.PATH
  const prevToken = process.env.SONARQUBE_TOKEN
  process.env.SONARQUBE_TOKEN = 't'
  process.env.PATH = `${shimDir}:${prevPath}`
  try {
    const err = await gatherPrQualityData({ cwd: dir, prNumber: '42' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(err instanceof PrQualityError)
    assert.equal(err.kind, 'ci-pending')
    assert.deepEqual(
      err.pending.map((c: { name: string }) => c.name),
      ['test'],
    )
    assert.match(err.message, /CI not done yet/)
  } finally {
    process.env.PATH = prevPath
    if (prevToken === undefined) delete process.env.SONARQUBE_TOKEN
    else process.env.SONARQUBE_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
    rmSync(shimDir, { recursive: true, force: true })
  }
})
