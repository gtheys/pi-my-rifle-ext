// Fake-exec unit tests for checkMainAdvancement (PMR-1KAE): both detections
// (stale flow branch vs base tip; origin/<base> ahead of local <base>) plus
// the fail-closed paths. No real git, no network — every git invocation is
// answered by a scriptable fake Exec.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Exec, ExecResult } from '../shared/diff-base.ts'
import { checkMainAdvancement } from '../tools/land.ts'

interface Route {
  match: (cmd: string, args: string[]) => boolean
  stdout?: string
  stderr?: string
  code?: number
}

function fakeExec(routes: Route[]): Exec {
  return async (cmd, args) => {
    for (const route of routes) {
      if (route.match(cmd, args)) {
        const result: ExecResult = {
          stdout: route.stdout ?? '',
          stderr: route.stderr,
          code: route.code ?? 0,
        }
        return result
      }
    }
    const result: ExecResult = {
      stdout: '',
      stderr: `unmatched: ${cmd} ${args.join(' ')}`,
      code: 128,
    }
    return result
  }
}

const MAIN_REPO = '/repo'
const BRANCH = 'flow-branch'
const BASE = 'main'
const TIP = 'ti1111'
const MERGE_BASE = 'ba2222'
const ORIGIN_TIP = 'or3333'

function routesFor(options?: {
  base?: string
  headStdout?: string
  tip?: string
  tipCode?: number
  mergeBase?: string
  mergeBaseCode?: number
  fetchCode?: number
  fetchStderr?: string
  originTip?: string
  originTipCode?: number
  isAncestorCode?: number
  isAncestorStderr?: string
}): Route[] {
  const base = options?.base ?? BASE
  const head = options?.headStdout ?? base
  return [
    {
      match: (cmd, args) =>
        cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref',
      stdout: head,
    },
    {
      match: (cmd, args) =>
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `${base}^{commit}`,
      stdout: options?.tip ?? TIP,
      code: options?.tipCode,
    },
    {
      match: (cmd, args) =>
        cmd === 'git' && args[0] === 'merge-base' && args.length === 3,
      stdout: options?.mergeBase ?? TIP,
      code: options?.mergeBaseCode,
    },
    {
      match: (cmd, args) => cmd === 'git' && args[0] === 'fetch',
      code: options?.fetchCode,
      stderr: options?.fetchStderr,
    },
    {
      match: (cmd, args) =>
        cmd === 'git' &&
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === `origin/${base}^{commit}`,
      stdout: options?.originTip ?? TIP,
      code: options?.originTipCode,
    },
    {
      match: (cmd, args) =>
        cmd === 'git' &&
        args[0] === 'merge-base' &&
        args[1] === '--is-ancestor',
      code: options?.isAncestorCode ?? 1,
      stderr: options?.isAncestorStderr,
    },
  ]
}

test('landing branch already checked out in the main checkout is a no-op refusal (PMR-1KAE, PMR-5PQH guard)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ headStdout: BRANCH })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /stale resolution/)
  assert.match(result.reason, /no-op/)
})

test('no refusal guidance instructs an agent-run merge — merge commands are human-routed (PMR-1KAE review blocker)', async () => {
  const scenarios: Array<{ name: string; routes: Route[] }> = [
    { name: 'stale', routes: routesFor({ mergeBase: MERGE_BASE }) },
    {
      name: 'origin-ahead',
      routes: routesFor({ originTip: ORIGIN_TIP, isAncestorCode: 0 }),
    },
    {
      name: 'fetch-failure',
      routes: routesFor({ fetchCode: 128, fetchStderr: 'boom' }),
    },
    { name: 'missing-origin-ref', routes: routesFor({ originTipCode: 1 }) },
    { name: 'detached-head', routes: routesFor({ headStdout: 'HEAD' }) },
    {
      name: 'merge-base-failure',
      routes: routesFor({ mergeBaseCode: 128 }),
    },
    {
      name: 'ancestry-failure',
      routes: routesFor({ originTip: ORIGIN_TIP, isAncestorCode: 128 }),
    },
    { name: 'no-op-landing-branch', routes: routesFor({ headStdout: BRANCH }) },
  ]
  for (const scenario of scenarios) {
    const result = await checkMainAdvancement(
      fakeExec(scenario.routes),
      MAIN_REPO,
      BRANCH,
    )
    if (result.ok) continue
    if (/merge --ff-only/.test(result.reason)) {
      assert.match(
        result.reason,
        /human/i,
        `${scenario.name}: a refusal naming a merge command must route it to the human — mergeIntercept blocks agent-run merges while the flow is active`,
      )
    }
  }
})

test('stale flow branch is refused with the rebase-then-reland guidance (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ mergeBase: MERGE_BASE })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /rebase/)
  assert.match(result.reason, /flow branch 'flow-branch'/)
  assert.match(result.reason, /'main' tip is ti1111/)
  assert.match(result.reason, /ba2222/)
})

test('fresh flow branch with current origin authorizes (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor()),
    MAIN_REPO,
    BRANCH,
  )
  assert.deepEqual(result, { ok: true })
})

test('origin ahead of the local base is refused with fetch-and-ff guidance (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ originTip: ORIGIN_TIP, isAncestorCode: 0 })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /origin\/main.*ahead/)
  assert.match(result.reason, /merge --ff-only 'origin\/main'/)
  assert.match(result.reason, /flow_land again/)
  assert.match(result.reason, /\/repo/)
})

test('fetch failure refuses fail-closed with the underlying cause (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(
      routesFor({
        fetchCode: 128,
        fetchStderr: 'fatal: Could not read from remote repository',
      }),
    ),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /git fetch origin failed/)
  assert.match(result.reason, /Could not read from remote repository/)
})

test('missing origin ref after fetch refuses fail-closed (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ originTipCode: 1 })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /cannot verify/)
})

test('origin diverged (local not strictly behind) still authorizes (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ originTip: ORIGIN_TIP, isAncestorCode: 1 })),
    MAIN_REPO,
    BRANCH,
  )
  assert.deepEqual(result, { ok: true })
})

test('detached HEAD in the main checkout refuses fail-closed (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ headStdout: 'HEAD' })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /cannot read the branch checked out in/)
  assert.match(result.reason, /detached HEAD/)
})

test('merge-base failure refuses fail-closed (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(routesFor({ mergeBaseCode: 128 })),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(
    result.reason,
    /merge-base of flow branch 'flow-branch' and 'main'/,
  )
})

test('ancestry probe failure refuses fail-closed (PMR-1KAE)', async () => {
  const result = await checkMainAdvancement(
    fakeExec(
      routesFor({
        originTip: ORIGIN_TIP,
        isAncestorCode: 128,
        isAncestorStderr: 'fatal: not a valid ref',
      }),
    ),
    MAIN_REPO,
    BRANCH,
  )
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.match(result.reason, /cannot compare 'main' with 'origin\/main'/)
})
