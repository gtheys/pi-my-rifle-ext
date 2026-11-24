// AIDEV-NOTE (PMR-XR43 1.1): tests for the node-only push plumbing. Fixtures
// are copied from a REAL `GET {base}/metrics` dump of the live gateway
// (verified 2026-11-24): labels come out alphabetically sorted and the
// gateway injects `instance=""` into every exposed line, plus `# TYPE`/`# HELP`
// family comments that cover all groups. Keep that shape in new fixtures.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushToGateway as pushToGatewayViaCost } from '../flow/cost.ts'
import {
  fetchGroupBody,
  type GroupFetch,
  groupUrl,
  pushToGateway,
} from '../flow/push.ts'

/** Live dump excerpt: personal groups carry no `mode` label, work groups carry
 *  `mode="work"` (injected from the URL path by the gateway). */
const DUMP = `# HELP pi_flow_run_status Auto-detected based on sample values below.
# TYPE pi_flow_run_status untyped
pi_flow_blocker_retries{instance="",job="pi-flow",ref="PMR-C0WG"} 0
pi_flow_run_cost_usd{agent="main",instance="",job="pi-flow",phase="plan",ref="PMR-C0WG",session="main-01a202f3",subtask=""} 0
pi_flow_run_halt_reason{instance="",job="pi-flow",reason="flow halted at plan: phase completed without landing the \\"planned\\" label",ref="PMR-C0WG"} 1
pi_flow_run_status{instance="",job="pi-flow",ref="PMR-C0WG",status="halted"} 1
pi_flow_run_duration_seconds{instance="",job="pi-flow",mode="work",phase="implement",ref="DP-236"} 56.587
pi_flow_run_status{instance="",job="pi-flow",mode="work",ref="DP-236",status="halted"} 1
pi_flow_run_status{instance="",job="pi-flow",ref="DP-236",status="done"} 1
pi_flow_run_status{instance="",job="pi-flow",mode="work",ref="PMR-DUAL",status="paused"} 1
pi_flow_run_status{instance="",job="pi-flow",ref="PMR-DUAL",status="halted"} 1
pi_flow_run_status{instance="",job="pi-flow",ref="PMR-81SX",status="done"} 1
push_time_seconds{instance="",job="pi-flow",ref="PMR-C0WG"} 1.7954159528031516e+09
`

/** Expected filtered body: the given exposition lines plus a trailing newline. */
function group(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

function responding(
  body: string,
  status = 200,
  statusText = 'OK',
): { calls: Array<{ url: string; init: unknown }>; fetchImpl: GroupFetch } {
  const calls: Array<{ url: string; init: unknown }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { status, statusText, text: async () => body }
    },
  }
}

test('groupUrl builds the POST URL with the work-mode suffix only for work', () => {
  assert.equal(
    groupUrl('https://gw.example/', 'DP-236', 'work'),
    'https://gw.example/metrics/job/pi-flow/ref/DP-236/mode/work',
  )
  assert.equal(
    groupUrl('https://gw.example', 'PMR-1', 'personal'),
    'https://gw.example/metrics/job/pi-flow/ref/PMR-1',
  )
  assert.equal(
    groupUrl('https://gw.example', 'PMR-1'),
    'https://gw.example/metrics/job/pi-flow/ref/PMR-1',
  )
  assert.equal(
    groupUrl('https://gw.example', 'a b/c'),
    'https://gw.example/metrics/job/pi-flow/ref/a%20b%2Fc',
  )
})

test('pushToGateway posts to the groupUrl (moved from cost.ts unchanged)', async () => {
  const calls: Array<{ url: string; init: unknown }> = []
  const ok = await pushToGateway(
    'https://gw.example/',
    'PMR-TEST',
    'metric 1\n',
    async (url, init) => {
      calls.push({ url, init })
      return { status: 200, statusText: 'OK' }
    },
    'sekret',
    'work',
  )
  assert.deepEqual(ok, { ok: true })
  assert.equal(
    calls[0].url,
    'https://gw.example/metrics/job/pi-flow/ref/PMR-TEST/mode/work',
  )
  const init = calls[0].init as { headers: Record<string, string> }
  assert.equal(init.headers.authorization, 'Bearer sekret')

  const httpFail = await pushToGateway(
    'https://gw.example',
    'PMR-TEST',
    'x',
    async () => ({ status: 503, statusText: 'unavailable' }),
  )
  assert.equal(httpFail.ok, false)
  assert.match(httpFail.error ?? '', /503/)

  const netFail = await pushToGateway(
    'https://gw.example',
    'PMR-TEST',
    'x',
    async () => {
      throw new Error('connection refused')
    },
  )
  assert.equal(netFail.ok, false)
  assert.match(netFail.error ?? '', /connection refused/)

  // cost.ts keeps re-exporting the same function (zero behavior change).
  assert.equal(pushToGatewayViaCost, pushToGateway)
})

test('fetchGroupBody GETs the full dump URL, never a group URL', async () => {
  const { calls, fetchImpl } = responding(DUMP)
  const result = await fetchGroupBody(
    'https://gw.example/',
    'PMR-C0WG',
    'personal',
    'sekret',
    fetchImpl,
  )
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  // AIDEV-NOTE: GET on the group URL is 405 on this gateway — the only way to
  // read a stored group back is the full /metrics exposition dump.
  assert.equal(calls[0].url, 'https://gw.example/metrics')
  const init = calls[0].init as {
    method: string
    headers: Record<string, string>
  }
  assert.equal(init.method, 'GET')
  assert.equal(init.headers.authorization, 'Bearer sekret')
})

test("fetchGroupBody keeps only the ref's lines and drops # comments", async () => {
  const { fetchImpl } = responding(DUMP)
  const result = await fetchGroupBody(
    'https://gw.example',
    'PMR-C0WG',
    'personal',
    undefined,
    fetchImpl,
  )
  assert.deepEqual(result, {
    ok: true,
    body: group(
      'pi_flow_blocker_retries{job="pi-flow",ref="PMR-C0WG"} 0',
      'pi_flow_run_cost_usd{agent="main",job="pi-flow",phase="plan",ref="PMR-C0WG",session="main-01a202f3",subtask=""} 0',
      'pi_flow_run_halt_reason{job="pi-flow",reason="flow halted at plan: phase completed without landing the \\"planned\\" label",ref="PMR-C0WG"} 1',
      'pi_flow_run_status{job="pi-flow",ref="PMR-C0WG",status="halted"} 1',
      'push_time_seconds{job="pi-flow",ref="PMR-C0WG"} 1.7954159528031516e+09',
    ),
  })
})

test('fetchGroupBody filters on the mode label (work keeps mode="work" only)', async () => {
  const { fetchImpl } = responding(DUMP)
  const work = await fetchGroupBody(
    'https://gw.example',
    'DP-236',
    'work',
    undefined,
    fetchImpl,
  )
  assert.deepEqual(work, {
    ok: true,
    body: group(
      'pi_flow_run_duration_seconds{job="pi-flow",mode="work",phase="implement",ref="DP-236"} 56.587',
      'pi_flow_run_status{job="pi-flow",mode="work",ref="DP-236",status="halted"} 1',
    ),
  })

  // Personal semantics: a ref pushed without the mode grouping label must not
  // pick up the same ref's work-mode lines (and vice versa).
  const dualWork = await fetchGroupBody(
    'https://gw.example',
    'PMR-DUAL',
    'work',
    undefined,
    fetchImpl,
  )
  assert.deepEqual(dualWork, {
    ok: true,
    body: group(
      'pi_flow_run_status{job="pi-flow",mode="work",ref="PMR-DUAL",status="paused"} 1',
    ),
  })
  const dualPersonal = await fetchGroupBody(
    'https://gw.example',
    'PMR-DUAL',
    'personal',
    undefined,
    fetchImpl,
  )
  assert.deepEqual(dualPersonal, {
    ok: true,
    body: group(
      'pi_flow_run_status{job="pi-flow",ref="PMR-DUAL",status="halted"} 1',
    ),
  })
})

test('fetchGroupBody returns an empty body for a group with no lines', async () => {
  const { fetchImpl } = responding(DUMP)
  const result = await fetchGroupBody(
    'https://gw.example',
    'PMR-GONE',
    'work',
    undefined,
    fetchImpl,
  )
  assert.deepEqual(result, { ok: true, body: '' })
})

test('fetchGroupBody fails soft on non-2xx and on network errors', async () => {
  const http = responding(DUMP, 404, 'Not Found')
  assert.deepEqual(
    await fetchGroupBody(
      'https://gw.example',
      'PMR-1',
      'personal',
      't',
      http.fetchImpl,
    ),
    {
      ok: false,
      error: 'pushgateway GET responded 404 Not Found',
    },
  )

  const netFail: GroupFetch = async () => {
    throw new Error('connection refused')
  }
  const result = await fetchGroupBody(
    'https://gw.example',
    'PMR-1',
    'personal',
    't',
    netFail,
  )
  assert.equal(result.ok, false)
  assert.match(
    (result as { ok: false; error: string }).error,
    /connection refused/,
  )
})
