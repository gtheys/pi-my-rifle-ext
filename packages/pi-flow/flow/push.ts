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
    return { ok: true, body: filterGroupLines(dump, ref, mode) }
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
 * malformed — a line we cannot parse is never a match, which keeps the
 * filter fail-closed (a partial line must not be re-POSTed).
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

/** Drop `#` comment lines and non-group lines, keep this group's lines with
 *  the injected `instance=""` pair stripped. */
function filterGroupLines(
  dump: string,
  ref: string,
  mode: 'work' | 'personal',
): string {
  const kept: string[] = []
  for (const line of dump.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed.startsWith('#')) continue
    const open = line.indexOf('{')
    const close = line.lastIndexOf('}')
    if (open < 0 || close <= open) continue
    const tokens = splitLabels(line.slice(open + 1, close))
    if (tokens === null) continue
    if (!labelMatches(tokens, ref, mode)) continue
    const survivors = tokens.filter(
      (token) => !(token.key === 'instance' && token.value === ''),
    )
    const labels = survivors.map((token) => token.raw).join(',')
    kept.push(`${line.slice(0, open + 1)}${labels}${line.slice(close)}`)
  }
  if (kept.length === 0) return ''
  return `${kept.join('\n')}\n`
}
