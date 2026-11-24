// AIDEV-NOTE (PMR-XR43 1.1): node-only Pushgateway plumbing, moved out of
// flow/cost.ts so the daemon (server/daemon.ts) and flow/reconcile.ts can reach
// it. This file must import ONLY node built-ins — no @earendil-works/
// pi-coding-agent, no @gtheys/pi-interactive-subagents (the daemon header
// contract, server/daemon.ts:1-11). cost.ts re-exports these symbols, so the
// extension-side imports (index.ts, flow/cost-command.ts, test/cost.test.ts)
// are unchanged.
//
// Why `fetchGroupBody` reads the FULL dump instead of the group:
// AIDEV-NOTE: a per-group GET (`GET {base}/metrics/job/pi-flow/ref/<ref>`) is
// **405 Method Not Allowed** on this gateway (verified live 2026-11-24) —
// Pushgateway only serves stored groups through the single exposition dump at
// `GET {base}/metrics`. So reading one group back means fetching the whole
// dump and filtering lines by their label set. Two dump quirks decide the
// filter, both verified against the live gateway:
//   (a) the gateway injects `instance=""` into every exposed line; that label
//       pair is stripped before a body is re-POSTed, otherwise the re-POSTed
//       series gets a different identity;
//   (b) the dump covers ALL groups behind `# HELP`/`# TYPE` family comments —
//       every `#` line is dropped (`buildPushBody` never emits comments, so
//       keeping them would change the group).
// Grouping labels injected from the URL path (`job`, `ref`, and `mode` for
// work pushes) come back inside the label set, which is what the filter keys
// on. Note the gateway's own `push_time_seconds` / `push_failure_time_seconds`
// lines also carry the group's labels and therefore survive the filter; the
// gateway overwrites them on the next POST, so they are left untouched here.

export interface PushResult {
  ok: boolean
  /** Present only when ok=false — the caller shows a warning, never fails. */
  error?: string
}

export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; statusText: string }>

/** Fetch shape for reading the exposition back. `globalThis.fetch` satisfies
 *  it (only `status`/`statusText`/`text()` are used). */
export type GroupFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{
  status: number
  statusText: string
  text: () => Promise<string>
}>

export type GroupBodyResult =
  | { ok: true; body: string }
  | { ok: false; error: string }

/**
 * Extra Pushgateway grouping segment. AIDEV-NOTE: only WORK mode adds a
 * `mode` grouping label — personal pushes keep their historical group
 * (`…/ref/<ref>`, no mode label) so existing series are replaced in place, not
 * duplicated. Dashboards treat a missing mode label as personal.
 */
export function groupSuffix(mode: 'work' | 'personal' | undefined): string {
  if (mode === 'work') return '/mode/work'
  return ''
}

/**
 * Single-sourced Pushgroup URL builder: the grouping keys put ref (and, for
 * work mode, mode) in the URL path so separate runs keep separate metric
 * groups. Used for both the POST (push) and the reconcile-side re-POST.
 */
export function groupUrl(
  base: string,
  ref: string,
  mode?: 'work' | 'personal',
): string {
  const root = base.replace(/\/+$/, '')
  return `${root}/metrics/job/pi-flow/ref/${encodeURIComponent(ref)}${groupSuffix(mode)}`
}

/**
 * Push the exposition body to a Pushgateway. Grouping keys put ref in the
 * URL path so separate runs keep separate metric groups; the bearer token
 * (when configured) rides the Authorization header. Failures return
 * {ok:false} — /flow-cost treats them as warnings, never fatal.
 */
export async function pushToGateway(
  url: string,
  ref: string,
  body: string,
  fetchImpl: PushFetch,
  token?: string,
  mode?: 'work' | 'personal',
): Promise<PushResult> {
  const headers: Record<string, string> = {
    'content-type': 'text/plain',
  }
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`
  }
  try {
    const response = await fetchImpl(groupUrl(trimBase(url), ref, mode), {
      method: 'POST',
      headers,
      body,
    })
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: `pushgateway responded ${response.status} ${response.statusText}`,
      }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    return { ok: false, error: message }
  }
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Read one stored group back: GET the full exposition dump and keep only the
 * lines whose label set belongs to this group — `job="pi-flow"`,
 * `ref=<ref>`, and `mode="work"` present iff `mode === 'work'` (matching
 * {@link groupSuffix} semantics: a personal group is a group with NO mode
 * label). The injected `instance=""` pair is stripped and every `#` comment
 * line dropped, so the result can be re-POSTed to {@link groupUrl} unchanged
 * and replace the group in place. Never throws: a non-2xx response or a
 * network error returns {ok:false}. A group with no lines returns
 * {ok:true, body:""} — the caller treats an empty body as "group gone".
 *
 * AIDEV-NOTE (PMR-MSDJ fix round, P2-5): an unparseable line that could be
 * one of OURS also returns {ok:false}, and that direction is the whole point.
 * A POST REPLACES the entire group (pushgateway's Replace path deletes every
 * stored family the body omits), so silently SKIPPING a line this parser
 * cannot read is silent, permanent DATA LOSS — a lost `pi_flow_run_cost_usd`
 * row is gone from the runs board for good. Failing the read loses the
 * TOMBSTONE instead: {ok:false} costs one skip entry plus one warning, and
 * the group keeps every byte it had until the next pass.
 *
 * The failure is scoped to lines that could belong to THIS group
 * ({@link couldBelongToGroup}), and that scoping is measured, not defensive
 * polish: the live gateway dump carries 38 label-less NON-comment lines
 * (pushgateway's own runtime metrics, `go_goroutines 11`,
 * `go_memstats_alloc_bytes …`), so failing on every unreadable line would
 * have made every read fail and quietly disabled tombstoning everywhere — a
 * worse bug than the one it fixes. A line with no label section at all can
 * never be a group member: the gateway re-forces the grouping labels (`job`,
 * `ref`, `instance`, `mode`) onto every stored series, so all of this group's
 * lines are labelled, and dropping an unlabelled one erases nothing.
 */
export async function fetchGroupBody(
  url: string,
  ref: string,
  mode: 'work' | 'personal',
  token: string | undefined,
  fetchImpl: GroupFetch,
): Promise<GroupBodyResult> {
  const headers: Record<string, string> = {}
  if (token !== undefined && token.length > 0) {
    headers.authorization = `Bearer ${token}`
  }
  try {
    const response = await fetchImpl(`${trimBase(url)}/metrics`, {
      method: 'GET',
      headers,
    })
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: `pushgateway GET responded ${response.status} ${response.statusText}`,
      }
    }
    const dump = await response.text()
    return filterGroupLines(dump, ref, mode)
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`
    return { ok: false, error: message }
  }
}

/** One `key="value"` label as it appeared in the dump, raw text included so
 *  kept lines stay byte-identical apart from the stripped pair. */
interface LabelToken {
  key: string
  /** Escaped value decoded for comparisons; raw kept for the output line. */
  value: string
  raw: string
}

/**
 * Split a `{...}` label section into tokens. Returns null on anything
 * malformed. AIDEV-NOTE: null is NOT "not this group" — it is "unreadable",
 * and {@link filterGroupLines} turns it into a failed READ, because a POST
 * replaces the whole group and an unreadable line may be one this group owns
 * (P2-5 in {@link fetchGroupBody}).
 */
function splitLabels(inner: string): LabelToken[] | null {
  const tokens: LabelToken[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && inner[i] === ' ') i += 1
    if (i === inner.length) break
    const label = readLabel(inner, i)
    if (label === null) return null
    tokens.push(label.token)
    i = skipSpaces(inner, label.next)
    if (i === inner.length) break
    if (inner[i] !== ',') return null
    i = skipSpaces(inner, i + 1)
  }
  return tokens
}

function skipSpaces(text: string, from: number): number {
  let i = from
  while (i < text.length && text[i] === ' ') i += 1
  return i
}

/** Read one `key="value"` token beginning at `start` (Prometheus exposition
 *  escaping: `\\`, `\"`, `\n`). Returns the token plus the index just past it. */
function readLabel(
  inner: string,
  start: number,
): { token: LabelToken; next: number } | null {
  const eq = inner.indexOf('=', start)
  if (eq < 0) return null
  const key = inner.slice(start, eq).trim()
  if (key.length === 0) return null
  let i = skipSpaces(inner, eq + 1)
  if (inner[i] !== '"') return null
  i += 1
  let value = ''
  let end = -1
  for (let j = i; j < inner.length; j += 1) {
    const ch = inner[j]
    if (ch === '\\' && j + 1 < inner.length) {
      const esc = inner[j + 1]
      if (esc === 'n') value += '\n'
      else if (esc === '"') value += '"'
      else if (esc === '\\') value += '\\'
      else value += esc
      j += 1
      continue
    }
    if (ch === '"') {
      end = j + 1
      break
    }
    value += ch
  }
  if (end < 0) return null
  return { token: { key, value, raw: inner.slice(start, end) }, next: end }
}

function labelMatches(
  tokens: readonly LabelToken[],
  ref: string,
  mode: 'work' | 'personal',
): boolean {
  let job: string | undefined
  let lineRef: string | undefined
  let lineMode: string | undefined
  for (const token of tokens) {
    if (token.key === 'job') job = token.value
    else if (token.key === 'ref') lineRef = token.value
    else if (token.key === 'mode') lineMode = token.value
  }
  if (job !== 'pi-flow') return false
  if (lineRef !== ref) return false
  if (mode === 'work') return lineMode === 'work'
  return lineMode === undefined
}

/** Drop `#` comment lines and foreign lines, keep this group's lines with the
 *  injected `instance=""` pair stripped. A non-comment line that could belong
 *  to this group but cannot be PARSED fails the WHOLE read
 *  ({@link unparseableLine}) rather than being dropped — see P2-5 in
 *  {@link fetchGroupBody}. */
function filterGroupLines(
  dump: string,
  ref: string,
  mode: 'work' | 'personal',
): GroupBodyResult {
  const kept: string[] = []
  for (const line of dump.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue
    const open = line.indexOf('{')
    const close = line.lastIndexOf('}')
    const tokens =
      open >= 0 && close > open
        ? splitLabels(line.slice(open + 1, close))
        : null
    if (tokens === null) {
      // Unreadable: either it is provably not ours (drop it — the gateway
      // always labels a group's lines), or it might be ours and re-posting
      // without it would erase it. Never guess: fail the read.
      if (couldBelongToGroup(line, ref)) return unparseableLine(line)
      continue
    }
    if (!labelMatches(tokens, ref, mode)) continue
    const survivors = tokens.filter(
      (token) => !(token.key === 'instance' && token.value === ''),
    )
    const labels = survivors.map((token) => token.raw).join(',')
    kept.push(`${line.slice(0, open + 1)}${labels}${line.slice(close)}`)
  }
  if (kept.length === 0) return { ok: true, body: '' }
  return { ok: true, body: `${kept.join('\n')}\n` }
}

/** True when a line an exposition parser rejected could still be one of the
 *  lines this group owns, judged on RAW text (parsing is what failed):
 *  a `pi_flow*` metric name, or the gateway's re-forced `job="pi-flow"` /
 *  `ref="<ref>"` label pairs. Foreign runtime metrics (`go_goroutines 11`) and
 *  other jobs' broken lines are therefore NOT fatal to this read — measured on
 *  the live gateway, the dump holds dozens of lines this parser cannot read
 *  and that provably do not belong to any pi-flow group. */
function couldBelongToGroup(line: string, ref: string): boolean {
  if (line.trim().startsWith('pi_flow')) return true
  return line.includes('job="pi-flow"') || line.includes(`ref="${ref}"`)
}

/** The one P2-5 failure shape. The line is quoted (truncated: a dump line can
 *  carry a long escaped reason value) because the engine surfaces this string
 *  in a warning and an operator has to be able to see WHAT the gateway sent. */
function unparseableLine(line: string): GroupBodyResult {
  const snippet = line.length > 120 ? `${line.slice(0, 120)}…` : line
  return { ok: false, error: `unparseable dump line: ${snippet}` }
}
